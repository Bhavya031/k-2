# Gmail intake

Suppliers already email their paperwork. This poller turns a Gmail label into
the front door of the pipeline: it downloads PDF attachments from unread
messages under one label and drops them into the folder the intake watcher
polls. It reads mail and writes files. It books nothing and pays nothing.

## Setup

1. Create a Gmail label, by default `k2-bills`.
2. Create an OAuth client and authorise it for the `gmail.modify` scope, then
   put the client id, client secret, and refresh token in `.env` as
   `CLIENT_ID`, `CLIENT_SECRET`, and `REFRESH_TOKEN`.

   The refresh token must be minted by *that same* client. A token obtained
   from the OAuth Playground without ticking "Use your own OAuth credentials"
   belongs to Google's playground client and fails with `unauthorized_client`.

3. Label the supplier mail you want ingested, by hand or with a Gmail filter.

## Running

```sh
bun run gmail-intake -- --once
bun run gmail-intake            # polls every 15 seconds
```

Options: `--label` (default `k2-bills`), `--intake-dir` (default `./intake`),
`--state` (default `./.gmail-intake-state.json`), `--poll-ms` (default
`15000`), `--once`, and `--mark-read`.

Only messages matching `label:<label> is:unread has:attachment` are considered,
and only `application/pdf` parts are downloaded. Every downloaded file is named
`gmail-<message id>-<index>-<sender filename>.pdf`; the sender's filename is
stripped of anything that could climb a directory or hide the file, so a
malicious attachment name cannot escape the intake folder.

Each poll writes one JSON line listing what it saved and what it skipped, and
records handled message ids in the state file so a restart never re-downloads.
`--mark-read` additionally clears `UNREAD` in Gmail; without it the poller
makes no change to the mailbox at all.

Run the intake watcher alongside it to start the production batch:

```sh
bun run watch-intake -- --payment-run-id draft-2026-09-06 --payment-run-on 2026-09-06 --matched-on 2026-09-06 --reviewed-at 2026-09-06T09:00:00.000Z
```
