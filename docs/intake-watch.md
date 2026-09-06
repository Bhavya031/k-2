# Polled PDF intake folders

Start the watcher with the normal required production-batch metadata:

```sh
bun run watch-intake -- --payment-run-id draft-2026-09-06 --payment-run-on 2026-09-06 --matched-on 2026-09-06 --reviewed-at 2026-09-06T09:00:00.000Z
```

By default, paths are relative to the current working directory:

- `./intake` — pending PDF drops;
- `./processed` — PDFs whose production batch completed;
- `./failed` — PDFs whose batch failed, with an adjacent `.error.txt` sidecar.

Use `--intake-dir`, `--processed-dir`, and `--failed-dir` to configure the
three locations. `--poll-ms` sets the positive-integer interval (default:
`1000`). The watcher polls; it does not use filesystem-watch events. It only
starts a PDF after its byte size is unchanged across two polls, so a file still
being copied remains pending. `--once` performs one deterministic poll for an
operational check; it intentionally does not process a newly seen file.
Every poll writes its current `pending`, `processed`, and `failed` lists as one
JSON line, so work still in `./intake` is never reported as complete.

The watcher invokes the same production batch command as `bun run batch` for
each ready PDF. It prepares records only; it does not send payments.
