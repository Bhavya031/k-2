import { describe, expect, test } from "bun:test";

import { pdfAttachments, safeName } from "../scripts/gmail-intake.ts";

describe("gmail intake attachment discovery", () => {
  test("finds PDF parts anywhere in a nested MIME tree", () => {
    const attachments = pdfAttachments({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", filename: "" },
        { mimeType: "multipart/related", parts: [{ mimeType: "application/pdf", filename: "challan.pdf", body: { attachmentId: "att-1" } }] },
        { mimeType: "application/octet-stream", filename: "pass.PDF", body: { attachmentId: "att-2" } },
      ],
    });
    expect(attachments.map((attachment) => attachment.attachmentId)).toEqual(["att-1", "att-2"]);
  });

  test("ignores images and any part carrying no attachment identifier", () => {
    expect(pdfAttachments({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "image/png", filename: "photo.png", body: { attachmentId: "att-3" } },
        { mimeType: "application/pdf", filename: "inline.pdf" },
      ],
    })).toEqual([]);
  });

  test("returns nothing for a message with no payload", () => {
    expect(pdfAttachments(undefined)).toEqual([]);
  });
});

describe("gmail intake download naming", () => {
  test("keeps the message identifier and index so two attachments never collide", () => {
    expect(safeName("abc123", 0, "challan.pdf")).toBe("gmail-abc123-0-challan.pdf");
    expect(safeName("abc123", 1, "challan.pdf")).toBe("gmail-abc123-1-challan.pdf");
  });

  test("strips path separators and other unsafe characters from the printed filename", () => {
    expect(safeName("m", 0, "../../etc/passwd.pdf")).toBe("gmail-m-0-etc_passwd.pdf");
    expect(safeName("m", 0, "जय खोडियार.pdf")).toBe("gmail-m-0-attachment.pdf");
  });

  test("appends the extension when the sender omitted it", () => {
    expect(safeName("m", 2, "scan")).toBe("gmail-m-2-scan.pdf");
  });
});
