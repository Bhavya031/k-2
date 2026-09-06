import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { migrateStore } from "../src/store/schema";

const databases: Database[] = [];

function openStore(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  migrateStore(database);
  return database;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function insertVendor(database: Database): void {
  database.run("INSERT INTO vendors (id, name, status) VALUES (?, ?, ?)", [
    "vendor-1",
    "Synthetic Quarry",
    "active",
  ]);
}

describe("Stage 1 SQLite store schema", () => {
  test("migration is idempotent and every created table is STRICT", () => {
    const database = openStore();

    migrateStore(database);

    expect(database.query("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({
      count: 1,
    });
    const tables = database
      .query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string; sql: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "accrual_matches",
      "accruals",
      "document_pages",
      "ledger_lines",
      "payment_run_lines",
      "payment_runs",
      "review_decision_audit",
      "review_items",
      "review_values",
      "schema_migrations",
      "source_documents",
      "vendor_terms",
      "vendors",
    ]);
    for (const { sql } of tables) expect(sql).toContain("STRICT");
  });

  test("foreign keys are enabled and reject a bad document reference", () => {
    const database = openStore();

    expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() =>
      database.run("INSERT INTO document_pages (id, document_id, page_number) VALUES (?, ?, ?)", [
        "page-1",
        "missing-document",
        1,
      ]),
    ).toThrow("FOREIGN KEY constraint failed");
  });

  test("the database rejects a REAL amount rather than coercing it", () => {
    const database = openStore();
    insertVendor(database);

    expect(() =>
      database.run(
        "INSERT INTO ledger_lines (id, vendor_id, quantity_thousandths, amount_paise, status) VALUES (?, ?, ?, ?, ?)",
        ["line-1", "vendor-1", 12420, 12.5, "draft"],
      ),
    ).toThrow("cannot store REAL value in INTEGER column ledger_lines.amount_paise");
  });

  test("quantities reject negative values", () => {
    const database = openStore();
    insertVendor(database);

    expect(() =>
      database.run(
        "INSERT INTO ledger_lines (id, vendor_id, quantity_thousandths, amount_paise, status) VALUES (?, ?, ?, ?, ?)",
        ["line-1", "vendor-1", -1, 1250, "draft"],
      ),
    ).toThrow("CHECK constraint failed");
  });

  test("status columns accept only their database-defined sets", () => {
    const database = openStore();

    expect(() =>
      database.run("INSERT INTO vendors (id, name, status) VALUES (?, ?, ?)", [
        "vendor-1",
        "Synthetic Quarry",
        "pending",
      ]),
    ).toThrow("CHECK constraint failed");
    expect(() =>
      database.run("INSERT INTO source_documents (id, document_status) VALUES (?, ?)", [
        "document-1",
        "archived",
      ]),
    ).toThrow("CHECK constraint failed");

    insertVendor(database);
    expect(() =>
      database.run(
        "INSERT INTO ledger_lines (id, vendor_id, quantity_thousandths, amount_paise, status) VALUES (?, ?, ?, ?, ?)",
        ["line-1", "vendor-1", 1, 1, "settled"],
      ),
    ).toThrow("CHECK constraint failed");
  });

  test("expiry dates are valid timezone-independent Gregorian date-only values", () => {
    const database = openStore();

    database.run(
      "INSERT INTO source_documents (id, document_status, expires_on) VALUES (?, ?, ?)",
      ["document-1", "received", "2028-02-29"],
    );
    expect(() =>
      database.run(
        "INSERT INTO source_documents (id, document_status, expires_on) VALUES (?, ?, ?)",
        ["document-2", "received", "2027-02-29"],
      ),
    ).toThrow("CHECK constraint failed");
    expect(() =>
      database.run(
        "INSERT INTO source_documents (id, document_status, expires_on) VALUES (?, ?, ?)",
        ["document-3", "received", "2028-02-29T00:00:00+05:30"],
      ),
    ).toThrow("CHECK constraint failed");
  });
});
