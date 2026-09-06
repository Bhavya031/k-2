import { Database } from "bun:sqlite";

export type SearchEntry = Readonly<{ value: string; label: string; section: string }>;
type Unbilled = Readonly<{ vendor: string; paperReference: string; incurredOn: string; quantityThousandths: number; unit: string; amountPaise: number }>;
type Review = Readonly<{ priority: number; decisionPrompt: string; evidence: string; subjectId: string }>;
type Variance = Readonly<{ vendor: string; paperReference: string; variancePaise: number; cause: string; decisionPrompt: string; evidence: string }>;
type PaymentLine = Readonly<{ vendor: string; accrualId: string; grossPaise: number; tdsPaise: number; retentionPaise: number; netPaise: number; status: string }>;
type PaymentRun = Readonly<{ id: string; runOn: string; reference: string | null; status: string; lines: readonly PaymentLine[] }>;
type Document = Readonly<{ id: string; vendor: string; type: string; pageCount: number; confidenceBasisPoints: number | null }>;

type ReportData = Readonly<{ unbilled: readonly Unbilled[]; reviews: readonly Review[]; variances: readonly Variance[]; paymentRuns: readonly PaymentRun[]; documents: readonly Document[]; searchIndex: readonly SearchEntry[] }>;

const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function integer(value: unknown, name: string): number {
  if (!safeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}

/** Renders integer paise exactly, without Number decimal arithmetic. */
export function inr(amountPaise: number): string {
  integer(amountPaise, "amountPaise");
  const value = BigInt(amountPaise);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const rupees = (absolute / 100n).toString();
  const grouped = rupees.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₹${grouped}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export function quantity(thousandths: number, unit: string): string {
  integer(thousandths, "quantityThousandths");
  const value = BigInt(thousandths);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 1000n}.${(absolute % 1000n).toString().padStart(3, "0")} ${unit}`;
}

export function searchExactFirst(index: readonly SearchEntry[], query: string): readonly SearchEntry[] {
  const needle = query.trim().toLocaleLowerCase("en-IN");
  if (needle.length === 0) return [];
  const exact = index.filter((entry) => entry.value.toLocaleLowerCase("en-IN") === needle);
  return exact.length > 0 ? exact : index.filter((entry) => entry.value.toLocaleLowerCase("en-IN").startsWith(needle));
}

function rows<T>(database: Database, sql: string): T[] { return database.query(sql).all() as T[]; }
function hasTable(database: Database, name: string): boolean { return database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null; }

function reportData(database: Database): ReportData {
  const unbilled = rows<Unbilled>(database, `
    SELECT v.name AS vendor, a.paper_reference AS paperReference, a.incurred_on AS incurredOn,
      a.quantity_thousandths AS quantityThousandths, a.unit, a.amount_paise AS amountPaise
    FROM accruals a JOIN vendors v ON v.id = a.vendor_id
    LEFT JOIN accrual_matches m ON m.accrual_id = a.id
    WHERE m.id IS NULL
    ORDER BY a.incurred_on ASC, v.name ASC, a.paper_reference ASC, a.id ASC
  `).map((row) => ({ ...row, quantityThousandths: integer(row.quantityThousandths, "quantityThousandths"), amountPaise: integer(row.amountPaise, "amountPaise") }));
  const reviews = rows<Review>(database, `
    SELECT priority, decision_prompt AS decisionPrompt, evidence, subject_id AS subjectId
    FROM review_items WHERE state = 'pending'
    ORDER BY priority DESC, created_at ASC, id ASC
  `).map((row) => ({ ...row, priority: integer(row.priority, "priority") }));
  const variances = rows<Variance>(database, `
    SELECT v.name AS vendor, a.paper_reference AS paperReference, m.variance_paise AS variancePaise,
      m.variance_cause AS cause, COALESCE(r.decision_prompt, 'Review this variance before it can clear.') AS decisionPrompt,
      COALESCE(r.evidence, 'Synthetic/simulated variance requires a human decision.') AS evidence
    FROM accrual_matches m JOIN accruals a ON a.id = m.accrual_id JOIN vendors v ON v.id = a.vendor_id
    LEFT JOIN review_items r ON r.id = 'invoice-variance:' || m.invoice_source_document_id
    WHERE m.status = 'variance'
    ORDER BY a.incurred_on ASC, v.name ASC, a.paper_reference ASC, m.id ASC
  `).map((row) => ({ ...row, variancePaise: integer(row.variancePaise, "variancePaise") }));
  const lineRows = rows<PaymentLine & { runId: string }>(database, `
    SELECT p.payment_run_id AS runId, v.name AS vendor, p.accrual_id AS accrualId, p.gross_paise AS grossPaise,
      p.tds_paise AS tdsPaise, p.retention_paise AS retentionPaise, p.net_paise AS netPaise, p.status
    FROM payment_run_lines p JOIN accruals a ON a.id = p.accrual_id JOIN vendors v ON v.id = a.vendor_id
    ORDER BY p.payment_run_id ASC, v.name ASC, p.accrual_id ASC
  `).map((row) => ({ ...row, grossPaise: integer(row.grossPaise, "grossPaise"), tdsPaise: integer(row.tdsPaise, "tdsPaise"), retentionPaise: integer(row.retentionPaise, "retentionPaise"), netPaise: integer(row.netPaise, "netPaise") }));
  const groupedLines = new Map<string, PaymentLine[]>();
  for (const { runId, ...line } of lineRows) groupedLines.set(runId, [...(groupedLines.get(runId) ?? []), line]);
  const paymentRuns = rows<Omit<PaymentRun, "lines">>(database, `SELECT id, run_on AS runOn, reference, status FROM payment_runs ORDER BY run_on ASC, id ASC`)
    .map((run) => ({ ...run, lines: groupedLines.get(run.id) ?? [] }));
  const documents = hasTable(database, "ingest_documents") && hasTable(database, "ingest_pages")
    ? rows<Document>(database, `
      SELECT d.source_sha256 AS id, 'Unassigned vendor' AS vendor,
        COALESCE((SELECT group_concat(document_type, ', ') FROM (SELECT DISTINCT p2.document_type FROM ingest_pages p2 WHERE p2.document_sha256 = d.source_sha256 ORDER BY p2.document_type)), 'unresolved') AS type,
        d.page_count AS pageCount, min(p.confidence_basis_points) AS confidenceBasisPoints
      FROM ingest_documents d LEFT JOIN ingest_pages p ON p.document_sha256 = d.source_sha256
      GROUP BY d.source_sha256, d.page_count ORDER BY d.source_sha256 ASC
    `).map((row) => ({ ...row, pageCount: integer(row.pageCount, "pageCount"), confidenceBasisPoints: row.confidenceBasisPoints === null ? null : integer(row.confidenceBasisPoints, "confidenceBasisPoints") }))
    : [];
  const index: SearchEntry[] = [];
  const add = (value: string, label: string, section: string): void => { if (value.trim().length > 0) index.push({ value, label, section }); };
  for (const entry of unbilled) { add(entry.paperReference, `Paper reference: ${entry.paperReference}`, "Unbilled"); add(entry.vendor, `Vendor: ${entry.vendor}`, "Unbilled"); add(String(entry.amountPaise), `Amount: ${inr(entry.amountPaise)}`, "Unbilled"); add(inr(entry.amountPaise), `Amount: ${inr(entry.amountPaise)}`, "Unbilled"); }
  for (const entry of documents) { add(entry.id, `Document: ${entry.id}`, "Documents"); add(entry.id, `Pass number: ${entry.id}`, "Documents"); add(entry.vendor, `Vendor: ${entry.vendor}`, "Documents"); }
  return { unbilled, reviews, variances, paymentRuns, documents, searchIndex: index.sort((left, right) => left.value.localeCompare(right.value, "en-IN") || left.label.localeCompare(right.label, "en-IN")) };
}

function embeddedJson(value: unknown): string { return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026"); }

/** Builds a complete offline report from persisted records only. */
export function buildReport(database: Database): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>K-2 ledger report</title><style>
:root{color-scheme:light;font-family:system-ui,sans-serif;background:#f4f1eb;color:#1d2730}body{margin:0;max-width:1200px;padding:24px;margin-inline:auto}header,section{background:#fff;border:1px solid #d8d2c8;border-radius:12px;padding:20px;margin-block:16px}h1,h2,h3,p{margin-top:0}h2{border-bottom:3px solid #24575a;padding-bottom:8px}.exception{border:3px solid #a62d2d;background:#fff5f3}.exception h2{border-color:#a62d2d;color:#7d1d1d}.notice{font-weight:700;color:#7d1d1d}.search{display:flex;gap:8px}.search input{flex:1;padding:10px;font-size:1rem}button{padding:10px 16px;background:#24575a;color:#fff;border:0;border-radius:6px}table{border-collapse:collapse;width:100%;margin-block:12px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.empty{color:#58636c;font-style:italic}.card{border-left:5px solid #a62d2d;padding:12px;margin:10px 0;background:#fff}.cause{font-weight:800;color:#7d1d1d}.run{border:1px solid #b9c8c8;padding:12px;margin:12px 0}.run h3{margin-bottom:4px}.meta{color:#58636c;font-size:.9rem}#search-results{margin-top:10px}ul{padding-left:20px}
</style></head><body><header><h1>K-2 ledger report</h1><p>Prepared from persisted synthetic/simulated records. This report prepares information only; it has no bank connection.</p><div class="search"><input id="search" aria-label="Search exact paper reference, vendor, amount, document id, or pass number" placeholder="Search exact paper reference, vendor, amount, document id, or pass number"><button id="search-button" type="button">Search</button></div><div id="search-results" aria-live="polite"></div></header><section id="unbilled"><h2>1. Unbilled</h2><div id="unbilled-content"></div></section><section id="exceptions" class="exception"><h2>2. Exceptions</h2><p class="notice">Human review required. Variances never auto-clear.</p><div id="exceptions-content"></div></section><section id="payments"><h2>3. Payments</h2><div id="payments-content"></div></section><section id="documents"><h2>4. Documents</h2><div id="documents-content"></div></section><script>const data=${embeddedJson(reportData(database))};const inr=n=>{const v=BigInt(n),s=v<0n?'-':'',a=v<0n?-v:v,r=(a/100n).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,','),p=(a%100n).toString().padStart(2,'0');return s+'₹'+r+'.'+p};const q=(n,u)=>{const v=BigInt(n),s=v<0n?'-':'',a=v<0n?-v:v;return s+(a/1000n)+'.'+(a%1000n).toString().padStart(3,'0')+' '+u};const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e};const table=(heads,body)=>{const t=document.createElement('table'),h=document.createElement('tr');heads.forEach(x=>h.append(text('th',x)));t.append(h);body.forEach(row=>{const tr=document.createElement('tr');row.forEach(([v,c])=>tr.append(text('td',v,c)));t.append(tr)});return t};const empty=(target,message)=>target.append(text('p',message,'empty'));const unbilled=document.querySelector('#unbilled-content');if(!data.unbilled.length)empty(unbilled,'No unbilled accruals.');else unbilled.append(table(['Vendor','Paper ref','Incurred','Quantity','Amount'],data.unbilled.map(x=>[[x.vendor],[x.paperReference],[x.incurredOn],[q(x.quantityThousandths,x.unit),'num'],[inr(x.amountPaise),'num']])));const exceptions=document.querySelector('#exceptions-content');if(!data.reviews.length&&!data.variances.length)empty(exceptions,'No pending review items or variance matches.');data.variances.forEach(x=>{const c=document.createElement('article');c.className='card';c.append(text('h3','Variance: '+x.paperReference+' · '+x.vendor));const phrase=x.cause==='quantity_variance'?'quantity read differently':x.cause==='rate_variance'?'rate that moved':'variance needs review';c.append(text('p',phrase+' · signed variance '+inr(x.variancePaise),'cause'));c.append(text('p','Decision: '+x.decisionPrompt));c.append(text('p','Evidence: '+x.evidence,'meta'));exceptions.append(c)});data.reviews.forEach(x=>{const c=document.createElement('article');c.className='card';c.append(text('h3','Pending review · priority '+x.priority));c.append(text('p','Decision: '+x.decisionPrompt));c.append(text('p','Evidence: '+x.evidence,'meta'));exceptions.append(c)});const payments=document.querySelector('#payments-content');if(!data.paymentRuns.length)empty(payments,'No payment runs.');data.paymentRuns.forEach(run=>{const d=document.createElement('article');d.className='run';d.append(text('h3','Run '+run.id+' · '+run.status));d.append(text('p','Run date: '+run.runOn+(run.reference?' · Reference: '+run.reference:'')+' · Execution is simulated; no bank connection.','meta'));if(!run.lines.length)empty(d,'No payment lines.');else d.append(table(['Vendor','Accrual','Gross','TDS','Retention','Net','Line status'],run.lines.map(x=>[[x.vendor],[x.accrualId],[inr(x.grossPaise),'num'],[inr(x.tdsPaise),'num'],[inr(x.retentionPaise),'num'],[inr(x.netPaise),'num'],[x.status]])));payments.append(d)});const documents=document.querySelector('#documents-content');if(!data.documents.length)empty(documents,'No source documents.');else documents.append(table(['Document','Vendor','Type','Pages','Extraction confidence'],data.documents.map(x=>[[x.id],[x.vendor],[x.type],[String(x.pageCount),'num'],[x.confidenceBasisPoints===null?'Not recorded':String(x.confidenceBasisPoints)+' bp','num']])));const search=()=>{const term=document.querySelector('#search').value.trim().toLocaleLowerCase('en-IN'),out=document.querySelector('#search-results');out.replaceChildren();if(!term)return;const exact=data.searchIndex.filter(x=>x.value.toLocaleLowerCase('en-IN')===term),matches=exact.length?exact:data.searchIndex.filter(x=>x.value.toLocaleLowerCase('en-IN').startsWith(term));if(!matches.length){out.append(text('p','No exact or prefix matches.','empty'));return}const list=document.createElement('ul');matches.forEach(x=>list.append(text('li',x.label+' · '+x.section)));out.append(list)};document.querySelector('#search-button').addEventListener('click',search);document.querySelector('#search').addEventListener('keydown',e=>{if(e.key==='Enter')search()});</script></body></html>`;
}
