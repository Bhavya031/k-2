#!/usr/bin/env bun
/** Exports three clearly synthetic/simulated invoice PDFs from persisted accruals. */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

type Accrual = Readonly<{ id: string; vendor: string; paperReference: string; quantityThousandths: number; amountPaise: number; incurredOn: string; ratePaisePerTonne: number }>;
type DemoInvoice = Readonly<{ case: "exact" | "within_tolerance" | "rate_variance"; filename: string; invoiceNumber: string; vendor: string; accrualId: string; paperReference: string; quantityThousandths: number; amountPaise: number; invoiceDate: string }>;

const RATE_VENDOR_NAMES = ["JAY KHODIYAR METALS", "જય ખોડિયાર મેટલ"] as const;

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}
function paise(value: number): string {
  integer(value, "amountPaise");
  const sign = value < 0 ? "-" : ""; const absolute = BigInt(value < 0 ? -value : value);
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
function run(command: readonly string[]): Uint8Array {
  const result = Bun.spawnSync({ cmd: [...command], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  return result.stdout;
}
function parseArgs(args: readonly string[]): Readonly<{ database: string; out: string }> {
  const value = (name: string): string => { const i = args.indexOf(name); const result = i < 0 ? undefined : args[i + 1]; if (result === undefined || result.startsWith("--")) throw new Error(`Missing required option ${name}`); return result; };
  return Object.freeze({ database: value("--database"), out: value("--out") });
}
function invoiceText(invoice: DemoInvoice): string {
  return ["SYNTHETIC - SIMULATED DOCUMENT", "SUPPLIER INVOICE — DEMONSTRATION ONLY", "", `Invoice number: ${invoice.invoiceNumber}`, `Invoice date: ${invoice.invoiceDate}`, `Supplier: ${invoice.vendor}`, `Accrual reference: ${invoice.paperReference}`, `Accrual id: ${invoice.accrualId}`, `Quantity (thousandths): ${invoice.quantityThousandths}`, `Invoice amount: ₹ ${paise(invoice.amountPaise)}`, "", "This synthetic/simulated invoice prepares a demonstration only. A person sends any payment.", ""].join("\n");
}
function renderPdf(text: string, output: string): void {
  const temporary = join(tmpdir(), `k2-demo-invoice-${crypto.randomUUID()}.txt`);
  try { writeFileSync(temporary, text); writeFileSync(output, run(["cupsfilter", "-m", "application/pdf", temporary])); }
  finally { rmSync(temporary, { force: true }); }
  const prefix = join(tmpdir(), `k2-demo-invoice-check-${crypto.randomUUID()}`);
  try { run(["pdftoppm", "-png", "-r", "150", "-f", "1", "-l", "1", output, prefix]); const png = `${prefix}-1.png`; if (!existsSync(png) || Bun.file(png).size === 0) throw new Error(`Rendered PDF is blank: ${output}`); }
  finally { rmSync(`${prefix}-1.png`, { force: true }); }
}
function loadAccruals(databasePath: string): readonly Accrual[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    const all = database.query<Accrual, []>(`SELECT a.id, v.name AS vendor, a.paper_reference AS paperReference, a.quantity_thousandths AS quantityThousandths, a.amount_paise AS amountPaise, a.incurred_on AS incurredOn, t.rate_paise_per_tonne AS ratePaisePerTonne FROM accruals a JOIN vendors v ON v.id = a.vendor_id JOIN vendor_terms t ON t.vendor_id = a.vendor_id ORDER BY a.incurred_on, a.id`).all()
      .map((row) => ({ ...row, quantityThousandths: integer(row.quantityThousandths, "quantityThousandths"), amountPaise: integer(row.amountPaise, "amountPaise"), ratePaisePerTonne: integer(row.ratePaisePerTonne, "ratePaisePerTonne") }));
    if (all.length === 0) throw new Error("Cannot create demo invoices: no accruals exist in the database");
    return all;
  } finally { database.close(); }
}
/** Writes exactly three PDFs and a manifest; it never writes to the supplied database. */
export function makeDemoInvoices(databasePath: string, outputDirectory: string): readonly DemoInvoice[] {
  const accruals = loadAccruals(databasePath);
  const rate = accruals.find((accrual) => RATE_VENDOR_NAMES.includes(accrual.vendor as (typeof RATE_VENDOR_NAMES)[number]) && accrual.ratePaisePerTonne === 93400);
  if (rate === undefined) throw new Error("Cannot create rate-variance demo invoice: no 93400-paise JAY KHODIYAR METALS/જય ખોડિયાર મેટલ accrual exists");
  const nonRate = accruals.filter((accrual) => accrual.id !== rate.id);
  if (nonRate.length < 2) throw new Error("Cannot create demo invoices: need two additional accruals besides the rate-variance accrual");
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length !== 0) throw new Error("Demo invoice output directory must be empty");
  mkdirSync(outputDirectory, { recursive: true });
  const selected: readonly DemoInvoice[] = Object.freeze([
    { case: "exact", filename: "01-synthetic-exact-invoice.pdf", invoiceNumber: "SYN-EXACT-001", vendor: nonRate[0]!.vendor, accrualId: nonRate[0]!.id, paperReference: nonRate[0]!.paperReference, quantityThousandths: nonRate[0]!.quantityThousandths, amountPaise: nonRate[0]!.amountPaise, invoiceDate: nonRate[0]!.incurredOn },
    { case: "within_tolerance", filename: "02-synthetic-within-tolerance-invoice.pdf", invoiceNumber: "SYN-TOL-002", vendor: nonRate[1]!.vendor, accrualId: nonRate[1]!.id, paperReference: nonRate[1]!.paperReference, quantityThousandths: nonRate[1]!.quantityThousandths, amountPaise: nonRate[1]!.amountPaise + 50, invoiceDate: nonRate[1]!.incurredOn },
    { case: "rate_variance", filename: "03-synthetic-rate-variance-invoice.pdf", invoiceNumber: "SYN-RATE-003", vendor: rate.vendor, accrualId: rate.id, paperReference: rate.paperReference, quantityThousandths: rate.quantityThousandths, amountPaise: Number((BigInt(rate.quantityThousandths) * 99000n) / 1000n), invoiceDate: rate.incurredOn },
  ]);
  for (const invoice of selected) renderPdf(invoiceText(invoice), join(outputDirectory, invoice.filename));
  writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify({ synthetic: true, simulated: true, invoices: selected }, null, 2)}\n`);
  return selected;
}
if (import.meta.main) { const args = parseArgs(process.argv.slice(2)); makeDemoInvoices(args.database, args.out); }
