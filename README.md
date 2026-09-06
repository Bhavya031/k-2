# K-2

**An autonomous office of the CFO for a civil contractor who has never had one.**

Built for Syndicate by Maximor — Track 2, Autonomous Office of the CFO.

---

## The problem, precisely

A civil contracting company in Gujarat, India. Forty to fifty suppliers, almost
all on credit. There is no purchase order system and there never has been.

A cost begins its life as paper a truck driver carries: a royalty pass proving
the material was legally mined, or a delivery challan from the quarry. The
supplier's invoice arrives about three weeks later. Payment goes out about
three weeks after that.

For those three weeks, that money is invisible. Material is on site, the
liability is real, and nothing in the company knows about it. At month end the
owner is guessing what he owes.

K-2 closes that gap. It reads the paper the day it arrives, books the accrual
immediately, matches the supplier's invoice against it when it turns up, and
prepares the payment run — stopping at the bank's door, where a human takes
over.

---

## The safety boundary

K-2 is **payment preparation only**. It prepares information and files. It does
not move money, connect to a bank, execute a bank upload, or contact a
government portal. A person, outside this product, decides whether to send any
bank file. Bank execution is not product code.

Autonomous clearing of variances is deliberately not shipped: a disagreement
between two pieces of paper is named and held for a human. It never auto-clears.

No credentials, account numbers, private source documents or prompt logs belong
in this repository. The only non-synthetic PDFs committed here are public tender
notices. Any generated invoice used in a demonstration is explicitly marked
**SYNTHETIC / SIMULATED** and is not a real supplier invoice.

---

## What it actually does

```
paper scan
    │
    ▼  render → classify → segment into documents
 ingest ─────────────────────────────────────────► every page stored, nothing dropped
    │
    ▼  vision model reads printed fields only
extract
    │
    ▼  deterministic arithmetic — no model touches a number
 ledger ─────────────────────────────────────────► accrual booked
    │
    ├──► anything uncertain ──► review queue ──► a human decides
    │
    ▼  supplier invoice arrives weeks later
 match ──────────────────────────────────────────► invoice vs. accrual
    │
    ▼  194C TDS, retention withheld
payment run ─────────────────────────────────────► a draft file. A person sends it.
```

Ten stages shipped:

| # | Stage | What it gives you |
|---|---|---|
| 1 | Foundation | Typed money/quantity/provenance, STRICT SQLite, config-once-at-startup |
| 2 | Model boundary | One retry, only on schema-validation failure, only here |
| 3 | Ingest and classify | Page render, hashing, duplicate guard, per-page document type |
| 4 | Segment and extract | Multi-document scans cut into real documents; printed fields read |
| 5 | Review queue and intake | Every uncertainty becomes a human decision, never a silent default |
| 6 | Ledger and accruals | The three-week hole, closed |
| 7 | Match and payment run | Invoice-to-accrual matching, TDS and retention, draft bank file |
| 8 | Report page | Offline month-end position, no server, no network |
| 10 | Asking the ledger | Localhost surface: search, exceptions, and the actual scanned paper |

Missing beneficiary details **hold** a vendor rather than producing a payment
instruction.

---

## Rules the code is built on

These are business rules, not style preferences. A stage that breaks one is
wrong even if its tests pass.

- **Money is an integer count of paise.** No float touches money anywhere. At
  the end of this system we deduct tax at source and retention per line, sum
  lines into a vendor total, and sum vendors into a run total that leaves the
  bank. One float and the total stops reconciling to the lines, and a real
  accountant rejects the batch.
- **Quantity is an integer count of thousandths.** A weighbridge prints
  kilograms; 13460 kg is 13.460 tonnes, stored as 13460, converted once, where
  the paper is read.
- **Rates are basis points.** 200 is two percent.
- **The model reads paper. Arithmetic is deterministic.** No figure in the
  ledger is ever produced by a model call.
- **Nothing is silently dropped.** Every input is stored, sent to a human, or
  recorded as already handled.

---

## Proven on real paper

A live end-to-end run against a genuine scanned royalty pass and delivery
challan from the company's own files (not committed to this repository):

| | |
|---|---|
| Vendor | matched to a human-verified quarry supplier |
| Reference | read from the printed pass |
| Quantity | 13.460 t, from a printed "13460 kg" |
| Date | 2026-07-18, from a printed "18/07/2026" |
| **Accrual** | **₹12,921.60** — computed, not read |

The amount is arithmetic the model never saw: `13460 × 96000 ÷ 1000 = 1292160`
paise, at the vendor's contracted rate. Two genuine disagreements between the
pass and the challan were caught and routed to the review queue rather than
guessed at.

---

## Quick start

Requires [Bun](https://bun.sh) 1.4.2. There are **no runtime dependencies** —
the only devDependency is `bun-types`.

```sh
bun install
bun run typecheck
bun run test
```

Copy the variable names from [`.env.example`](.env.example) into an ignored
`.env`. `DATABASE_PATH` and `MODEL_PROVIDER` are required. For
`MODEL_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are also
required; for `MODEL_PROVIDER=local`, set `LOCAL_MODEL_COMMAND` to a program
that takes one JSON object on stdin and writes one JSON value on stdout.

Process one PDF:

```sh
bun run batch -- --pdf ./example.pdf --payment-run-id draft-2026-09-06 --payment-run-on 2026-09-06 --matched-on 2026-09-06 --reviewed-at 2026-09-06T09:00:00.000Z
```

It persists evidence and may prepare a draft run. It does not send a payment.
Run it only on authorised material; private paper does not belong in the repo.

Generate the offline report from a store:

```sh
bun run report ./persisted-store.sqlite ./report.html
```

Open `report.html` straight from disk. It has no server and no network
dependency.

---

## Operational surfaces

### Ask the ledger — localhost, read-only except review decisions

```sh
bun run ask-ledger
```

Open the displayed `http://127.0.0.1:3000/`. Questions are planned by the
configured provider, but **every displayed figure is calculated from stored
rows and cites them**. The only write route is the audited accountant
exception-review queue. It never creates payments, marks anything paid, or
changes model or ledger data.

### Folder intake watcher

Polls `./intake`, moves completed originals to `./processed`, and failures plus
an error sidecar to `./failed`, invoking the same batch entrypoint once a file
has been stable across two polls. See
[the intake watcher guide](docs/intake-watch.md).

```sh
bun run watch-intake -- --payment-run-id draft-2026-09-06 --payment-run-on 2026-09-06 --matched-on 2026-09-06 --reviewed-at 2026-09-06T09:00:00.000Z
```

### Optional Telegram intake adapter

Available only when `MESSAGING_BOT_TOKEN` and `MESSAGING_ALLOWED_SENDERS` are
configured. It long-polls Telegram, accepts allowed photo/PDF/image uploads from
permitted senders, and places bytes in `./intake`; run the watcher separately.
It does not start the pipeline, touch the database, or send money, and its
presence is not a claim that a bot is deployed for any supplier. See
[the Telegram intake guide](docs/telegram-intake.md).

```sh
bun run telegram-intake
```

---

## Demo

The [demo and filming runbook](docs/demo-runbook.md) carries the 3:40 timing,
shot cues, an honest end-to-end checklist, and the claims to avoid. Use only
authorised synthetic or simulated data in a recording.

---

## How this was built

Every line of product code in `src/` was written by autonomous coding agents
dispatched through **Agent Orchestrator**, across more than twenty-five merged
pull requests.

The loop: a planning agent reads the build specification, writes a stage brief
naming the capability and its rules but never the files or function names, and
dispatches it to a worker session in its own git worktree. The worker
implements, tests, and opens a PR. An independent reviewer then re-runs the
suite and applies its own **mutation tests** — deliberately breaking a line to
confirm a test catches it. A mutation that survives is a finding about the
test, not the code, and sends the PR back.

That review caught real defects, including a JSON schema that structurally
forbade the model from returning any field, a date parser that rejected every
date the company's paperwork actually prints, and a narration guard that
refused every payment whose identifiers contained a hyphen.
