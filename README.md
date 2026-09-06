# K-2

K-2 turns delivery paper into a reviewable liability record, helps match later
supplier invoices, and prepares a payment-upload **draft**. It is designed for
the interval between a material delivery and the supplier invoice.

## Safety boundary

K-2 is **payment preparation only**. It prepares information and files; it does
**not** move money, connect to a bank, execute a bank upload, or contact a
government portal. Human review and approval remain required; a person, outside
this product, decides whether to send any bank file. Bank execution is not
product code.

Do not put credentials, account numbers, private source documents, or prompt
logs in this repository. The only non-synthetic PDFs committed here are public
tender notices; private company documents are not copied, named, or used as
fixtures. Any generated invoice used for a demonstration is explicitly
**synthetic/simulated** and is not a real supplier invoice.

## What is shipped

- PDF ingestion, page rendering/classification, document segmentation, typed
  extraction, and deterministic roll-up of stored paper.
- A review queue for uncertain or disagreeing evidence, including an
  accountant-only localhost review path.
- Integer-only accrual pricing from agreed vendor rates, deterministic invoice
  matching, and a **draft** payment run with TDS and retention calculations.
  Missing beneficiary details hold a vendor instead of producing an instruction.
- A self-contained offline HTML report, plus a localhost "ask the ledger"
  surface whose displayed figures come from stored rows and cite those rows.
- A polling intake watcher for PDFs, JPEGs, and PNGs. An optional Telegram
  long-poll adapter is implemented and documented; when configured, it writes
  allowed uploads to the watcher folder. It is not a claim that a bot is
  deployed or operating for any supplier.

## Demonstrated/test-mode behaviour

The automated suite uses invented fixtures. The synthetic invoice exporter
writes exactly three documents marked `SYNTHETIC - SIMULATED DOCUMENT` for a
demonstration database; it never writes to that database and does not produce
real supplier invoices. Payment-run execution states and report language that
refer to execution are simulated.

The pipeline can prepare a CSV-shaped bank-upload draft from reviewed records,
but this repository contains no bank integration, no RazorpayX integration,
and no code that sends a payment. Supplier email is not sent by K-2.

## Not shipped / do not claim in a demo

- Bank execution, beneficiary verification, payment approval workflows, or
  RazorpayX integration.
- Supplier-email delivery or a live supplier-facing portal.
- A deployed Telegram bot, real supplier intake, or real supplier invoices.
- Autonomous clearing of variances: a variance remains for human review.

## Quick start and verification

Use Bun 1.4.2. Copy the variable names from [`.env.example`](.env.example) to
your ignored runtime environment; leave optional messaging variables unset
unless using the adapter. `DATABASE_PATH` and `MODEL_PROVIDER` are required.
For `MODEL_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are
also required. For `MODEL_PROVIDER=local`, `LOCAL_MODEL_COMMAND` is optional.

```sh
bun install
bun run typecheck
bun run test
```

Process one PDF with the configured model provider and a writable database:

```sh
bun run batch -- --pdf ./example.pdf --payment-run-id draft-2026-09-06 --payment-run-on 2026-09-06 --matched-on 2026-09-06 --reviewed-at 2026-09-06T09:00:00.000Z
```

The command persists evidence and may prepare a draft run. It does not send a
payment. Run it only with authorised material; do not add private paper to the
repository.

Generate an offline report from an existing store:

```sh
bun run report ./persisted-store.sqlite ./report.html
```

Open `report.html` directly from disk. It has no server or network dependency.

## Operational surfaces

### Ask the ledger (localhost, read-only except review decisions)

With the required runtime configuration set, start the local surface:

```sh
bun run ask-ledger
```

Open the displayed `http://127.0.0.1:3000/` address. Questions are planned by
the configured provider, while every displayed figure is calculated from store
rows. The only write route is the audited accountant exception-review queue;
it never creates payments, marks anything paid, or changes model/ledger data.

### Folder intake watcher

The watcher polls `./intake`, moves completed originals to `./processed`, and
moves failures plus an error sidecar to `./failed`. It invokes the same batch
entrypoint after a file has been stable across two polls. See
[the intake watcher guide](docs/intake-watch.md) for supported formats, folder
options. Start it with the required batch metadata:

```sh
bun run watch-intake -- --payment-run-id draft-2026-09-06 --payment-run-on 2026-09-06 --matched-on 2026-09-06 --reviewed-at 2026-09-06T09:00:00.000Z
```

### Optional Telegram intake adapter

The adapter is available only when configured with runtime-only
`MESSAGING_BOT_TOKEN` and `MESSAGING_ALLOWED_SENDERS`. It long-polls Telegram,
accepts allowed photo/PDF/image uploads, and places bytes in `./intake`; run
the watcher separately. It does not start the pipeline itself, access the
database, send money, or imply a deployed bot. See
[the Telegram intake guide](docs/telegram-intake.md).

```sh
bun run telegram-intake
```

## Demo

Use only authorised synthetic/simulated data in a recording. The concise
[demo and filming runbook](docs/demo-runbook.md) provides the 3:40 timing,
shot cues, an honest end-to-end checklist, and the claims to avoid.

## Data rules

Money is stored as integer paise, quantity as integer thousandths of a unit,
and rates as basis points. The model reads paper into structured fields;
deterministic code computes amounts. A model does not invent ledger figures.
