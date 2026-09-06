import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

import { ReviewQueue } from "../review/queue.ts";

export const PAYMENT_HOLD_REVIEW_PRIORITY = 90;

export type PaymentInstruction = Readonly<{
  vendorId: string;
  beneficiaryName: string;
  accountNumber: string;
  ifsc: string;
  amountPaise: number;
  narration: string;
}>;

export type HeldVendor = Readonly<{ vendorId: string; reason: string; reviewItemId: string }>;
export type PaymentRunResult = Readonly<{ runId: string; reference: string; instructions: readonly PaymentInstruction[]; held: readonly HeldVendor[] }>;

type Candidate = Readonly<{
  accrual_id: string;
  vendor_id: string;
  gross_paise: number;
  tds_rate_basis_points: number;
  retention_basis_points: number;
  tds_threshold_paise: number;
  beneficiary_name: string | null;
  beneficiary_account_number: string | null;
  beneficiary_ifsc: string | null;
}>;
type Line = Readonly<{ accrualId: string; grossPaise: number; tdsPaise: number; retentionPaise: number; netPaise: number }>;

type StoredLine = Readonly<{
  vendor_id: string;
  beneficiary_name: string | null;
  beneficiary_account_number: string | null;
  beneficiary_ifsc: string | null;
  net_paise: number;
}>;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const nonEmpty = (value: string | null): value is string => value !== null && value.trim().length > 0;
const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new Error(`${field} must be a Gregorian YYYY-MM-DD date`);
}

/** Integer floor division of a non-negative paise amount and a basis-points rate. */
export function deductionPaise(grossPaise: number, basisPoints: number): number {
  if (!safeInteger(grossPaise) || grossPaise < 0) throw new Error("grossPaise must be a non-negative safe integer");
  if (!safeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) throw new Error("basisPoints must be between 0 and 10000");
  const result = (BigInt(grossPaise) * BigInt(basisPoints)) / 10_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("deduction exceeds safe integer range");
  return Number(result);
}

/** The only decimal conversion: this is the bank-file boundary. */
export function paiseToInr(amountPaise: number): string {
  if (!safeInteger(amountPaise) || amountPaise < 0) throw new Error("amountPaise must be a non-negative safe integer");
  const paise = BigInt(amountPaise);
  return `${paise / 100n}.${String(paise % 100n).padStart(2, "0")}`;
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function hashReference(runId: string, instructions: readonly PaymentInstruction[]): string {
  const ordered = instructions.map((instruction) => [
    instruction.vendorId, instruction.beneficiaryName, instruction.accountNumber, instruction.ifsc,
    instruction.amountPaise, instruction.narration,
  ]);
  return createHash("sha256").update(JSON.stringify([runId, ordered])).digest("hex");
}

function calculatedLine(candidate: Candidate): Line {
  // A nonpositive gross cannot produce a bank instruction. Its deductions remain zero and the vendor is held.
  if (candidate.gross_paise <= 0) return { accrualId: candidate.accrual_id, grossPaise: candidate.gross_paise, tdsPaise: 0, retentionPaise: 0, netPaise: candidate.gross_paise };
  const tdsPaise = candidate.gross_paise >= candidate.tds_threshold_paise
    ? deductionPaise(candidate.gross_paise, candidate.tds_rate_basis_points)
    : 0;
  const retentionPaise = deductionPaise(candidate.gross_paise, candidate.retention_basis_points);
  return { accrualId: candidate.accrual_id, grossPaise: candidate.gross_paise, tdsPaise, retentionPaise, netPaise: candidate.gross_paise - tdsPaise - retentionPaise };
}

/** Prepares a deterministic bank-upload draft only; it has no bank connection. */
export class PaymentRuns {
  constructor(private readonly database: Database, private readonly reviewQueue: ReviewQueue) {}

  create(run: Readonly<{ id: string; runOn: string; reviewedAt: string }>): PaymentRunResult {
    if (run.id.trim().length === 0) throw new Error("run id must not be empty");
    assertDateOnly(run.runOn, "runOn");
    const candidates = this.database.query(`
      SELECT a.id AS accrual_id, a.vendor_id, a.amount_paise AS gross_paise,
        t.tds_rate_basis_points, t.retention_basis_points, t.tds_threshold_paise,
        t.beneficiary_name, t.beneficiary_account_number, t.beneficiary_ifsc
      FROM accrual_matches m
      JOIN accruals a ON a.id = m.accrual_id
      JOIN vendor_terms t ON t.vendor_id = a.vendor_id
      LEFT JOIN payment_run_lines p ON p.accrual_id = a.id
      WHERE m.status IN ('exact', 'within_tolerance') AND p.id IS NULL AND a.status = 'invoiced'
      ORDER BY a.vendor_id ASC, a.id ASC
    `).all() as Candidate[];

    const grouped = new Map<string, Candidate[]>();
    for (const candidate of candidates) grouped.set(candidate.vendor_id, [...(grouped.get(candidate.vendor_id) ?? []), candidate]);
    const held: HeldVendor[] = [];
    const instructions: PaymentInstruction[] = [];
    const lines: Array<{ line: Line; status: "draft" | "held" }> = [];

    for (const [vendorId, vendorCandidates] of grouped) {
      const vendorLines = vendorCandidates.map(calculatedLine);
      const first = vendorCandidates[0]!;
      let reason: string | undefined;
      if (!nonEmpty(first.beneficiary_name)) reason = "missing beneficiary name from extracted vendor invoice data";
      else if (!nonEmpty(first.beneficiary_account_number)) reason = "missing beneficiary account number from extracted vendor invoice data";
      else if (!nonEmpty(first.beneficiary_ifsc)) reason = "missing beneficiary IFSC from extracted vendor invoice data";
      else if (vendorLines.some((line) => line.netPaise <= 0)) reason = "nonpositive net payable";
      const status = reason === undefined ? "draft" : "held";
      for (const line of vendorLines) lines.push({ line, status });
      if (reason !== undefined) {
        held.push({ vendorId, reason, reviewItemId: `payment-held:${run.id}:${vendorId}` });
        continue;
      }
      const amount = vendorLines.reduce((total, line) => total + BigInt(line.netPaise), 0n);
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("vendor payment total exceeds safe integer range");
      const amountPaise = Number(amount);
      instructions.push({ vendorId, beneficiaryName: first.beneficiary_name!, accountNumber: first.beneficiary_account_number!, ifsc: first.beneficiary_ifsc!, amountPaise, narration: `Payment run ${run.id} for ${vendorId}` });
    }
    const reference = hashReference(run.id, instructions);

    this.database.transaction(() => {
      this.database.run("INSERT INTO payment_runs (id, run_on, reference, status) VALUES (?, ?, ?, 'draft')", [run.id, run.runOn, reference]);
      for (const { line, status } of lines) this.database.run(
        "INSERT INTO payment_run_lines (id, payment_run_id, accrual_id, gross_paise, tds_paise, retention_paise, net_paise, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [`payment-line:${run.id}:${line.accrualId}`, run.id, line.accrualId, line.grossPaise, line.tdsPaise, line.retentionPaise, line.netPaise, status],
      );
      for (const item of held) this.enqueueHold(item, run.reviewedAt);
    })();
    return { runId: run.id, reference, instructions: Object.freeze(instructions), held: Object.freeze(held) };
  }

  renderCsv(runId: string): string {
    const rows = this.database.query(`
      SELECT a.vendor_id, t.beneficiary_name, t.beneficiary_account_number, t.beneficiary_ifsc, p.net_paise
      FROM payment_run_lines p JOIN accruals a ON a.id = p.accrual_id JOIN vendor_terms t ON t.vendor_id = a.vendor_id
      WHERE p.payment_run_id = ? ORDER BY a.vendor_id ASC, a.id ASC
    `).all(runId) as StoredLine[];
    if (rows.length === 0) throw new Error("payment run has no instructions to render");
    if (rows.some((row) => !nonEmpty(row.beneficiary_name) || !nonEmpty(row.beneficiary_account_number) || !nonEmpty(row.beneficiary_ifsc))) throw new Error("refusing bank file: an instruction is missing beneficiary bank detail");
    const totals = new Map<string, PaymentInstruction>();
    for (const row of rows) {
      if (row.net_paise <= 0) continue;
      const existing = totals.get(row.vendor_id);
      totals.set(row.vendor_id, existing === undefined
        ? { vendorId: row.vendor_id, beneficiaryName: row.beneficiary_name!, accountNumber: row.beneficiary_account_number!, ifsc: row.beneficiary_ifsc!, amountPaise: row.net_paise, narration: `Payment run ${runId} for ${row.vendor_id}` }
        : (() => {
          const total = BigInt(existing.amountPaise) + BigInt(row.net_paise);
          if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("vendor payment total exceeds safe integer range");
          return { ...existing, amountPaise: Number(total) };
        })());
    }
    const instructions = [...totals.values()];
    if (instructions.length === 0) throw new Error("payment run has no payable instructions to render");
    const header = "beneficiary_name,account_number,ifsc,amount_inr,narration,reference";
    const reference = hashReference(runId, instructions);
    return [header, ...instructions.map((item) => [item.beneficiaryName, item.accountNumber, item.ifsc, paiseToInr(item.amountPaise), item.narration, reference].map(csvField).join(","))].join("\n");
  }

  simulateExecution(runId: string, writeFile: (contents: string) => void): void {
    let csv: string;
    try {
      csv = this.renderCsv(runId);
      writeFile(csv);
    } catch (error) {
      this.database.run("UPDATE payment_runs SET status = 'failed' WHERE id = ?", [runId]);
      throw error;
    }
    this.database.transaction(() => {
      this.database.run("UPDATE payment_runs SET status = 'executed_simulated', notes = 'simulated execution; no bank connection' WHERE id = ?", [runId]);
      this.database.run("UPDATE payment_run_lines SET status = 'executed_simulated' WHERE payment_run_id = ? AND status = 'draft'", [runId]);
      this.database.run("UPDATE accruals SET status = 'settled' WHERE id IN (SELECT accrual_id FROM payment_run_lines WHERE payment_run_id = ? AND status = 'executed_simulated')", [runId]);
    })();
  }

  private enqueueHold(item: HeldVendor, createdAt: string): void {
    this.reviewQueue.enqueue({ id: item.reviewItemId, subjectId: item.vendorId, decisionPrompt: `Resolve payment hold: ${item.reason}.`, evidence: `Synthetic/simulated payment run hold for vendor ${item.vendorId}: ${item.reason}.`, priority: PAYMENT_HOLD_REVIEW_PRIORITY, createdAt });
  }
}
