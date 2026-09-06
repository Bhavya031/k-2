# AO Run — live handoff

**Rewrite this file after every stage.** It is the only thing a cold session
needs to continue. If the chat driving this run stops, paste this file into a
new one and it picks up without re-deriving anything.

Last updated: 2026-09-06 — seeded, nothing built.

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

**Stage:** none started.
**Main:** seed commit only — specification, rules, task board, demo inputs.
**Suite on main:** no tests exist yet.
**Blocking:** nothing.

**Open question the human has not answered:** the agreed rate per tonne for the
three quarries (Ganesh, Akshar, Maliyadhara). Stage 14 prices nothing without
it and will route every delivery to review instead. Ask again before Stage 14.

---

## Stage status

| # | Stage | Status | Branch | Commit | Suite |
|---|---|---|---|---|---|
| 1 | Foundation | TODO | | | |
| 2 | Model boundary | TODO | | | |
| 3 | Ingest and classify | TODO | | | |
| 4 | Segment and extract | TODO | | | |
| 5 | Review queue and intake | TODO | | | |
| 6 | Ledger and accruals | TODO | | | |
| 7 | Match and payment run | TODO | | | |
| 8 | The report page | TODO | | | |

Statuses: `TODO` `DISPATCHED` `REVIEW` `MERGED` `BLOCKED`.

Stages 1 and 4 hold independent pieces. Split them across parallel sessions,
one worktree each, and merge one at a time.

---|---|---|---|---|---|
| 1 | Project skeleton | DISPATCHED | ao/k-2-7/root | | |
| 2 | Config, value types, persistence | TODO | | | |
| 3 | Foundations | TODO | | | |
| 4 | Model boundary | TODO | | | |
| 5 | Real provider and test harness | TODO | | | |
| 6 | Ingestion and classification | TODO | | | |
| 7 | Structure | TODO | | | |
| 8 | Meaning | TODO | | | |
| 9 | Retrieval and reach | TODO | | | |
| 10 | Report surface | TODO | | | |
| 11 | Rehearsal | TODO | | | |
| 12 | Safety | TODO | | | |
| 13 | Ledger storage | TODO | | | |
| 14 | Accruals | TODO | | | |
| 15 | Three-way match | TODO | | | |
| 16 | Payment run | TODO | | | |
| 17 | Ledger on the report surface | TODO | | | |

Statuses: `TODO` `DISPATCHED` `REVIEW` `MERGED` `BLOCKED`.

Stages 2, 3 and 7 hold several independent pieces. Split them across parallel
sessions, one worktree each, and merge them one at a time.

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
