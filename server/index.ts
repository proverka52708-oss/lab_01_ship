import { config } from "./config.ts";
import { createApplication } from "./http-server.ts";
import { logger } from "./logging.ts";

const application = await createApplication(config);

application.server.listen(config.port, "0.0.0.0", () => {
  logger.info(
    { port: config.port, buildSha: config.buildSha },
    "Star Runner server listening",
  );
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown started");
  application.beginShutdown();
  const forceTimer = setTimeout(() => {
    logger.error(
      "Graceful shutdown exceeded 8 seconds; forcing connections closed",
    );
    for (const client of application.websocket.server.clients)
      client.terminate();
    application.server.closeAllConnections();
  }, 8000);

  try {
    const httpClosed = new Promise<void>((resolve, reject) => {
      if (!application.server.listening) return resolve();
      application.server.close((error) => (error ? reject(error) : resolve()));
    });
    await Promise.all([application.close(), httpClosed]);
    clearTimeout(forceTimer);
    logger.info("Graceful shutdown complete");
    await new Promise<void>((resolve) => logger.flush(() => resolve()));
    process.exitCode = 0;
  } catch (error) {
    clearTimeout(forceTimer);
    logger.fatal({ err: error }, "Graceful shutdown failed");
    logger.flush(() => process.exit(1));
  }
}

process.once("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception");
  logger.flush(() => process.exit(1));
});
process.once("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled rejection");
  logger.flush(() => process.exit(1));
});
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
