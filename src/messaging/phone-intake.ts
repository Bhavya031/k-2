import type { AppConfig } from "../config.ts";
import type { DocumentType } from "../ingest/ingest.ts";

export type PhonePhoto = Readonly<{
  filename: string;
  mediaType: "image/jpeg" | "image/png";
  bytes: Uint8Array;
}>;

export type PhoneInbound =
  | Readonly<{ kind: "photo"; senderId: string; photo: PhonePhoto }>
  | Readonly<{ kind: "action"; senderId: string; action: PhoneAction }>
  | Readonly<{ kind: "text"; senderId: string; text: string }>;

export type PhoneAction = Readonly<{
  kind: "show_document" | "approve" | "reject" | "correct";
  reviewItemId: string;
  documentId: string;
  /** Correction is explicitly one field at a time. */
  field?: string;
}>;

export type PhoneMessage = Readonly<{
  recipientId: string;
  text: string;
  buttons?: readonly Readonly<{ id: string; label: string }>[];
}>;

/** Transport is deliberately passive: production binding owns any messaging SDK/network. */
export interface MessagingTransport {
  receive(handler: (message: PhoneInbound) => Promise<void>): void;
  send(message: PhoneMessage): Promise<void>;
}

/** Records rejected contacts without sending them a message. */
export interface IgnoredSenderRecorder {
  recordIgnoredSender(senderId: string, reason: "not_allowed"): Promise<void>;
}

/** Narrow adapter to the existing Stage 3 image ingestion/classification pipeline. */
export interface Stage3PhotoIngestionPort {
  ingestPhoto(input: Readonly<{ senderId: string; photo: PhonePhoto }>): Promise<Readonly<{
    documentId: string;
    documentType: DocumentType;
    duplicate: boolean;
  }>>;
}

export type QueueDocumentView = Readonly<{
  reviewItemId: string;
  documentId: string;
  documentType: string;
  values: Readonly<Record<string, string>>;
  reviewReason: string;
}>;

export type QueueDecision =
  | Readonly<{ kind: "approve"; reviewItemId: string; documentId: string; actorId: string }>
  | Readonly<{ kind: "reject"; reviewItemId: string; documentId: string; actorId: string }>
  | Readonly<{ kind: "correct"; reviewItemId: string; documentId: string; actorId: string; field: string; value: string }>;

/** Shared Stage 5 Piece A contract; this surface never owns queue state or decision persistence. */
export interface ReviewDecisionPort {
  readDocument(documentId: string): Promise<QueueDocumentView | undefined>;
  decide(decision: QueueDecision): Promise<void>;
}

export type PhoneIntakeCapability = Readonly<{ available: boolean }>;

type PendingCorrection = Readonly<{ reviewItemId: string; documentId: string; field: string }>;

function permitted(config: AppConfig, senderId: string): boolean {
  return config.messaging !== undefined && config.messaging.allowedSenders.includes(senderId);
}

function reviewMessage(recipientId: string, document: QueueDocumentView): PhoneMessage {
  const values = Object.entries(document.values).map(([field, value]) => `${field}: ${value}`).join("\n");
  const correctionFields = Object.keys(document.values);
  return Object.freeze({
    recipientId,
    text: `दस्तावेज़ / Document: ${document.documentType}\n${values}\nसमीक्षा कारण / Review reason: ${document.reviewReason}`,
    buttons: Object.freeze([
      { id: `approve:${document.reviewItemId}`, label: "मंज़ूर / Approve" },
      { id: `correct:${document.reviewItemId}:${correctionFields[0] ?? "value"}`, label: "सुधार / Correct" },
      { id: `reject:${document.reviewItemId}`, label: "अस्वीकार / Reject" },
    ]),
  });
}

/**
 * Attaches a fake-or-real transport only when a bot token was configured.
 * Corrections are intentionally a prompted, single-value text reply; a second
 * field requires another Correct action so a phone reply cannot alter a record wholesale.
 */
export function startPhoneIntake(options: Readonly<{
  config: AppConfig;
  transport: MessagingTransport;
  ingestion: Stage3PhotoIngestionPort;
  review: ReviewDecisionPort;
  ignoredSenders: IgnoredSenderRecorder;
}>): PhoneIntakeCapability {
  if (options.config.messaging === undefined) return Object.freeze({ available: false });

  const pendingCorrections = new Map<string, PendingCorrection>();
  options.transport.receive(async (message) => {
    if (!permitted(options.config, message.senderId)) {
      await options.ignoredSenders.recordIgnoredSender(message.senderId, "not_allowed");
      return;
    }

    if (message.kind === "photo") {
      const ingested = await options.ingestion.ingestPhoto({ senderId: message.senderId, photo: message.photo });
      const document = await options.review.readDocument(ingested.documentId);
      if (document !== undefined) await options.transport.send(reviewMessage(message.senderId, document));
      return;
    }

    if (message.kind === "action") {
      const { action } = message;
      if (action.kind === "show_document") {
        const document = await options.review.readDocument(action.documentId);
        if (document !== undefined) await options.transport.send(reviewMessage(message.senderId, document));
        return;
      }
      if (action.kind === "correct") {
        const document = await options.review.readDocument(action.documentId);
        const field = action.field;
        if (document === undefined || field === undefined || !(field in document.values)) return;
        pendingCorrections.set(message.senderId, { reviewItemId: action.reviewItemId, documentId: action.documentId, field });
        await options.transport.send(Object.freeze({ recipientId: message.senderId, text: `सुधार / Correction: reply with one replacement value for ${field}. एक ही मान भेजें।` }));
        return;
      }
      await options.review.decide(Object.freeze({ kind: action.kind, reviewItemId: action.reviewItemId, documentId: action.documentId, actorId: message.senderId }));
      await options.transport.send(Object.freeze({ recipientId: message.senderId, text: action.kind === "approve" ? "मंज़ूर / Approved" : "अस्वीकार / Rejected" }));
      return;
    }

    const pending = pendingCorrections.get(message.senderId);
    const value = message.text.trim();
    if (pending === undefined || value.length === 0) return;
    await options.review.decide(Object.freeze({ kind: "correct", ...pending, actorId: message.senderId, value }));
    pendingCorrections.delete(message.senderId);
    await options.transport.send(Object.freeze({ recipientId: message.senderId, text: "सुधार दर्ज / Correction recorded" }));
  });
  return Object.freeze({ available: true });
}
