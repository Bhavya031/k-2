import { Database } from "bun:sqlite";

import { askStructured, type StructuredProvider, type StructuredSchema } from "../model/boundary.ts";
import { inr, quantity } from "../report/report.ts";

const dateMonth = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const dateOnly = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const integer = (value: unknown, label: string): number => {
  if (!safeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value;
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
const text = (value: unknown, label: string): string | undefined => typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export type LedgerPlan =
  | Readonly<{ kind: "quarry_last_month"; vendorName: string; month: string; template: "plain" | "brief" }>
  | Readonly<{ kind: "unpaid_past_terms"; asOf: string; template: "plain" | "brief" }>
  | Readonly<{ kind: "pass_reference"; reference: string; template: "plain" | "brief" }>
  | Readonly<{ kind: "review_queue"; template: "plain" | "brief" }>
  | Readonly<{ kind: "unbilled_file" }>
  | Readonly<{ kind: "vendor_statement_file"; vendorName: string }>
  | Readonly<{ kind: "payment_run_file"; paymentRunId: string }>;

/** Closed model-output contract. It accepts a safe plan only—never SQL or prose. */
export const ledgerPlanSchema: StructuredSchema<LedgerPlan> = {
  name: "ledger_query_plan",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["kind"], properties: {
      kind: { enum: ["quarry_last_month", "unpaid_past_terms", "pass_reference", "review_queue", "unbilled_file", "vendor_statement_file", "payment_run_file"] },
      vendorName: { type: "string" }, month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
      asOf: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$" },
      reference: { type: "string" }, paymentRunId: { type: "string" }, template: { enum: ["plain", "brief"] },
    },
  },
  validate(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
    const input = value as Record<string, unknown>; const kind = input.kind;
    const template = input.template;
    const phrasing = template === "plain" || template === "brief" ? template : undefined;
    const invalid = (message: string) => ({ ok: false as const, errors: [{ path: "$", message }] });
    if (kind === "quarry_last_month" && exactKeys(input, ["kind", "vendorName", "month", "template"])) {
      const vendorName = text(input.vendorName, "vendorName"); const month = text(input.month, "month");
      return vendorName !== undefined && month !== undefined && dateMonth.test(month) && phrasing !== undefined ? { ok: true, value: Object.freeze({ kind, vendorName, month, template: phrasing }) } : invalid("quarry_last_month requires vendorName, YYYY-MM month, and template");
    }
    if (kind === "unpaid_past_terms" && exactKeys(input, ["kind", "asOf", "template"])) {
      const asOf = text(input.asOf, "asOf"); return asOf !== undefined && dateOnly.test(asOf) && phrasing !== undefined ? { ok: true, value: Object.freeze({ kind, asOf, template: phrasing }) } : invalid("unpaid_past_terms requires date-only asOf and template");
    }
    if (kind === "pass_reference" && exactKeys(input, ["kind", "reference", "template"])) {
      const reference = text(input.reference, "reference"); return reference !== undefined && phrasing !== undefined ? { ok: true, value: Object.freeze({ kind, reference, template: phrasing }) } : invalid("pass_reference requires reference and template");
    }
    if (kind === "review_queue" && exactKeys(input, ["kind", "template"]) && phrasing !== undefined) return { ok: true, value: Object.freeze({ kind, template: phrasing }) };
    if (kind === "unbilled_file" && exactKeys(input, ["kind"])) return { ok: true, value: Object.freeze({ kind }) };
    if (kind === "vendor_statement_file" && exactKeys(input, ["kind", "vendorName"])) { const vendorName = text(input.vendorName, "vendorName"); return vendorName === undefined ? invalid("vendor_statement_file requires vendorName") : { ok: true, value: Object.freeze({ kind, vendorName }) }; }
    if (kind === "payment_run_file" && exactKeys(input, ["kind", "paymentRunId"])) { const paymentRunId = text(input.paymentRunId, "paymentRunId"); return paymentRunId === undefined ? invalid("payment_run_file requires paymentRunId") : { ok: true, value: Object.freeze({ kind, paymentRunId }) }; }
    return invalid("must be one closed ledger plan shape with no extra properties");
  },
};

export type Citation = Readonly<{ table: string; id: string; label: string }>;
export type ScreenAnswer = Readonly<{ kind: "screen"; heading: string; fragments: readonly string[]; citations: readonly Citation[] }>;
export type LedgerFile = Readonly<{ kind: "file"; filename: string; contentType: "text/csv; charset=utf-8"; content: string; citations: readonly Citation[] }>;
export type LedgerResponse = ScreenAnswer | LedgerFile;

const plannerPrompt = (question: string): string => `Choose exactly one ledger_query_plan for this question. You may select only its documented kind, filters, and template. Do not answer the question, write SQL, produce figures, citations, or file content. Question: ${question}`;

export async function planLedgerQuestion(provider: StructuredProvider, question: string): Promise<LedgerPlan> {
  const planned = await askStructured(provider, { prompt: plannerPrompt(question), schema: ledgerPlanSchema });
  if (!planned.ok) throw planned.error;
  return planned.value;
}

function csvCell(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function csv(rows: readonly (readonly string[])[]): string { return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`; }
function citations(...items: readonly Citation[]): readonly Citation[] { return Object.freeze(items); }
function source(accrualId: string, documentId: string, reference: string): readonly Citation[] { return citations({ table: "accruals", id: accrualId, label: `Accrual ${accrualId} (${reference})` }, { table: "source_documents", id: documentId, label: `Document ${documentId}` }); }

/** The provider may choose a fixed answer template, never supply answer prose. */
function phrased(template: "plain" | "brief", direct: string): string { return template === "brief" ? direct : `Ledger answer — ${direct}`; }

/** Executes only fixed parameterized read queries. The model never supplies SQL. */
export function executeLedgerPlan(database: Database, plan: LedgerPlan): LedgerResponse {
  if (plan.kind === "quarry_last_month") {
    const rows = database.query(`SELECT a.id, a.source_document_id AS documentId, a.paper_reference AS reference, a.quantity_thousandths AS quantity, a.unit, a.amount_paise AS amount
      FROM accruals a JOIN vendors v ON v.id = a.vendor_id WHERE lower(v.name) = lower(?) AND substr(a.incurred_on, 1, 7) = ? ORDER BY a.incurred_on, a.id`).all(plan.vendorName, plan.month) as Array<{ id: string; documentId: string; reference: string; quantity: unknown; unit: string; amount: unknown }>;
    const total = rows.reduce((sum, row) => sum + BigInt(integer(row.amount, "amount")), 0n);
    const totalNumber = Number(total); integer(totalNumber, "total amount");
    const details = rows.map((row) => `${row.reference}: ${quantity(integer(row.quantity, "quantity"), row.unit)} · ${inr(integer(row.amount, "amount"))}`);
    return Object.freeze({ kind: "screen", heading: phrased(plan.template, `Material from ${plan.vendorName} in ${plan.month}`), fragments: Object.freeze([`${rows.length} delivery record${rows.length === 1 ? "" : "s"}; total ${inr(totalNumber)}.`, ...details]), citations: Object.freeze(rows.flatMap((row) => source(row.id, row.documentId, row.reference))) });
  }
  if (plan.kind === "unpaid_past_terms") {
    const rows = database.query(`SELECT a.id, a.source_document_id AS documentId, a.paper_reference AS reference, v.name AS vendor, a.amount_paise AS amount, date(a.incurred_on, '+' || t.payment_days || ' days') AS dueOn
      FROM accruals a JOIN vendors v ON v.id = a.vendor_id JOIN vendor_terms t ON t.vendor_id = a.vendor_id
      LEFT JOIN payment_run_lines p ON p.accrual_id = a.id WHERE p.id IS NULL AND a.status IN ('incurred', 'invoiced', 'disputed') AND date(a.incurred_on, '+' || t.payment_days || ' days') < ? ORDER BY dueOn, v.name, a.id`).all(plan.asOf) as Array<{ id: string; documentId: string; reference: string; vendor: string; amount: unknown; dueOn: string }>;
    return Object.freeze({ kind: "screen", heading: phrased(plan.template, `Unpaid past terms as of ${plan.asOf}`), fragments: Object.freeze(rows.length === 0 ? ["No unpaid accruals are past their agreed terms."] : rows.map((row) => `${row.vendor} · ${row.reference} · due ${row.dueOn} · ${inr(integer(row.amount, "amount"))}`)), citations: Object.freeze(rows.flatMap((row) => source(row.id, row.documentId, row.reference))) });
  }
  if (plan.kind === "pass_reference") {
    const rows = database.query(`SELECT a.id, a.source_document_id AS documentId, a.paper_reference AS reference, v.name AS vendor, a.incurred_on AS incurredOn, a.amount_paise AS amount, a.status
      FROM accruals a JOIN vendors v ON v.id = a.vendor_id WHERE a.paper_reference = ? ORDER BY a.id`).all(plan.reference) as Array<{ id: string; documentId: string; reference: string; vendor: string; incurredOn: string; amount: unknown; status: string }>;
    return Object.freeze({ kind: "screen", heading: phrased(plan.template, `Pass reference ${plan.reference}`), fragments: Object.freeze(rows.length === 0 ? ["No accrual has that pass reference."] : rows.map((row) => `${row.vendor} · incurred ${row.incurredOn} · ${inr(integer(row.amount, "amount"))} · ${row.status}`)), citations: Object.freeze(rows.flatMap((row) => source(row.id, row.documentId, row.reference))) });
  }
  if (plan.kind === "review_queue") {
    const rows = database.query("SELECT id, subject_id AS subjectId, decision_prompt AS prompt, priority FROM review_items WHERE state = 'pending' ORDER BY priority DESC, created_at, id").all() as Array<{ id: string; subjectId: string; prompt: string; priority: unknown }>;
    return Object.freeze({ kind: "screen", heading: phrased(plan.template, "Pending review queue"), fragments: Object.freeze(rows.length === 0 ? ["No pending review items."] : rows.map((row) => `Priority ${integer(row.priority, "priority")} · ${row.prompt}`)), citations: Object.freeze(rows.map((row) => ({ table: "review_items", id: row.id, label: `Review ${row.id} (subject ${row.subjectId})` }))) });
  }
  if (plan.kind === "unbilled_file") {
    const rows = database.query(`SELECT a.id, a.source_document_id AS documentId, a.paper_reference AS reference, v.name AS vendor, a.incurred_on AS incurredOn, a.amount_paise AS amount
      FROM accruals a JOIN vendors v ON v.id = a.vendor_id LEFT JOIN accrual_matches m ON m.accrual_id = a.id WHERE m.id IS NULL ORDER BY a.incurred_on, a.id`).all() as Array<{ id: string; documentId: string; reference: string; vendor: string; incurredOn: string; amount: unknown }>;
    return Object.freeze({ kind: "file", filename: "unbilled-accruals.csv", contentType: "text/csv; charset=utf-8", content: csv([["Vendor", "Pass reference", "Incurred on", "Amount (paise)"], ...rows.map((row) => [row.vendor, row.reference, row.incurredOn, String(integer(row.amount, "amount"))])]), citations: Object.freeze(rows.flatMap((row) => source(row.id, row.documentId, row.reference))) });
  }
  if (plan.kind === "vendor_statement_file") {
    const rows = database.query(`SELECT a.id, a.source_document_id AS documentId, a.paper_reference AS reference, a.incurred_on AS incurredOn, a.amount_paise AS amount, a.status
      FROM accruals a JOIN vendors v ON v.id = a.vendor_id WHERE lower(v.name) = lower(?) ORDER BY a.incurred_on, a.id`).all(plan.vendorName) as Array<{ id: string; documentId: string; reference: string; incurredOn: string; amount: unknown; status: string }>;
    return Object.freeze({ kind: "file", filename: "vendor-statement.csv", contentType: "text/csv; charset=utf-8", content: csv([["Vendor", "Pass reference", "Incurred on", "Amount (paise)", "Status"], ...rows.map((row) => [plan.vendorName, row.reference, row.incurredOn, String(integer(row.amount, "amount")), row.status])]), citations: Object.freeze(rows.flatMap((row) => source(row.id, row.documentId, row.reference))) });
  }
  const run = database.query("SELECT id, run_on AS runOn, reference, status FROM payment_runs WHERE id = ?").get(plan.paymentRunId) as { id: string; runOn: string; reference: string | null; status: string } | null;
  const rows = database.query(`SELECT p.id, p.accrual_id AS accrualId, a.source_document_id AS documentId, a.paper_reference AS paperReference, v.name AS vendor, p.gross_paise AS gross, p.tds_paise AS tds, p.retention_paise AS retention, p.net_paise AS net, p.status
    FROM payment_run_lines p JOIN accruals a ON a.id = p.accrual_id JOIN vendors v ON v.id = a.vendor_id WHERE p.payment_run_id = ? ORDER BY p.id`).all(plan.paymentRunId) as Array<{ id: string; accrualId: string; documentId: string; paperReference: string; vendor: string; gross: unknown; tds: unknown; retention: unknown; net: unknown; status: string }>;
  return Object.freeze({ kind: "file", filename: "payment-run.csv", contentType: "text/csv; charset=utf-8", content: csv([["Payment run", "Run date", "Run status", "Vendor", "Pass reference", "Gross (paise)", "TDS (paise)", "Retention (paise)", "Net (paise)", "Line status"], ...rows.map((row) => [plan.paymentRunId, run?.runOn ?? "", run?.status ?? "not found", row.vendor, row.paperReference, String(integer(row.gross, "gross")), String(integer(row.tds, "tds")), String(integer(row.retention, "retention")), String(integer(row.net, "net")), row.status])]), citations: Object.freeze([...(run === null ? [] : [{ table: "payment_runs", id: run.id, label: `Payment run ${run.id}` }]), ...rows.flatMap((row) => [{ table: "payment_run_lines", id: row.id, label: `Payment line ${row.id}` }, { table: "accruals", id: row.accrualId, label: `Accrual ${row.accrualId} (${row.paperReference})` }, { table: "source_documents", id: row.documentId, label: `Document ${row.documentId}` }])]) });
}

export async function askLedger(database: Database, provider: StructuredProvider, question: string): Promise<LedgerResponse> {
  if (question.trim().length === 0) throw new Error("Question is required");
  return executeLedgerPlan(database, await planLedgerQuestion(provider, question));
}
