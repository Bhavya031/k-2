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

      INSERT OR IGNORE INTO schema_migrations (version, applied_on)
      VALUES (${STORE_SCHEMA_VERSION}, '2026-09-06');
    `);
  })();
}
