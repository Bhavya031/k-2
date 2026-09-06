# Telegram intake

The Telegram adapter long-polls the configured bot and writes accepted uploads
into the watcher's `./intake` folder. It does not start the pipeline, access the
database, or send money.

Configure `MESSAGING_BOT_TOKEN` and `MESSAGING_ALLOWED_SENDERS` only in the
runtime environment or an ignored local `.env` file (see `.env.example` for
variable names). Start the adapter with:

```sh
bun run telegram-intake
```

Run the intake watcher separately against the same `./intake` folder. The
adapter accepts Telegram photos, PDFs, and image documents from allowed sender
IDs only. Each accepted upload receives one short acknowledgement; unauthorized
senders receive no reply.
