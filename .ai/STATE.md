# Current State

Last updated: 2026-09-06 — start of the AO reproduction run.

## What this repository is

K-2, an autonomous construction finance system for a small civil-contracting
company in Gujarat. Syndicate by Maximor, Track 2 — Autonomous Office of the
CFO.

This repository is built by AO agent sessions from `.ai/BUILD_SPEC.md`. That
file states each stage as a capability, its invariants and its acceptance. It
names no file and no function on purpose: the session that implements a stage
designs those. Product code does not exist yet.

## Architecture (ACCEPTED — do not relitigate)

- TypeScript on Bun. Zod 4 for every structured boundary.
- SQLite with STRICT tables. Integer money in paise. No float touches money.
- Inngest for jobs, Langfuse for tracing, Graphiti for memory. No vector DB.
- Rejected: Python plus Pydantic and Instructor, because it forces a second
  runtime. Rejected: a vector database, because exact metadata retrieval
  answers the questions this business asks.

## Units, everywhere, without exception

- Money is an integer count of paise. `1250` is twelve rupees fifty paise.
- Quantity is `quantityMilli`, an integer count of thousandths of the unit.
  12.42 MT is `12420`.
- Rates are basis points. `200` is two percent.

## Retry policy

Retry ONLY on schema-validation failure, and only inside
`src/llm/structured.ts`. Nowhere else in the system retries a model call.

## Order of work

Work the stages in `.ai/BUILD_SPEC.md` in order, tracked in `.ai/AO_RUN.md`. A
stage starts only when every stage it depends on is merged to main. Several
stages hold independent pieces; run those in parallel, one worktree each. No
stage starts early with deferred tests.

## Status

Nothing implemented yet. Eight stages wait in `.ai/BUILD_SPEC.md`.
