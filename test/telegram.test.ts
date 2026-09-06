import { describe, expect, test } from "bun:test";

import {
  createTelegramMessagingTransport,
  safeFilename,
  type IntakeFolderWriter,
  type TelegramApi,
  type TelegramUpdateOffsetStore,
} from "../src/messaging/telegram.ts";
import type { IgnoredSenderRecorder } from "../src/messaging/phone-intake.ts";

class SyntheticTelegramApi implements TelegramApi {
  updates: readonly unknown[] = [];
  readonly offsets: Array<number | undefined> = [];
  readonly requestedFiles: string[] = [];
  readonly downloads: string[] = [];
  readonly sent: Array<{ recipientId: string; text: string }> = [];
  downloadFailures = 0;

  async getUpdates(offset: number | undefined): Promise<readonly unknown[]> {
    this.offsets.push(offset);
    return this.updates;
  }
  async getFile(fileId: string): Promise<string> {
    this.requestedFiles.push(fileId);
    return `synthetic/${fileId}`;
  }
  async download(path: string): Promise<Uint8Array> {
    this.downloads.push(path);
    if (this.downloadFailures > 0) {
      this.downloadFailures -= 1;
      throw new Error("synthetic download failure");
    }
    return new Uint8Array([4, 2, 7]);
  }
  async sendMessage(recipientId: string, text: string): Promise<void> { this.sent.push({ recipientId, text }); }
}

class SyntheticIntake implements IntakeFolderWriter {
  readonly received: Array<{ filename: string; bytes: Uint8Array }> = [];
  async write(input: Readonly<{ filename: string; bytes: Uint8Array }>): Promise<void> { this.received.push({ ...input }); }
}

class SyntheticIgnoredSenders implements IgnoredSenderRecorder {
  readonly records: Array<{ senderId: string; reason: "not_allowed" }> = [];
  async recordIgnoredSender(senderId: string, reason: "not_allowed"): Promise<void> { this.records.push({ senderId, reason }); }
}

class SyntheticOffsets implements TelegramUpdateOffsetStore {
  value: number | undefined;
  readonly written: number[] = [];
  async read(): Promise<number | undefined> { return this.value; }
  async write(offset: number): Promise<void> { this.value = offset; this.written.push(offset); }
}

function photoUpdate(id: number, senderId = "synthetic-allowed"): unknown {
  return { update_id: id, message: { from: { id: senderId }, photo: [
    { file_id: "small", width: 40, height: 40, file_size: 40 },
    { file_id: "largest", width: 400, height: 400, file_size: 400 },
  ] } };
}

function dependencies() {
  const api = new SyntheticTelegramApi();
  const intake = new SyntheticIntake();
  const ignoredSenders = new SyntheticIgnoredSenders();
  const offsets = new SyntheticOffsets();
  const sleeps: number[] = [];
  const transport = createTelegramMessagingTransport({
    allowedSenders: ["synthetic-allowed"], api, intake, ignoredSenders, offsets,
    retryPolicy: { attempts: 3, initialBackoffMilliseconds: 1, maxBackoffMilliseconds: 4 },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  return { api, intake, ignoredSenders, offsets, sleeps, transport };
}

describe("Telegram watched-folder messaging transport", () => {
  test("caps a synthetic 250-character label at 80 characters while retaining its extension", () => {
    const filename = safeFilename(`${"x".repeat(246)}.pdf`);

    expect(filename).toHaveLength(80);
    expect(filename).toEndWith(".pdf");
  });

  test("writes the largest allowed photo's synthetic bytes to intake and acknowledges it once", async () => {
    const d = dependencies();
    d.api.updates = [photoUpdate(7)];

    await d.transport.pollOnce();

    expect(d.api.requestedFiles).toEqual(["largest"]);
    expect(d.intake.received).toEqual([{ filename: "telegram-7-photo.jpg", bytes: new Uint8Array([4, 2, 7]) }]);
    expect(d.api.sent).toEqual([{ recipientId: "synthetic-allowed", text: "Received photo." }]);
    expect(d.offsets.written).toEqual([8]);
  });

  test("accepts a PDF document into intake and names the received type in one acknowledgement", async () => {
    const d = dependencies();
    d.api.updates = [{ update_id: 8, message: { from: { id: "synthetic-allowed" }, document: { file_id: "synthetic-pdf", file_name: "arrival.txt", mime_type: "application/pdf" } } }];

    await d.transport.pollOnce();

    expect(d.intake.received).toEqual([{ filename: "telegram-8-arrival.pdf", bytes: new Uint8Array([4, 2, 7]) }]);
    expect(d.api.sent).toEqual([{ recipientId: "synthetic-allowed", text: "Received PDF document." }]);
  });

  test("rejects a non-PDF, non-image document without writing or replying", async () => {
    const d = dependencies();
    d.api.updates = [{ update_id: 8, message: { from: { id: "synthetic-allowed" }, document: { file_id: "text-file", file_name: "synthetic.txt", mime_type: "text/plain" } } }];

    await d.transport.pollOnce();

    expect(d.intake.received).toEqual([]);
    expect(d.api.sent).toEqual([]);
    expect(d.offsets.written).toEqual([9]);
  });

  test("ignores and records an unauthorized sender without downloading, writing, or replying", async () => {
    const d = dependencies();
    d.api.updates = [photoUpdate(9, "synthetic-unallowed")];

    await d.transport.pollOnce();

    expect(d.ignoredSenders.records).toEqual([{ senderId: "synthetic-unallowed", reason: "not_allowed" }]);
    expect(d.api.requestedFiles).toEqual([]);
    expect(d.intake.received).toEqual([]);
    expect(d.api.sent).toEqual([]);
  });

  test("persists offset so redelivered updates are not processed again", async () => {
    const d = dependencies();
    d.api.updates = [photoUpdate(10)];
    await d.transport.pollOnce();
    d.api.updates = [photoUpdate(10)];
    await d.transport.pollOnce();

    expect(d.api.offsets).toEqual([undefined, 11]);
    expect(d.intake.received).toHaveLength(1);
    expect(d.api.sent).toHaveLength(1);
  });

  test("retries a failed download with bounded backoff and does not crash the poll loop", async () => {
    const d = dependencies();
    d.api.updates = [photoUpdate(11)];
    d.api.downloadFailures = 2;

    await expect(d.transport.pollOnce()).resolves.toBeUndefined();

    expect(d.api.downloads).toEqual(["synthetic/largest", "synthetic/largest", "synthetic/largest"]);
    expect(d.sleeps).toEqual([1, 2]);
    expect(d.intake.received).toHaveLength(1);
    expect(d.api.sent).toEqual([{ recipientId: "synthetic-allowed", text: "Received photo." }]);
  });
});
