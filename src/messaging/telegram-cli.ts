import { createHashedIgnoredSenderRecorder, startTelegramMessagingTransport } from "./telegram.ts";

void (async () => {
  if (!import.meta.main) return;
  const transport = startTelegramMessagingTransport({ ignoredSenders: createHashedIgnoredSenderRecorder() });
  if (transport !== undefined) await transport.run();
})();
