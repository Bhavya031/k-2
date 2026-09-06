#!/usr/bin/env bun
/**
 * Gmail intake poller.
 *
 * Polls one Gmail label for unread messages carrying PDF attachments and drops
 * each attachment into the watcher's intake folder.  It reads mail and writes
 * files; it never books a record, never touches the ledger and never moves
 * money.  The production batch is started by `bun run watch-intake`, which
 * owns that folder.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Attachment = Readonly<{ filename: string; attachmentId: string }>;
type MessagePart = Readonly<{ mimeType?: string; filename?: string; body?: { attachmentId?: string }; parts?: readonly MessagePart[] }>;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? (process.argv[index + 1] as string) : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`missing ${name}`);
  return value;
}

/** Exchanges the long-lived refresh token for a short-lived access token. */
export async function accessToken(): Promise<string> {
  const override = process.env.GMAIL_ACCESS_TOKEN;
  if (override !== undefined && override.trim() !== "") return override;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required("CLIENT_ID"),
      client_secret: required("CLIENT_SECRET"),
      refresh_token: required("REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const payload = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
  // The credential values themselves are never echoed, only Google's error name.
  if (!response.ok || payload.access_token === undefined) {
    throw new Error(`token refresh failed: ${payload.error ?? response.status} ${payload.error_description ?? ""}`.trim());
  }
  return payload.access_token;
}

/** Walks the MIME tree and returns every PDF attachment it carries. */
export function pdfAttachments(part: MessagePart | undefined): readonly Attachment[] {
  if (part === undefined) return [];
  const nested = (part.parts ?? []).flatMap((child) => pdfAttachments(child));
  const filename = part.filename ?? "";
  const isPdf = part.mimeType === "application/pdf" || /\.pdf$/i.test(filename);
  const attachmentId = part.body?.attachmentId;
  if (!isPdf || attachmentId === undefined) return nested;
  return [...nested, Object.freeze({ filename: filename === "" ? "attachment.pdf" : filename, attachmentId })];
}

/** Keeps a downloaded name recognisable, unique and safe as a path segment. */
export function safeName(messageId: string, index: number, filename: string): string {
  // A sender controls this string, so nothing of it survives that could climb a
  // directory, hide the file, or leave the intake folder.
  const stem = filename.replace(/\.pdf$/i, "");
  const cleaned = stem.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^[._-]+/, "").slice(-60).replace(/[._-]+$/, "");
  return `gmail-${messageId}-${index}-${cleaned === "" ? "attachment" : cleaned}.pdf`;
}

function readState(path: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { handled?: readonly string[] };
    return new Set(parsed.handled ?? []);
  } catch {
    return new Set();
  }
}

async function json(url: string, token: string): Promise<any> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${url.replace(GMAIL, "gmail")} returned ${response.status}`);
  return await response.json();
}

async function poll(token: string, label: string, intakeDir: string, statePath: string, markRead: boolean): Promise<void> {
  const handled = readState(statePath);
  const query = encodeURIComponent(`label:${label} is:unread has:attachment`);
  const listed = (await json(`${GMAIL}/messages?q=${query}&maxResults=25`, token)) as { messages?: readonly { id: string }[] };
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const { id } of listed.messages ?? []) {
    if (handled.has(id)) { skipped.push(id); continue; }
    const message = (await json(`${GMAIL}/messages/${id}?format=full`, token)) as { payload?: MessagePart };
    const attachments = pdfAttachments(message.payload);
    if (attachments.length === 0) { skipped.push(id); continue; }
    for (const [index, attachment] of attachments.entries()) {
      const body = (await json(`${GMAIL}/messages/${id}/attachments/${attachment.attachmentId}`, token)) as { data?: string };
      if (body.data === undefined) { skipped.push(id); continue; }
      const bytes = Buffer.from(body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      const name = safeName(id, index, attachment.filename);
      writeFileSync(join(intakeDir, name), bytes);
      saved.push(name);
    }
    handled.add(id);
    if (markRead) {
      await fetch(`${GMAIL}/messages/${id}/modify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
      });
    }
  }
  writeFileSync(statePath, JSON.stringify({ handled: [...handled] }, null, 2));
  // One JSON line per poll, so nothing is ever reported as done while pending.
  console.log(JSON.stringify({ at: new Date().toISOString(), label, saved, skipped }));
}

if (import.meta.main) {
  const label = argument("label", "k2-bills");
  const intakeDir = argument("intake-dir", "./intake");
  const statePath = argument("state", "./.gmail-intake-state.json");
  const pollMs = Number.parseInt(argument("poll-ms", "15000"), 10);
  if (!Number.isInteger(pollMs) || pollMs <= 0) throw new Error("--poll-ms must be a positive integer");
  mkdirSync(intakeDir, { recursive: true });
  const token = await accessToken();
  await poll(token, label, intakeDir, statePath, flag("mark-read"));
  if (!flag("once")) {
    // A fresh access token per cycle: the short-lived one expires in an hour.
    setInterval(() => { void accessToken().then((next) => poll(next, label, intakeDir, statePath, flag("mark-read"))).catch((error: unknown) => console.error(String(error))); }, pollMs);
  }
}
