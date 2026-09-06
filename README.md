
## Ask the ledger (live, read-only)

This is separate from the Stage 8 offline report. It serves a live view on
`127.0.0.1` only; refresh the browser after a batch write to see current records.
Its only write path is the accountant exception review: it claims and records
approve/correct/reject decisions through the existing review queue; it never creates
payments or changes ledger/model records. With `DATABASE_PATH`, `MODEL_PROVIDER`, and the selected provider's
configuration set, run:

```sh
bun run ask-ledger
```

Open the displayed `http://127.0.0.1:3000/` address. It never approves records,
changes the model, marks anything paid, or connects to a bank.
