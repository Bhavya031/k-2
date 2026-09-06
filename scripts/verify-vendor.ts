#!/usr/bin/env bun
/**
 * The sole product-code writer for vendor_payment_methods. This prepares
 * verification records only; it never contacts RazorpayX or sends a payout.
 */
import { Database } from "bun:sqlite";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import { migrateStore } from "../src/store/schema.ts";

const IFSC = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;

type Arguments = Readonly<{ databasePath: string; vendorId: string; operator: string; revoke: boolean }>;

function parseArguments(values: readonly string[]): Arguments {
  const revoke = values.includes("--revoke");
  const positional = values.filter((value) => value !== "--revoke");
  if (positional.length !== 3) throw new Error("usage: bun scripts/verify-vendor.ts <store.sqlite> <vendor-id> <operator-name> [--revoke]");
  const [databasePath, vendorId, operator] = positional;
  if (vendorId.trim().length === 0 || operator.trim().length === 0) throw new Error("vendor id and operator name must not be blank");
  return { databasePath: resolve(databasePath), vendorId, operator: operator.trim(), revoke };
}

function nonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be blank`);
  return trimmed;
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("refusing vendor verification: stdin must be an interactive TTY");
  const args = parseArguments(process.argv.slice(2));
  const database = new Database(args.databasePath);
  migrateStore(database);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const vendor = database.query<{ name: string }, [string]>("SELECT name FROM vendors WHERE id = ?").get(args.vendorId);
    if (vendor === null) throw new Error("refusing vendor verification: vendor does not exist");

    if (args.revoke) {
      const existing = database.query<{ beneficiary_name: string; account_number: string; ifsc: string }, [string]>(`
        SELECT beneficiary_name, account_number, ifsc FROM vendor_payment_methods
        WHERE vendor_id = ? AND status = 'active'
      `).get(args.vendorId);
      if (existing === null) throw new Error("refusing vendor revocation: no active verified payment method");
      console.log(`Vendor: ${vendor.name}\nBeneficiary: ${existing.beneficiary_name}\nAccount: ${existing.account_number}\nIFSC: ${existing.ifsc}`);
      if (await prompt.question("Retype the full account number to revoke this payment method: ") !== existing.account_number) {
        throw new Error("account confirmation did not match; no payment method was changed");
      }
      database.run("UPDATE vendor_payment_methods SET status = 'revoked', verified_by = ?, verified_at = ? WHERE vendor_id = ? AND status = 'active'", [args.operator, new Date().toISOString(), args.vendorId]);
      console.log("Verified payment method revoked. No payout was sent.");
      return;
    }

    const beneficiaryName = nonBlank(await prompt.question("Beneficiary name: "), "beneficiary name");
    const accountNumber = nonBlank(await prompt.question("Account number: "), "account number");
    const ifsc = nonBlank(await prompt.question("IFSC: "), "IFSC");
    if (!IFSC.test(ifsc)) throw new Error("IFSC must be four letters, 0, then six alphanumeric characters");
    const fundAccountId = (await prompt.question("RazorpayX fund account id (optional): ")).trim() || null;
    console.log(`Vendor: ${vendor.name}\nBeneficiary: ${beneficiaryName}\nAccount: ${accountNumber}\nIFSC: ${ifsc}`);
    if (await prompt.question("Retype the full account number to confirm: ") !== accountNumber) {
      throw new Error("account confirmation did not match; no payment method was changed");
    }
    database.run(`INSERT INTO vendor_payment_methods
      (id, vendor_id, beneficiary_name, account_number, ifsc, status, verified_by, verified_at, razorpayx_fund_account_id)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(vendor_id, account_number, ifsc) DO UPDATE SET
        beneficiary_name = excluded.beneficiary_name, status = 'active', verified_by = excluded.verified_by,
        verified_at = excluded.verified_at, razorpayx_fund_account_id = excluded.razorpayx_fund_account_id`,
    [crypto.randomUUID(), args.vendorId, beneficiaryName, accountNumber, ifsc, args.operator, new Date().toISOString(), fundAccountId]);
    console.log("Vendor payment method verified. No payout was sent.");
  } finally {
    prompt.close();
    database.close();
  }
}

if (import.meta.main) await main();
