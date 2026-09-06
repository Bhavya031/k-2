import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";

import { loadConfig } from "../config.ts";
import type { IgnoredSenderRecorder, MessagingTransport } from "./phone-intake.ts";

const telegramApiBase = "https://api.telegram.org";
const defaultPollTimeoutSeconds = 30;
const defaultIntakeDirectory = "intake";

export type TelegramUpdateOffsetStore = Readonly<{
  read(): Promise<number | undefined>;
  write(offset: number): Promise<void>;
}>;

export type IntakeFolderWriter = Readonly<{
  write(input: Readonly<{ filename: string; bytes: Uint8Array }>): Promise<void>;
}>;

export type TelegramApi = Readonly<{
  getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<readonly unknown[]>;
  getFile(fileId: string): Promise<string>;
  download(filePath: string): Promise<Uint8Array>;
  sendMessage(recipientId: string, text: string): Promise<void>;
}>;

export type TelegramMessagingTransport = Pick<MessagingTransport, "send"> & Readonly<{
  pollOnce(): Promise<void>;
  run(): Promise<never>;
}>;

export type TelegramRetryPolicy = Readonly<{
  attempts: number;
  initialBackoffMilliseconds: number;
  maxBackoffMilliseconds: number;
}>;

export const defaultTelegramRetryPolicy: TelegramRetryPolicy = Object.freeze({
  attempts: 3,
  initialBackoffMilliseconds: 100,
  maxBackoffMilliseconds: 1_000,
});

const systemSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function validRetryPolicy(policy: TelegramRetryPolicy): void {
  if (!Number.isSafeInteger(policy.attempts) || policy.attempts < 1) throw new Error("Telegram retry attempts must be a positive safe integer");
  if (!Number.isSafeInteger(policy.initialBackoffMilliseconds) || policy.initialBackoffMilliseconds < 0) throw new Error("Telegram initial backoff must be a non-negative safe integer");
  if (!Number.isSafeInteger(policy.maxBackoffMilliseconds) || policy.maxBackoffMilliseconds < policy.initialBackoffMilliseconds) throw new Error("Telegram maximum backoff must be a safe integer no smaller than initial backoff");
}

async function retry<T>(work: () => Promise<T>, policy: TelegramRetryPolicy, sleep: (milliseconds: number) => Promise<void>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt === policy.attempts) break;
      const multiplier = 2 ** (attempt - 1);
      await sleep(Math.min(policy.maxBackoffMilliseconds, policy.initialBackoffMilliseconds * multiplier));
    }
  }
  throw lastError;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function senderId(message: Readonly<Record<string, unknown>>): string | undefined {
  const from = object(message.from);
  const id = from === undefined ? undefined : from.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function safeFilename(filename: string): string {
  const cleaned = basename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length === 0 || cleaned === "." || cleaned === ".." ? "upload" : cleaned;
}

function filenameFor(updateId: number, candidate: string, fallbackExtension: string): string {
  const safe = safeFilename(candidate);
  return extname(safe) === "" ? `telegram-${updateId}-${safe}${fallbackExtension}` : `telegram-${updateId}-${safe}`;
}

type AcceptedAttachment = Readonly<{ fileId: string; filename: string; acknowledgement: string }>;

function photoAttachment(updateId: number, message: Readonly<Record<string, unknown>>): AcceptedAttachment | undefined {
  const photos = message.photo;
  if (!Array.isArray(photos)) return undefined;
  const valid = photos.map(object).filter((photo): photo is Readonly<Record<string, unknown>> => photo !== undefined && string(photo.file_id) !== undefined);
  if (valid.length === 0) return undefined;
  const largest = valid.reduce((current, candidate) => {
    const currentSize = integer(current.file_size) ?? ((integer(current.width) ?? 0) * (integer(current.height) ?? 0));
    const candidateSize = integer(candidate.file_size) ?? ((integer(candidate.width) ?? 0) * (integer(candidate.height) ?? 0));
    return candidateSize > currentSize ? candidate : current;
  });
  return Object.freeze({ fileId: string(largest.file_id)!, filename: filenameFor(updateId, "photo.jpg", ".jpg"), acknowledgement: "Received photo." });
}

function documentAttachment(updateId: number, message: Readonly<Record<string, unknown>>): AcceptedAttachment | undefined {
  const document = object(message.document);
  if (document === undefined) return undefined;
  const fileId = string(document.file_id);
  const mediaType = string(document.mime_type)?.toLowerCase();
  if (fileId === undefined || mediaType === undefined || (mediaType !== "application/pdf" && !mediaType.startsWith("image/"))) return undefined;
  const extension = mediaType === "application/pdf" ? ".pdf" : mediaType === "image/jpeg" ? ".jpg" : mediaType === "image/png" ? ".png" : mediaType === "image/gif" ? ".gif" : mediaType === "image/webp" ? ".webp" : ".img";
  const sourceName = safeFilename(string(document.file_name) ?? "document");
  const stem = extname(sourceName) === "" ? sourceName : sourceName.slice(0, -extname(sourceName).length);
  return Object.freeze({ fileId, filename: `telegram-${updateId}-${stem}${extension}`, acknowledgement: mediaType === "application/pdf" ? "Received PDF document." : "Received image document." });
}

function updateId(update: unknown): number | undefined {
  const record = object(update);
  return record === undefined ? undefined : integer(record.update_id);
}

function messageFrom(update: unknown): Readonly<Record<string, unknown>> | undefined {
  const record = object(update);
  return record === undefined ? undefined : object(record.message);
}

class InMemoryOffsetStore implements TelegramUpdateOffsetStore {
  private offset: number | undefined;
  async read(): Promise<number | undefined> { return this.offset; }
  async write(offset: number): Promise<void> { this.offset = offset; }
}

/** Writes byte uploads into the same configurable `intake` folder polled by the intake watcher. */
export function createIntakeFolderWriter(directory = defaultIntakeDirectory): IntakeFolderWriter {
  return Object.freeze({
    async write(input): Promise<void> {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, safeFilename(input.filename)), input.bytes);
    },
  });
}

/**
 * Telegram's API client. The token is consumed only to construct runtime API
 * requests and is neither returned nor included in thrown error messages.
 */
function createTelegramApi(botToken: string, fetcher: typeof fetch = fetch): TelegramApi {
  async function api(method: string, parameters: Readonly<Record<string, unknown>>): Promise<unknown> {
    const response = await fetcher(`${telegramApiBase}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parameters),
    });
    if (!response.ok) throw new Error(`Telegram ${method} request failed`);
    const payload = object(await response.json());
    if (payload?.ok !== true) throw new Error(`Telegram ${method} request failed`);
    return payload.result;
  }

  return Object.freeze({
    async getUpdates(offset, timeoutSeconds): Promise<readonly unknown[]> {
      const result = await api("getUpdates", Object.freeze({ ...(offset === undefined ? {} : { offset }), timeout: timeoutSeconds, allowed_updates: ["message"] }));
      if (!Array.isArray(result)) throw new Error("Telegram getUpdates response was malformed");
      return result;
    },
    async getFile(fileId): Promise<string> {
      const result = object(await api("getFile", Object.freeze({ file_id: fileId })));
      const path = result === undefined ? undefined : string(result.file_path);
      if (path === undefined) throw new Error("Telegram getFile response was malformed");
      return path;
    },
    async download(filePath): Promise<Uint8Array> {
      const response = await fetcher(`${telegramApiBase}/file/bot${botToken}/${filePath}`);
      if (!response.ok) throw new Error("Telegram file download failed");
      return new Uint8Array(await response.arrayBuffer());
    },
    async sendMessage(recipientId, text): Promise<void> {
      await api("sendMessage", Object.freeze({ chat_id: recipientId, text }));
    },
  });
}

/**
 * Polls Telegram and deposits accepted uploads into the watched intake folder.
 * It deliberately does not attach `phone-intake` or call any pipeline/database
 * port: the folder watcher owns downstream processing.
 */
export function createTelegramMessagingTransport(options: Readonly<{
  allowedSenders: readonly string[];
  api: TelegramApi;
  intake: IntakeFolderWriter;
  ignoredSenders: IgnoredSenderRecorder;
  offsets?: TelegramUpdateOffsetStore;
  retryPolicy?: TelegramRetryPolicy;
  sleep?: (milliseconds: number) => Promise<void>;
}>): TelegramMessagingTransport {
  const allowedSenders = new Set(options.allowedSenders);
  const offsets = options.offsets ?? new InMemoryOffsetStore();
  const retryPolicy = options.retryPolicy ?? defaultTelegramRetryPolicy;
  const sleep = options.sleep ?? systemSleep;
  validRetryPolicy(retryPolicy);

  async function process(update: unknown): Promise<"advanced" | "retry"> {
    const id = updateId(update);
    if (id === undefined) return "advanced";
    const message = messageFrom(update);
    if (message === undefined) {
      await offsets.write(id + 1);
      return "advanced";
    }
    const sender = senderId(message);
    if (sender === undefined) {
      await offsets.write(id + 1);
      return "advanced";
    }
    if (!allowedSenders.has(sender)) {
      await options.ignoredSenders.recordIgnoredSender(sender, "not_allowed");
      await offsets.write(id + 1);
      return "advanced";
    }
    const attachment = photoAttachment(id, message) ?? documentAttachment(id, message);
    if (attachment === undefined) {
      await offsets.write(id + 1);
      return "advanced";
    }
    try {
      const path = await retry(() => options.api.getFile(attachment.fileId), retryPolicy, sleep);
      const bytes = await retry(() => options.api.download(path), retryPolicy, sleep);
      await options.intake.write(Object.freeze({ filename: attachment.filename, bytes }));
    } catch {
      return "retry";
    }
    await offsets.write(id + 1);
    try {
      await options.api.sendMessage(sender, attachment.acknowledgement);
    } catch {
      // The upload is already safely deposited and its update acknowledged by offset.
    }
    return "advanced";
  }

  async function pollOnce(): Promise<void> {
    const offset = await offsets.read();
    const updates = await retry(() => options.api.getUpdates(offset, defaultPollTimeoutSeconds), retryPolicy, sleep);
    for (const update of updates) {
      const id = updateId(update);
      if (offset !== undefined && id !== undefined && id < offset) continue;
      const result = await process(update);
      if (result === "retry") return;
    }
  }

  return Object.freeze({
    async send(message): Promise<void> { await options.api.sendMessage(message.recipientId, message.text); },
    pollOnce,
    async run(): Promise<never> {
      for (;;) {
        try {
          await pollOnce();
        } catch {
          // A failed poll is bounded-retried above; keep the long-poll loop alive.
        }
        await sleep(retryPolicy.initialBackoffMilliseconds);
      }
    },
  });
}


/** Records only a one-way sender identifier hash; no Telegram message content is retained. */
export function createHashedIgnoredSenderRecorder(path = "data/telegram-ignored-senders.log"): IgnoredSenderRecorder {
  return Object.freeze({
    async recordIgnoredSender(senderId: string, reason: "not_allowed"): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const senderHash = createHash("sha256").update(senderId).digest("hex");
      await appendFile(path, `${JSON.stringify({ senderHash, reason })}\n`);
    },
  });
}

/** Starts the production adapter using the one startup-parsed environment configuration. */
export function startTelegramMessagingTransport(options: Readonly<{
  intake?: IntakeFolderWriter;
  ignoredSenders: IgnoredSenderRecorder;
}>): TelegramMessagingTransport | undefined {
  const config = loadConfig();
  if (config.messaging === undefined) return undefined;
  return createTelegramMessagingTransport({
    allowedSenders: config.messaging.allowedSenders,
    api: createTelegramApi(config.messaging.botToken),
    intake: options.intake ?? createIntakeFolderWriter(),
    ignoredSenders: options.ignoredSenders,
  });
}
