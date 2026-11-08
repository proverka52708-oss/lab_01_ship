import { config } from "./config.js";
import { createApplication } from "./http-server.js";

const application = await createApplication(config);

application.server.listen(config.port, "0.0.0.0", () => {
  console.log(`Star Runner server listening on port ${config.port}`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; closing WebSocket clients and match logs`);

  try {
    await application.close();
    await new Promise((resolve, reject) => {
      if (!application.server.listening) return resolve();
      application.server.close((error) => (error ? reject(error) : resolve()));
    });
    console.log("Shutdown complete");
    process.exitCode = 0;
  } catch (error) {
    console.error("Graceful shutdown failed:", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
