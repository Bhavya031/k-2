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
  kind: "show_document" | "approve" | "reject" | "correct" | "show_payment_run" | "approve_payment_run" | "reject_payment_run";
  reviewItemId?: string;
  documentId?: string;
  paymentRunId?: string;
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

export type PaymentRunView = Readonly<{
  runId: string;
  reference: string;
  runOn: string;
  status: string;
  vendorCount: number;
  lineCount: number;
  grossPaise: bigint;
  tdsPaise: bigint;
  retentionPaise: bigint;
  netPaise: bigint;
  heldLineCount: number;
  firstHoldReason?: string;
}>;

export type PaymentRunReviewDecision = Readonly<{ kind: "approve" | "reject"; runId: string; actorId: string }>;

/** Payment-run decisions deliberately travel through the same review port as document decisions. */
export interface PaymentRunReviewPort {
  readPaymentRun(runId: string): Promise<PaymentRunView | undefined>;
  decidePaymentRun(decision: PaymentRunReviewDecision): Promise<"approved" | "rejected" | "all_held" | "already_decided">;
}

export type PhoneIntakeCapability = Readonly<{ available: boolean }>;

type PendingCorrection = Readonly<{ reviewItemId: string; documentId: string; field: string }>;

function permitted(config: AppConfig, senderId: string): boolean {
  return config.messaging !== undefined && config.messaging.allowedSenders.includes(senderId);
}

/** Formats integer paise for display only; all payment arithmetic remains integer-based. */
export function displayPaise(paise: bigint): string {
  const sign = paise < 0n ? "-" : "";
  const absolute = paise < 0n ? -paise : paise;
  const rupees = String(absolute / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₹${rupees}.${String(absolute % 100n).padStart(2, "0")}`;
}

function paymentRunMessage(recipientId: string, run: PaymentRunView): PhoneMessage {
  const hold = run.heldLineCount === 0 ? "कोई होल्ड लाइन नहीं / No held lines" : `होल्ड लाइनें / Held lines: ${run.heldLineCount}\nपहला होल्ड कारण / First hold reason: ${run.firstHoldReason ?? "payment hold requires review"}`;
  return Object.freeze({
    recipientId,
    text: `भुगतान रन / Payment run: ${run.reference}\nतारीख / Date: ${run.runOn}\nविक्रेता / Vendors: ${run.vendorCount}\nलाइनें / Lines: ${run.lineCount}\nसकल / Gross: ${displayPaise(run.grossPaise)}\nटीडीएस / TDS: ${displayPaise(run.tdsPaise)}\nरिटेंशन / Retention: ${displayPaise(run.retentionPaise)}\nशुद्ध देय / Net payable: ${displayPaise(run.netPaise)}\n${hold}\nमंज़ूरी केवल फ़ाइल तैयार करती है; कोई पैसा नहीं चलता; व्यक्ति भेजता है। / Approval prepares a file only; no money moves; a person sends it.`,
    buttons: Object.freeze([
      { id: `approve_payment_run:${run.runId}`, label: "मंज़ूर / Approve" },
      { id: `reject_payment_run:${run.runId}`, label: "अस्वीकार / Reject" },
    ]),
  });
}

/** Sends one prepared-run summary only to an allowlisted recipient. */
export async function sendPaymentRunApprovalMessage(options: Readonly<{
  config: AppConfig;
  transport: MessagingTransport;
  review: PaymentRunReviewPort;
  recipientId: string;
  paymentRunId: string;
}>): Promise<boolean> {
  if (!permitted(options.config, options.recipientId)) return false;
  const run = await options.review.readPaymentRun(options.paymentRunId);
  if (run === undefined) return false;
  await options.transport.send(paymentRunMessage(options.recipientId, run));
  return true;
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
  paymentRuns?: PaymentRunReviewPort;
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
      if (action.kind === "show_payment_run") {
        if (options.paymentRuns === undefined || action.paymentRunId === undefined) return;
        const run = await options.paymentRuns.readPaymentRun(action.paymentRunId);
        if (run !== undefined) await options.transport.send(paymentRunMessage(message.senderId, run));
        return;
      }
      if (action.kind === "approve_payment_run" || action.kind === "reject_payment_run") {
        if (options.paymentRuns === undefined || action.paymentRunId === undefined) return;
        const result = await options.paymentRuns.decidePaymentRun(Object.freeze({
          kind: action.kind === "approve_payment_run" ? "approve" : "reject", runId: action.paymentRunId, actorId: message.senderId,
        }));
        const text = result === "approved" ? "मंज़ूर / Approved — फ़ाइल तैयार होगी; कोई पैसा नहीं चलता। / A file will be prepared; no money moves."
          : result === "rejected" ? "अस्वीकार / Rejected"
          : result === "all_held" ? "मंज़ूरी रोकी गई / Approval refused: all lines are held."
          : "पहले ही निर्णय हो चुका / Already decided";
        await options.transport.send(Object.freeze({ recipientId: message.senderId, text }));
        return;
      }
      if (action.kind === "show_document") {
        if (action.documentId === undefined) return;
        const document = await options.review.readDocument(action.documentId);
        if (document !== undefined) await options.transport.send(reviewMessage(message.senderId, document));
        return;
      }
      if (action.kind === "correct") {
        if (action.documentId === undefined || action.reviewItemId === undefined) return;
        const document = await options.review.readDocument(action.documentId);
        const field = action.field;
        if (document === undefined || field === undefined || !(field in document.values)) return;
        pendingCorrections.set(message.senderId, { reviewItemId: action.reviewItemId, documentId: action.documentId, field });
        await options.transport.send(Object.freeze({ recipientId: message.senderId, text: `सुधार / Correction: reply with one replacement value for ${field}. एक ही मान भेजें।` }));
        return;
      }
      if (action.reviewItemId === undefined || action.documentId === undefined) return;
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
