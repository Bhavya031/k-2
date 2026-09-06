# K-2 demo and filming runbook (3:40)

## Recording guardrails

- Use a clean, authorised demonstration database and only synthetic/simulated
  paper. Label every generated invoice on screen as **SYNTHETIC / SIMULATED**.
- Never display credentials, tokens, account numbers, sender IDs, private
  documents, raw company data, terminal history containing sensitive values,
  or prompt logs.
- Record no real payment action. The close and every payment view must say:
  **"Payment preparation only. Human approval required. Bank execution is not
  product code."**
- Do not describe the Telegram adapter as live or deployed. Do not mention a
  RazorpayX integration, supplier email, or real supplier invoices: none is
  shipped here.

## Before rolling camera

1. Run `bun install`, `bun run typecheck`, and `bun run test` on the recording
   revision. Keep test output off-screen if it could reveal a local path.
2. Prepare a disposable database with approved synthetic/simulated records;
   do not seed it with private company paper or bank details.
3. If showing intake, place only a synthetic PDF/JPEG/PNG in a clean watcher
   folder and use the documented [watcher command](intake-watch.md). Wait for
   two polls before calling it ready.
4. If showing the optional adapter, use a non-production test bot and permitted
   test sender only. Start `bun run telegram-intake` and the watcher separately.
   If that environment is unavailable, omit this shot rather than implying it
   is live.
5. Pre-open the offline `report.html` and, if used, start `bun run ask-ledger`.
   Confirm it binds to the displayed `127.0.0.1` URL.
6. Rehearse a record that shows one unbilled liability, one variance awaiting
   review, and one draft payment line. Ensure any visible document says
   synthetic/simulated.

## Timed shot list

| Time | Visual cue | Narration / proof point |
|---|---|---|
| 0:00–0:18 | Tight paper-to-ledger opening; cut from a clearly synthetic delivery document to the unbilled report section. | "A delivery creates a cost before the supplier invoice arrives. K-2 makes that liability reviewable." |
| 0:18–0:40 | Show the stored document/page view and its source reference. | "The model reads paper; deterministic code computes the amount from quantity and the agreed rate." |
| 0:40–1:02 | Intake-folder shot: synthetic file pending, then processed after the stability check. | "Nothing is silently dropped: the watcher reports pending, processed, or failed work." |
| 1:02–1:25 | Ledger/report unbilled section; highlight quantity, rate-derived amount, and source paper. | "This is an accrued liability, not an invoice and not a payment." |
| 1:25–1:52 | Bring in a clearly labelled synthetic/simulated invoice; show the match result. | "Later invoices are matched deterministically within vendor and date gates." |
| 1:52–2:18 | Exception card with both document views; hold on the named cause. | "A quantity or rate disagreement is named and held for a person. It never auto-clears." |
| 2:18–2:45 | Accountant review queue: claim and record a synthetic decision. | "Review changes evidence through an audited queue. It does not change a payment or send money." |
| 2:45–3:08 | Draft payment-run section: gross, TDS, retention, net; show a held case if available. | "K-2 prepares a draft and holds missing details. A person reviews it before any bank action." |
| 3:08–3:26 | Offline report opened from disk, then optional localhost ask-ledger answer with row citations. | "The report is offline. The separate local question surface cites the stored rows behind each figure." |
| 3:26–3:40 | Return to the payment draft with the safety card full screen. | "Payment preparation only. Human approval remains required. Bank execution is not product code." |

## Optional synthetic invoice asset

Only for a disposable demonstration database that already has the required
synthetic accruals, render the three labelled invoice PDFs into an empty output
folder:

```sh
bun scripts/make-demo-invoices.ts --database ./demo.sqlite --out ./synthetic-invoices
```

This command requires suitable pre-existing accruals and writes **synthetic /
simulated** PDFs plus a manifest. It does not write to the supplied database,
send email, or prepare/execute a real payment. If prerequisites are absent, do
not substitute a real invoice; omit the invoice shot.

## End-to-end checklist

- [ ] Every on-screen paper and invoice is synthetic/simulated or otherwise
  authorised for the recording; no private document name or content appears.
- [ ] The intake shot shows a supported file and truthful pending/processed/
  failed status; it does not claim a real-time filesystem watcher.
- [ ] The accrual is shown as incurred/unbilled before a later invoice.
- [ ] The match shot shows a deterministic result, and the exception shot
  shows a human-held variance rather than an automatic resolution.
- [ ] The payment view is called a draft/preparation and shows deductions where
  applicable; no bank site, account number, payment button, or execution claim
  appears.
- [ ] Any Telegram shot is introduced as an optional configured adapter, not a
  deployed service; the watcher is shown as the downstream processor.
- [ ] The final safety card is legible for at least 10 seconds and uses the
  exact payment-preparation wording above.
