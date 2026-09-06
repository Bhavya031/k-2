import { Database } from "bun:sqlite";

/**
 * Date-only values use the Gregorian `YYYY-MM-DD` format. They deliberately
 * contain no time or offset, so their meaning cannot vary by timezone.
 */
const dateOnly = (column: string): string => `
  typeof(${column}) = 'text'
  AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  AND date(${column}, '+0 days') = ${column}
`;

const STORE_SCHEMA_VERSION = 3;

/**
 * Applies the Stage 1 store schema. It is safe to invoke at every startup.
 * Foreign-key enforcement is a connection setting, so it is enabled here
 * rather than relying on a process-wide SQLite default.
 */
export function migrateStore(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON;");

  // Stage 6 reserved this table before matching had a persisted score/variance
  // shape. It never wrote match rows, so fail loudly rather than silently
  // inventing facts if an unexpected pre-Stage-7 row is encountered.
  const oldMatchColumns = database.query("PRAGMA table_info(accrual_matches)").all() as Array<{ name: string }>;
  const rebuildMatches = oldMatchColumns.length > 0 && !oldMatchColumns.some(({ name }) => name === "score_basis_points");
  if (rebuildMatches) {
    const oldMatchCount = database.query("SELECT count(*) AS count FROM accrual_matches").get() as { count: number };
    if (oldMatchCount.count !== 0) throw new Error("cannot migrate populated pre-Stage-7 accrual matches without their score and signed variance facts");
  }

  database.transaction(() => {
    if (rebuildMatches) database.exec("ALTER TABLE accrual_matches RENAME TO accrual_matches_stage6;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY CHECK (typeof(version) = 'integer'),
        applied_on TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS vendors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive'))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS source_documents (
        id TEXT PRIMARY KEY,
        vendor_id TEXT REFERENCES vendors(id),
        document_status TEXT NOT NULL CHECK (
          document_status IN ('received', 'classified', 'needs_review', 'rejected')
        ),
        -- Date-only, Gregorian YYYY-MM-DD; never a timestamp or local datetime.
        expires_on TEXT CHECK (expires_on IS NULL OR (${dateOnly("expires_on")}))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS document_pages (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES source_documents(id),
        page_number INTEGER NOT NULL CHECK (
          typeof(page_number) = 'integer' AND page_number > 0
        ),
        document_type TEXT,
        extraction_confidence_basis_points INTEGER CHECK (
          extraction_confidence_basis_points IS NULL OR (typeof(extraction_confidence_basis_points) = 'integer'
          AND extraction_confidence_basis_points BETWEEN 0 AND 10000)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ledger_lines (
        id TEXT PRIMARY KEY,
        vendor_id TEXT NOT NULL REFERENCES vendors(id),
        source_document_id TEXT REFERENCES source_documents(id),
        quantity_thousandths INTEGER NOT NULL CHECK (
          typeof(quantity_thousandths) = 'integer' AND quantity_thousandths >= 0
        ),
        amount_paise INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer'),
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'voided'))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        decision_prompt TEXT NOT NULL,
        evidence TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (typeof(priority) = 'integer'),
        created_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'decided')),
        claimed_by TEXT,
        claimed_at TEXT,
        decision_outcome TEXT CHECK (decision_outcome IN ('approve', 'correct', 'reject')),
        decided_by TEXT,
        decided_at TEXT,
        CHECK ((state = 'pending' AND claimed_by IS NULL AND claimed_at IS NULL AND decision_outcome IS NULL AND decided_by IS NULL AND decided_at IS NULL)
          OR (state = 'claimed' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND decision_outcome IS NULL AND decided_by IS NULL AND decided_at IS NULL)
          OR (state = 'decided' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND decision_outcome IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS review_values (
        review_item_id TEXT PRIMARY KEY REFERENCES review_items(id),
        value_kind TEXT NOT NULL CHECK (value_kind IN ('text', 'money_paise', 'quantity_thousandths', 'rate_basis_points')),
        value_text TEXT,
        value_integer INTEGER,
        provenance TEXT NOT NULL CHECK (provenance IN ('automated', 'human')),
        CHECK ((value_kind = 'text' AND value_text IS NOT NULL AND value_integer IS NULL)
          OR (value_kind = 'money_paise' AND value_text IS NULL AND typeof(value_integer) = 'integer')
          OR (value_kind = 'quantity_thousandths' AND value_text IS NULL AND typeof(value_integer) = 'integer' AND value_integer >= 0)
          OR (value_kind = 'rate_basis_points' AND value_text IS NULL AND typeof(value_integer) = 'integer' AND value_integer >= 0 AND value_integer <= 10000))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS review_decision_audit (
        id INTEGER PRIMARY KEY,
        review_item_id TEXT NOT NULL REFERENCES review_items(id),
        outcome TEXT NOT NULL CHECK (outcome IN ('approve', 'correct', 'reject')),
        corrected_value_kind TEXT CHECK (corrected_value_kind IN ('text', 'money_paise', 'quantity_thousandths', 'rate_basis_points')),
        corrected_value_text TEXT,
        corrected_value_integer INTEGER,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        CHECK ((outcome = 'correct' AND corrected_value_kind IS NOT NULL
          AND ((corrected_value_kind = 'text' AND corrected_value_text IS NOT NULL AND corrected_value_integer IS NULL)
            OR (corrected_value_kind = 'money_paise' AND corrected_value_text IS NULL AND typeof(corrected_value_integer) = 'integer')
            OR (corrected_value_kind = 'quantity_thousandths' AND corrected_value_text IS NULL AND typeof(corrected_value_integer) = 'integer' AND corrected_value_integer >= 0)
            OR (corrected_value_kind = 'rate_basis_points' AND corrected_value_text IS NULL AND typeof(corrected_value_integer) = 'integer' AND corrected_value_integer >= 0 AND corrected_value_integer <= 10000)))
          OR (outcome IN ('approve', 'reject') AND corrected_value_kind IS NULL AND corrected_value_text IS NULL AND corrected_value_integer IS NULL))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS review_items_claim_order
      ON review_items (state, priority DESC, created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS vendor_terms (
        vendor_id TEXT PRIMARY KEY REFERENCES vendors(id),
        rate_paise_per_tonne INTEGER NOT NULL CHECK (
          typeof(rate_paise_per_tonne) = 'integer' AND rate_paise_per_tonne >= 0
        ),
        effective_on TEXT NOT NULL CHECK (${dateOnly("effective_on")}),
        tds_section TEXT NOT NULL DEFAULT '194C' CHECK (length(trim(tds_section)) > 0),
        tds_rate_basis_points INTEGER NOT NULL DEFAULT 200 CHECK (
          typeof(tds_rate_basis_points) = 'integer' AND tds_rate_basis_points BETWEEN 0 AND 10000
        ),
        retention_basis_points INTEGER NOT NULL DEFAULT 500 CHECK (
          typeof(retention_basis_points) = 'integer' AND retention_basis_points BETWEEN 0 AND 10000
        ),
        tds_threshold_paise INTEGER NOT NULL DEFAULT 3000000 CHECK (
          typeof(tds_threshold_paise) = 'integer' AND tds_threshold_paise >= 0
        ),
        payment_days INTEGER NOT NULL CHECK (typeof(payment_days) = 'integer' AND payment_days >= 0),
        beneficiary_name TEXT,
        beneficiary_account_number TEXT,
        beneficiary_ifsc TEXT,
        beneficiary_bank_name TEXT,
        CHECK (beneficiary_name IS NULL OR length(trim(beneficiary_name)) > 0),
        CHECK (beneficiary_account_number IS NULL OR length(trim(beneficiary_account_number)) > 0),
        CHECK (beneficiary_ifsc IS NULL OR length(trim(beneficiary_ifsc)) > 0),
        CHECK (beneficiary_bank_name IS NULL OR length(trim(beneficiary_bank_name)) > 0)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS accruals (
        id TEXT PRIMARY KEY,
        source_document_id TEXT NOT NULL UNIQUE REFERENCES source_documents(id),
        vendor_id TEXT NOT NULL REFERENCES vendors(id),
        paper_reference TEXT NOT NULL CHECK (length(trim(paper_reference)) > 0),
        amount_paise INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer'),
        printed_amount_paise INTEGER CHECK (printed_amount_paise IS NULL OR typeof(printed_amount_paise) = 'integer'),
        quantity_thousandths INTEGER NOT NULL CHECK (
          typeof(quantity_thousandths) = 'integer' AND quantity_thousandths >= 0
        ),
        unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
        incurred_on TEXT NOT NULL CHECK (${dateOnly("incurred_on")}),
        status TEXT NOT NULL CHECK (status IN ('incurred', 'invoiced', 'settled', 'disputed', 'voided')),
        extraction_confidence_basis_points INTEGER NOT NULL CHECK (
          typeof(extraction_confidence_basis_points) = 'integer'
          AND extraction_confidence_basis_points BETWEEN 0 AND 10000
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS accrual_matches (
        id TEXT PRIMARY KEY,
        accrual_id TEXT NOT NULL UNIQUE REFERENCES accruals(id),
        invoice_source_document_id TEXT NOT NULL UNIQUE REFERENCES source_documents(id),
        score_basis_points INTEGER NOT NULL CHECK (
          typeof(score_basis_points) = 'integer' AND score_basis_points BETWEEN 0 AND 10000
        ),
        variance_paise INTEGER NOT NULL CHECK (typeof(variance_paise) = 'integer'),
        variance_cause TEXT CHECK (variance_cause IS NULL OR variance_cause IN (
          'quantity_variance', 'rate_variance', 'cause_unknown'
        )),
        status TEXT NOT NULL CHECK (status IN ('exact', 'within_tolerance', 'variance')),
        matched_on TEXT NOT NULL CHECK (${dateOnly("matched_on")})
      ) STRICT;

      CREATE TABLE IF NOT EXISTS payment_runs (
        id TEXT PRIMARY KEY,
        run_on TEXT NOT NULL CHECK (${dateOnly("run_on")} ),
        reference TEXT,
        notes TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'simulated', 'executed_simulated', 'failed', 'voided'))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS payment_run_lines (
        id TEXT PRIMARY KEY,
        payment_run_id TEXT NOT NULL REFERENCES payment_runs(id),
        accrual_id TEXT NOT NULL UNIQUE REFERENCES accruals(id),
        gross_paise INTEGER NOT NULL CHECK (typeof(gross_paise) = 'integer'),
        tds_paise INTEGER NOT NULL CHECK (typeof(tds_paise) = 'integer' AND tds_paise >= 0),
        retention_paise INTEGER NOT NULL CHECK (typeof(retention_paise) = 'integer' AND retention_paise >= 0),
        net_paise INTEGER NOT NULL CHECK (typeof(net_paise) = 'integer'),
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'held', 'executed_simulated', 'voided')),
        CHECK (net_paise = gross_paise - tds_paise - retention_paise)
      ) STRICT;

      INSERT OR IGNORE INTO schema_migrations (version, applied_on)
      VALUES (${STORE_SCHEMA_VERSION}, '2026-09-06');
    `);
    // Piece A rebuilds its Stage 6 placeholder before Piece B extends terms/runs.
    if (rebuildMatches) database.exec("DROP TABLE accrual_matches_stage6;");
    const columns = (table: string): Set<string> => new Set(
      (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name),
    );
    const vendorTermsColumns = columns("vendor_terms");
    if (!vendorTermsColumns.has("tds_threshold_paise")) {
      database.exec(`ALTER TABLE vendor_terms ADD COLUMN tds_threshold_paise INTEGER NOT NULL DEFAULT 3000000 CHECK (
        typeof(tds_threshold_paise) = 'integer' AND tds_threshold_paise >= 0
      )`);
    }
    const documentPageColumns = columns("document_pages");
    if (!documentPageColumns.has("document_type")) database.exec("ALTER TABLE document_pages ADD COLUMN document_type TEXT");
    if (!documentPageColumns.has("extraction_confidence_basis_points")) database.exec("ALTER TABLE document_pages ADD COLUMN extraction_confidence_basis_points INTEGER CHECK (extraction_confidence_basis_points IS NULL OR (typeof(extraction_confidence_basis_points) = 'integer' AND extraction_confidence_basis_points BETWEEN 0 AND 10000))");
    const paymentRunColumns = columns("payment_runs");
    if (!paymentRunColumns.has("reference")) database.exec("ALTER TABLE payment_runs ADD COLUMN reference TEXT");
    if (!paymentRunColumns.has("notes")) database.exec("ALTER TABLE payment_runs ADD COLUMN notes TEXT");
  })();
}
