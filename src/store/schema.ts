import { Database } from "bun:sqlite";

/**
 * Date-only values use the Gregorian `YYYY-MM-DD` format. They deliberately
 * contain no time or offset, so their meaning cannot vary by timezone.
 */
const DATE_ONLY = `
  typeof(expires_on) = 'text'
  AND expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  AND date(expires_on, '+0 days') = expires_on
`;

const STORE_SCHEMA_VERSION = 1;

/**
 * Applies the Stage 1 store schema. It is safe to invoke at every startup.
 * Foreign-key enforcement is a connection setting, so it is enabled here
 * rather than relying on a process-wide SQLite default.
 */
export function migrateStore(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON;");

  database.transaction(() => {
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
        expires_on TEXT CHECK (expires_on IS NULL OR (${DATE_ONLY}))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS document_pages (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES source_documents(id),
        page_number INTEGER NOT NULL CHECK (
          typeof(page_number) = 'integer' AND page_number > 0
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

      INSERT OR IGNORE INTO schema_migrations (version, applied_on)
      VALUES (${STORE_SCHEMA_VERSION}, '2026-09-06');
    `);
  })();
}
