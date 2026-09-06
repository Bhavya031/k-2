# AO Run — live handoff

**Rewrite this file after every stage.** It is the only thing a cold session
needs to continue. If the chat driving this run stops, paste this file into a
new one and it picks up without re-deriving anything.

Last updated: 2026-09-06 — Ledger document surface is in REVIEW on `ao/k-2-29/ledger-documents`; the original eight-stage board is retained unchanged.

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

**Maintenance claim:** Ledger document surface — REVIEW on `ao/k-2-29/ledger-documents`; eight-stage table unchanged.
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
| 5 | Review queue and intake | MERGED | PRs #10, #9, #11 | d2e2f49 | 68 pass, 0 fail; 203 expect() calls / 11 files; typecheck clean |
| 6 | Ledger and accruals | MERGED | PR #12 | db34e88, 00cf902 | 76 pass, 0 fail; 240 expect() calls / 12 files; typecheck clean |
| 7 | Match and payment run | MERGED | PRs #14, #13 | a486e58 | 93 pass, 0 fail; 286 expect() calls / 14 files; typecheck clean |
| 8 | The report page | REVIEW | ao/k-2-23/report-page | 1addcc5 | 99 pass, 0 fail; 313 expect() calls / 15 files; typecheck clean |

Statuses: `TODO` `DISPATCHED` `REVIEW` `MERGED` `BLOCKED`.

Stages 1 and 4 hold independent pieces. Split them across parallel sessions,
one worktree each, and merge one at a time.

---

## Dispatch template

Create the worktree from the main repository, install dependencies inside it,
confirm it is clean, then give the session this:

```
Read .ai/BUILD_SPEC.md and implement Stage <N> — <name>.

You are in the worktree <path> on branch <branch>. Do not create a worktree and
do not switch branches.

The specification states a capability, its invariants and how to tell it is
finished. It does not name files or functions on purpose. Design those
yourself: choose names that fit the code you write, and follow the conventions
already in the repository.

The "System invariants" section at the top of the spec applies to your stage
whether or not your stage repeats it. A stage that violates one is wrong even
if its tests pass.

Before your first product edit: read AGENTS.md and .ai/RULES.md, claim
your stage in .ai/AO_RUN.md, and append a START entry to .ai/ACTIVITY_LOG.md.

Write the tests as you go, not at the end. Then design your own mutation check:
change one line that the tests should catch, run the suite, and confirm it
fails. If nothing fails, your tests are wrong — fix them and say so. Report
which test failed and with what message.

Do not add a dependency without saying why in your report. Do not touch code
outside your stage; if you need to, stop and report it.

Every commit is signed. Never add any agent as author or co-author. Every
commit ends with a trailer naming this session. Never invent one.

When done: append FINISH to .ai/ACTIVITY_LOG.md with the actual test counts,
set your stage to REVIEW in .ai/AO_RUN.md, commit, and report the commit
hashes, the counts, and your mutation result.
```

---

## Verification, before every merge

A session's report is a claim. For every stage:

- read the diff, not the summary of it
- run the full suite yourself in the worktree
- run your OWN mutation check, different from the session's. This is the
  load-bearing step. If nothing fails, the stage is not done.
- confirm no float touches money, no dependency arrived unannounced, and no
  file outside the stage changed

Merge from the main repository with `git -C <main repo> merge <branch>`. A `cd`
into the worktree makes git report "Already up to date" and merge nothing.

Conflicts: the activity log keeps both sides; the stage table keeps one row per
stage at the most advanced status.

---

## Log

Newest last. One line per stage, written when it merges.

- 2026-09-06 — seeded. Specification, rules, playbook, task board and the three
  public tender notices committed. No product code.

- 2026-09-06 — Stage 2 merged: PR #5 (a95f930); final `bun test` 40 pass, 0 fail, 111 expect() calls across 5 files; `bun run typecheck` passed.

## Post-stage handoff

- 2026-09-06 — POST-STAGE-INTAKE-WATCH REVIEW: portable polling intake folders
  are implemented on `ao/k-2-27/intake-watch`. The watcher delegates each
  stable PDF to the existing production batch command, reports pending work,
  and moves successes/failures to their documented folders. The eight-stage
  board above remains the only stage board.
- 2026-09-06 — POST-STAGE-INTAKE-WATCH IMAGE FOLLOW-UP: stable JPEG and PNG
  files normalize via the available `img2pdf` system tool to temporary
  single-page PDFs before the unchanged production batch entrypoint. Originals
  still move to the same processed/failed folders; temporary PDFs are cleaned.
