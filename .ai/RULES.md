# Rules

## Roles

An **orchestrator** plans, dispatches, verifies and merges. It may read
anything but writes only to `.ai/`.

A **worker** implements exactly one stage in its own worktree. It is the only
kind of session that writes product code.

## Before you touch code

1. Read `AGENTS.md` and your stage in `.ai/BUILD_SPEC.md`.
2. Claim your stage in `.ai/AO_RUN.md`.
3. Append a START line to `.ai/ACTIVITY_LOG.md`.

## While you work

- Stay inside your stage. If you need a file another stage owns, stop and say
  so rather than editing it.
- Do not add a dependency without saying why in your report.
- Do not merge or rebase main into your branch. The orchestrator integrates.
- If the spec is wrong or ambiguous, say so. Do not silently invent an answer
  and do not quietly narrow the stage to the part you found easy.

## Before you report

Run the full suite, the typecheck, and `git diff --check`. Report the actual
counts, never a summary.

Then run a mutation check you designed yourself: change one line your tests
should catch, run the suite, confirm it fails, revert it exactly, rerun. Report
which test failed and its exact message.

**A mutation that survives is a finding about your tests, not permission to
continue.** Fix the test and say what you found.

## Finishing

Append FINISH to `.ai/ACTIVITY_LOG.md` with the real counts, set your stage to
REVIEW in `.ai/AO_RUN.md`, and make a signed commit. Report both commit hashes.

## Verification, by the orchestrator, before every merge

A worker's report is a claim. Read the diff, run the suite yourself, and run
your own mutation check — a different one from the worker's. Confirm no float
touches money and no unannounced dependency arrived.

Merge from the main repository, one branch at a time, full suite after each.
