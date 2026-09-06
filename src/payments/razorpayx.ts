import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

import type { RazorpayXConfiguration } from "../config.ts";
import type { PaymentInstruction, PaymentRunResult } from "./runs.ts";

export type RazorpayXPayoutRequest = Readonly<{
  account_number: string;
  fund_account_id: string;
  amount: number;
  currency: "INR";
  mode: "IMPS";
  purpose: "vendor bill";
  queue_if_low_balance: true;
  reference_id: string;
  narration: string;
  headers: Readonly<{ "X-Payout-Idempotency": string }>;
}>;

export type RazorpayXRefusal = Readonly<{ vendorId: string; reason: string }>;
export type RazorpayXPayoutBuildResult = Readonly<{
  accepted: readonly RazorpayXPayoutRequest[];
  refused: readonly RazorpayXRefusal[];
}>;

type VerifiedMethod = Readonly<{
  account_number: string;
  ifsc: string;
  razorpayx_fund_account_id: string | null;
}>;

type StoredInstruction = Readonly<{
  vendorId: string;
  accountNumber: string | null;
  ifsc: string | null;
  amountPaise: number;
}>;

const SAFE_NARRATION = /^[A-Za-z0-9 ]+$/;

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function refusal(vendorId: string, reason: string): RazorpayXRefusal {
  return frozen({ vendorId, reason });
}

/** Content-derived and deterministic; the later transport maps this to its HTTP header. */
export function razorpayXIdempotency(reference: string, vendorId: string, fundAccountId: string, amountPaise: number): string {
  return createHash("sha256")
    .update(JSON.stringify([reference, vendorId, fundAccountId, amountPaise]))
    .digest("hex");
}

function build(instructions: readonly PaymentInstruction[], reference: string, companyAccountNumber: string, database: Database): RazorpayXPayoutBuildResult {
  const accepted: RazorpayXPayoutRequest[] = [];
  const refused: RazorpayXRefusal[] = [];
  const activeMethod = database.query<VerifiedMethod, [string]>(`
    SELECT account_number, ifsc, razorpayx_fund_account_id
    FROM vendor_payment_methods WHERE vendor_id = ? AND status = 'active'
  `);

  for (const instruction of instructions) {
    if (!Number.isSafeInteger(instruction.amountPaise) || instruction.amountPaise < 0) {
      throw new Error("payment instruction amountPaise must be a non-negative safe integer");
    }
    if (!SAFE_NARRATION.test(instruction.narration)) {
      refused.push(refusal(instruction.vendorId, "narration contains unsafe characters"));
      continue;
    }
    const method = activeMethod.get(instruction.vendorId);
    if (method === null) {
      refused.push(refusal(instruction.vendorId, "no active verified payment method"));
      continue;
    }
    if (instruction.accountNumber !== method.account_number) {
      refused.push(refusal(instruction.vendorId, "instruction account number does not match active verified payment method"));
      continue;
    }
    if (instruction.ifsc !== method.ifsc) {
      refused.push(refusal(instruction.vendorId, "instruction IFSC does not match active verified payment method"));
      continue;
    }
    if (method.razorpayx_fund_account_id === null || method.razorpayx_fund_account_id.trim().length === 0) {
      refused.push(refusal(instruction.vendorId, "active verified payment method has no RazorpayX fund account id"));
      continue;
    }
    accepted.push(frozen({
      account_number: companyAccountNumber,
      fund_account_id: method.razorpayx_fund_account_id,
      amount: instruction.amountPaise,
      currency: "INR",
      mode: "IMPS",
      purpose: "vendor bill",
      queue_if_low_balance: true,
      reference_id: reference,
      narration: instruction.narration,
      headers: frozen({ "X-Payout-Idempotency": razorpayXIdempotency(reference, instruction.vendorId, method.razorpayx_fund_account_id, instruction.amountPaise) }),
    }));
  }
  return frozen({ accepted: Object.freeze(accepted), refused: Object.freeze(refused) });
}

/** Pure request preparation only: this module has no HTTP or network dependency. */
export function buildRazorpayXPayoutRequests(result: PaymentRunResult, configuration: RazorpayXConfiguration, database: Database): RazorpayXPayoutBuildResult {
  if (configuration.companyAccountNumber.trim().length === 0) throw new Error("RazorpayX company account number must not be blank");
  return build(result.instructions, result.reference, configuration.companyAccountNumber, database);
}

/**
 * Rebuilds prepared instructions from a persisted run's own snapshots. It
 * deliberately does not read vendor_terms, so unverified extracted details
 * cannot become a payout fallback.
 */
export function buildRazorpayXPayoutRequestsFromRun(database: Database, runId: string, configuration: RazorpayXConfiguration): RazorpayXPayoutBuildResult {
  if (configuration.companyAccountNumber.trim().length === 0) throw new Error("RazorpayX company account number must not be blank");
  const run = database.query<{ reference: string | null }, [string]>("SELECT reference FROM payment_runs WHERE id = ?").get(runId);
  if (run === null || run.reference === null || run.reference.trim().length === 0) throw new Error(`payment run ${runId} has no reference`);
  const rows = database.query<StoredInstruction, [string]>(`
    SELECT a.vendor_id AS vendorId, p.beneficiary_account_number AS accountNumber,
      p.beneficiary_ifsc AS ifsc, p.net_paise AS amountPaise
    FROM payment_run_lines p JOIN accruals a ON a.id = p.accrual_id
    WHERE p.payment_run_id = ? AND p.status = 'draft'
    ORDER BY a.vendor_id ASC, a.id ASC
  `).all(runId);
  const grouped = new Map<string, StoredInstruction>();
  for (const row of rows) {
    if (row.accountNumber === null || row.ifsc === null) continue;
    const prior = grouped.get(row.vendorId);
    if (prior === undefined) grouped.set(row.vendorId, row);
    else {
      const total = BigInt(prior.amountPaise) + BigInt(row.amountPaise);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("payment run vendor total exceeds safe integer range");
      grouped.set(row.vendorId, { ...prior, amountPaise: Number(total) });
    }
  }
  const instructions: PaymentInstruction[] = [];
  const refused: RazorpayXRefusal[] = [];
  for (const row of grouped.values()) {
    instructions.push({ vendorId: row.vendorId, beneficiaryName: "verified separately", accountNumber: row.accountNumber!, ifsc: row.ifsc!, amountPaise: row.amountPaise, narration: `Payment run ${runId} for ${row.vendorId}` });
  }
  for (const row of rows) if (row.accountNumber === null || row.ifsc === null) refused.push(refusal(row.vendorId, "payment run has no verified-method comparison snapshot"));
  const built = build(instructions, run.reference, configuration.companyAccountNumber, database);
  return frozen({ accepted: built.accepted, refused: Object.freeze([...refused, ...built.refused]) });
}
