# K-2 Build Specification

Eight stages. Each states a capability, the rules that constrain it, and how to
tell it is finished.

It deliberately does not name files, functions or exact test values. Choose
those yourself — a name that fits the code you wrote is better than one picked
before the code existed.

What is not negotiable is under "Rules". Those are business rules. A stage that
breaks one is wrong even if its tests pass.

---

## The business

A civil contractor in Gujarat, India. Roughly forty to fifty suppliers, almost
all on credit. There is no purchase order system and never has been.

A cost begins as paper a truck driver carries: a royalty pass proving material
was legally mined, or a delivery challan. The supplier's invoice arrives about
three weeks later. Payment goes out about three weeks after that.

Between the delivery and the invoice, that money is invisible. At month end the
company is guessing what it owes. That gap is the problem this system exists to
close.

---

## Rules that bind every stage

**Money is an integer count of paise.** 1250 is twelve rupees fifty paise. No
float touches money anywhere. The reason is concrete: at the end of this system
we deduct tax at source and retention on each line, sum lines into a vendor
total, and sum vendors into a run total that leaves the bank. If any step is
floating point the total stops reconciling to the lines and a real accountant
rejects the batch.

**Quantity is an integer count of thousandths of its unit.** A weighbridge
prints kilograms; 12420 kg is 12.420 tonnes and is stored as 12420. The
conversion happens once, where the paper is read.

**Rates are basis points.** 200 is two percent.

**Retry only on schema-validation failure**, and only in the one place that
wraps structured model output. Nothing else retries a model call.

**The model reads paper. Arithmetic is deterministic.** No figure in the ledger
is ever produced by a model call.

**Nothing is silently dropped.** Every input is stored, sent to a human, or
recorded as already handled. An operation over many items reports what it
skipped and why.

**No float, no exceptions.** The only decimal string in the system is inside the
bank file, converted at that boundary.

**This connects to no bank and no government portal.** Anything naming an
execution state says simulated.

---

## Stage 1 — Foundation

Four pieces, and they share no files. Run them in parallel.

**Project.** TypeScript on Bun, strict mode, ES modules. A typecheck command
and a test command. An empty test suite must make the test command fail — Bun's
default is to pass, and a green build that ran nothing is worse than a red one.
Pin the Bun version in the manifest. An example environment file listing every
variable with no values in it.

**Configuration.** Parse the environment once at startup through a schema into a
frozen object; nothing else reads the environment directly. A missing optional
key leaves that capability absent and startup succeeds. A missing or malformed
required key throws at startup naming the key. The provider selector is a closed
set of known values, never a free string.

**Value types.** The vocabulary every later stage speaks: money, quantity,
rate, confidence, provenance, and an outcome type for operations over many
items. The integer rules above live in this validation, not in a comment.
Provenance records which document a fact came from, which page, how confident,
and when — a fact with no source is not stored. Confidence is bounded and the
bound is enforced.

**Store.** SQLite, every table STRICT, foreign keys enforced and proven by a
test that a bad reference is rejected. Money columns are INTEGER with a check
that the stored value is of integer type, not merely integer-valued. Quantity
columns reject negatives. Status columns are constrained to a known set at the
database level. Dates that can expire are date-only and timezone-independent.
Migration is idempotent.

Done when: a float amount is rejected by the database itself, and a malformed
required environment key crashes at startup naming that key.

## Stage 2 — Model boundary

Ask a model for a structured answer, get back a validated object.

On a schema-validation failure, retry a bounded number of times feeding the
validation error back. On any other failure, do not retry.

**No mock provider may be reachable while a real provider is configured.** A
silent fall back to fabricated output is the worst failure this system can have,
because it looks exactly like success. Prove this with a test.

Two real providers behind one interface: an API provider that forces structured
output rather than parsing free text, and a fallback that runs inference through
a local model binary for when API credit runs out. Same output shape, and the
selector chooses.

Test fixtures are visibly invented. No real names, identifiers, bank details or
scans, not even redacted ones.

Done when: a malformed response retries then fails loudly, no path reaches a
mock while a real provider is set, and the suite runs green with no network.

## Stage 3 — Ingest and classify

Accept a multi-page PDF. Keep the original untouched, render every page to an
image, store one row per page. An identical re-upload is recognised, not
duplicated.

For each page image produce a document type, a confidence, a short summary and
labels. A page too damaged to read says so instead of guessing.

Page rendering and per-page model calls run in parallel up to a configured
limit. Unbounded parallelism against a rate-limited provider fails in a way that
looks like a model problem and wastes hours.

Done when: a real multi-page scan produces one row per page, each with a type.

## Stage 4 — Segment and extract

**Segment.** Decide where one document ends and the next begins by looking at a
sliding window of pages with overlap — not at pages in isolation. The unit is a
transaction, not a sheet: a royalty pass and the weighbridge slip stapled behind
it are one document.

This is measured, not theoretical. On a real 42-page batch containing 11
documents, comparing pages statelessly got **zero** page ranges right. The
window got nine exactly right. Build the window.

Support sending several labelled page images in one structured call, and allow a
stronger model for the boundary judgement than for the per-page work.

Name each document deterministically — same input, same name.

**Extract.** Per document type, pull the typed fields that type carries. A field
the paper does not show is absent, never invented. Roll per-page fields up into
the segmented document without spending another model call.

Done when: a 42-page mixed scan resolves into the right number of documents with
most page ranges exactly right.

## Stage 5 — Review queue and intake

**Queue.** Items needing a human, with a priority and an audited decision.
Approving something records who approved it and when. Writes are atomic; two
sessions must not be able to claim the same item.

**Intake.** The paper that never arrives digitally travels with the driver, and
the drivers do not have email. Accept a photograph over a messaging app they
already have on their phone, and turn it into a classified document.

The same surface carries the decision: approve, correct, or reject, from the
phone. Someone who cannot read English must still be able to use it. This
replaces a phone call between the accountant and the driver.

Done when: a photograph sent from a phone becomes a document, and an uncertain
extraction reaches the queue instead of the ledger.

## Stage 6 — Ledger and accruals

**Store.** Accrued liabilities; the match between an accrual and the invoice
that settles it; payment runs and their lines; and the terms agreed with each
vendor — tax section and rate, retention rate, payment terms in days, the agreed
rate per tonne, and the beneficiary bank details.

An accrual moves through incurred, then invoiced when a matching bill arrives,
then settled when paid. It can also be disputed or voided.

**Accruals.** Delivery evidence proves a cost was incurred the day material
moved. Book the liability that same day.

**Price it from quantity times the agreed rate, never from the figure printed on
the paper.** This is measured: on that same real 42-page batch, 7 of the 11
delivery documents carried **no amount at all**, and two of the four that did
carried the identical figure for two different weights. Net weight was present
on every one. The company knows its rate with each quarry.

A vendor with no agreed rate does not get a guessed one. The first delivery from
a new vendor asks a human for the rate once; every delivery after that prices
itself.

An amount printed on the paper is kept as evidence and flagged when it disagrees
with the computed figure. It is never used as the amount.

Done when: a delivery from a known vendor books a liability the day it arrives,
and one from an unknown vendor reaches a human instead.

## Stage 7 — Match and payment run

**Match.** The bill arrives weeks later. Match it to the accrual it settles.
Deterministic, no model call.

Vendor identity and a date window are hard gates. Signals inside those gates are
scored; the winner must clear a threshold and beat the runner-up by a margin, or
nothing is matched. Two accruals cannot claim the same invoice.

Vendor names vary in spelling between deliveries — measured, one quarry appeared
two ways in the real data. Allow a small bounded edit distance on names long
enough for it to be safe, but a spelling variant scores nothing on its own so it
can never lift a weak match over the line.

A money difference is signed and stays signed. Under-billing matters as much as
over-billing.

**Name the cause, not the number.** Same quantity billed at a different total
means the rate moved. A different quantity means the weighbridge disagreed. An
accountant acts on the cause. A variance never auto-clears — it goes to a person
with both documents.

**Payment run.** Group what is due by vendor. An Indian contractor does not pay
face value: tax is deducted at source above a single-payment threshold, and
civil work holds back retention against defects. Gross, less tax, less
retention, equals net payable. Getting this wrong is the commonest reason a run
is rejected at review, so compute it and show it.

Round once per line. A vendor total is the sum of its already-rounded lines, so
the run reconciles to its lines exactly.

Every Indian tax invoice prints the supplier's bank details on its face. Read
them off the invoice already extracted and store them against the vendor, so the
second invoice from that vendor needs no data entry. Never invent them — a
vendor whose details are missing is held, not paid.

Emit the bulk-upload file the bank accepts unchanged. Nothing here moves money.
A person clicks send.

Done when: an identical invoice clears untouched, a rate change is named as a
rate change, and a run produces a file an operator could upload.

## Stage 8 — The report page

One self-contained offline file. No server, no network request, no external
font, no CDN. It is opened from a filesystem on a laptop with no internet.

What an accountant opens it to ask, in order: what do we owe that has not been
billed, what arrived that disagrees with the evidence, and what is about to
leave the bank with its deductions shown. Plus the documents resolved, and
search.

Search is exact-first over what the store already holds: a pass number, a vendor
name, a reference, an amount. It is not a question-answering surface and there
is no conversational agent. The questions this business asks are exact ones, and
an exact index answers them without a model call. Do not build a chat interface
and do not add a vector index.

Variances belong in the exceptions list — that is the queue a person works.

Regenerating it must not need a scan or a model call. Reading the store is
enough, and one command does it. An empty store still produces a complete,
readable page.

Done when: the page opens from disk with the network disabled and renders
completely, including the ledger.
