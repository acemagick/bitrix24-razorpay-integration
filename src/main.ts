/**
 * Entry point: load config, build the real clients, start the HTTP server.
 *
 *   npm run dev      development: restarts automatically when you save a file
 *   npm start        production: runs the compiled JavaScript from dist/ (after npm run build)
 */

import { createApp } from "./app.ts";
import { BitrixClient } from "./bitrix.ts";
import { getConfig } from "./config.ts";
import { RazorpayClient } from "./razorpay.ts";
import { ProcessedEventStore } from "./webhookHandler.ts";

// A missing or invalid .env should produce a readable message, not a stack trace.
let config;
try {
  config = getConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const bitrix = new BitrixClient(config.bitrixWebhookUrl);
const razorpay = new RazorpayClient(config.razorpayKeyId, config.razorpayKeySecret.reveal());
const eventStore = new ProcessedEventStore(config.processedEventsPath);
await eventStore.load(); // before accepting webhooks, so restarts remember past events

const { app, drain } = createApp({ config, bitrix, razorpay, eventStore });

const server = app.listen(config.port, () => {
  const mode = config.razorpayKeyId.startsWith("rzp_test_") ? "TEST" : "LIVE";
  console.info(`[server] Listening on http://localhost:${config.port} (Razorpay ${mode} mode)`);
  if (!config.inboundApiToken) {
    console.warn("[server] INBOUND_API_TOKEN is not set: anyone who can reach /payment-links can create links.");
  }
});

// Last line of defence: log it instead of crashing silently. (processWebhook is
// written never to reject, so if this fires, it's a bug worth seeing.)
process.on("unhandledRejection", (reason) => console.error("[server] Unhandled promise rejection", reason));

/**
 * Graceful shutdown on Ctrl+C (SIGINT) or when a host/container stops us (SIGTERM).
 *
 * WHY: stop accepting new requests, let in-flight ones finish, and make sure the
 * processed-events file is fully written. Otherwise a webhook handled a moment
 * before shutdown might be forgotten, and processed twice if Razorpay retries.
 */
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[server] ${signal} received, shutting down`);
  // Upper bound for the whole shutdown: if background work hangs (e.g. Bitrix
  // never answers), exit anyway after 10 seconds.
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(async () => {
    // No new requests can arrive now. Wait for webhooks already being processed
    // (their 200 was sent, but their Bitrix comment may still be in progress).
    await drain();
    await eventStore.flush();
    console.info("[server] Stopped");
    process.exit(0);
  });
  // close() waits for idle keep-alive connections too; don't let them hold us up.
  server.closeIdleConnections();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
