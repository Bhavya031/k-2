# AO Run — live handoff

**Rewrite this file after every stage.** It is the only thing a cold session
needs to continue. If the chat driving this run stops, paste this file into a
new one and it picks up without re-deriving anything.

Last updated: 2026-09-06 — Documentation/demo runbook is in REVIEW on `ao/k-2-31/documentation`; the original eight-stage board is retained unchanged.

---

## Cold-start instructions

You are the master agent for this run. You plan, dispatch, verify and merge.
You do not write product code.

1. Read `AGENTS.md`, then `.ai/RULES.md`, then `.ai/BUILD_SPEC.md`.
2. One worktree per parallel session, branched from current main. Install
   dependencies inside each one before dispatch; worktrees do not share them.
3. Find the first stage below whose status is not MERGED. That is where you are.
4. Dispatch it using the template in this file.
5. When it merges, rewrite the table, the log, and "Where we are" below, and
   commit this file.

---

## Where we are

**Maintenance claim:** Documentation/demo runbook — REVIEW on `ao/k-2-31/documentation` (`e99c384`); this documentation-only task leaves the eight-stage table unchanged.
**Stage:** Stage 10 exception-review follow-up — REVIEW. The localhost ledger surface now has the existing ReviewQueue as its only bookkeeping write path; the original eight-stage board below is retained unchanged.
**Parallel claim:** Telegram `MessagingTransport` adapter — REVIEW on `ao/k-2-28/root`; watcher work remains separate.
**Main:** Stages 1–8 merged — foundation through the offline report page.
**Suite in Stage 10 follow-up worktree:** 116 pass, 0 fail, 384 expect() calls across 18 files; typecheck clean.
**Blocking:** a 36-page production run is sequential at configured concurrency 1 and only reached page 8 after 111 seconds; stopped rather than burn subscription calls. The real-demo worker owns the shipped Codex CLI shim and production run. Stage 9 persists `source_documents.ingest_source_sha256` with an inclusive segmented page range for reliable ingestion, ledger, and report joins; no original stage was renumbered.

---

## Stage status


| # | Stage | Status | Branch | Commit | Suite |
|---|---|---|---|---|---|
| 1 | Foundation | MERGED | PRs #3, #2, #4, #1 | 28e5e23, 1e12ef4, 17e2a27, d2551fc | 32 pass, 0 fail; 79 expect() calls / 4 files; typecheck clean |
| 2 | Model boundary | MERGED | PR #5 | a95f930 | 40 pass, 0 fail; 111 expect() calls / 5 files; typecheck clean |
| 3 | Ingest and classify | MERGED | PR #6 | f42cd26 | 44 pass, 0 fail; 128 expect() calls / 6 files; typecheck clean |
| 4 | Segment and extract | MERGED | PRs #7, #8 | 912fd71, 246b875 | 54 pass, 0 fail; 162 expect() calls / 8 files; typecheck clean |
| 5 | Review queue and intake + Gmail security follow-up | REVIEW | feat/gmail-intake | follow-up pending | 163 pass, 0 fail; 552 expect() calls / 22 files; typecheck clean |
| 6 | Ledger and accruals | MERGED | PR #12 | db34e88, 00cf902 | 76 pass, 0 fail; 240 expect() calls / 12 files; typecheck clean |
| 7 | Match and payment run + RazorpayX security | REVIEW | ao/k-2-30/razorpayx-security | pending | 166 pass, 0 fail; 593 expect() calls / 22 files; typecheck clean |
| 8 | The report page | REVIEW | ao/k-2-23/report-page | 1addcc5 | 99 pass, 0 fail; 313 expect() calls / 15 files; typecheck clean |
