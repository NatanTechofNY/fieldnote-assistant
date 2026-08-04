import "dotenv/config";
import { createApp } from "./app.ts";
import { runCli, type CliCommand } from "./cli.ts";
import { startWorker } from "./worker.ts";

const flags: Record<string, CliCommand> = {
  "--seed": "seed",
  "--reset": "reset",
  "--reindex": "reindex",
  "--setup-algolia": "setup-algolia",
};
const selectedFlag = process.argv.find((argument) => argument in flags);

if (selectedFlag) {
  await runCli(flags[selectedFlag] as CliCommand);
} else {
  // Basic Auth is the only access control in this app, and an unset password
  // silently serves everything to anyone. Refuse to start rather than let a
  // hosted deployment come up wide open.
  if (process.env.NODE_ENV === "production" && !process.env.APP_ADMIN_PASSWORD) {
    if (process.env.APP_ALLOW_NO_AUTH === "true") {
      console.warn("WARNING: running with no authentication. Every route is public.");
    } else {
      console.error(
        "Refusing to start: APP_ADMIN_PASSWORD is not set.\n" +
        "Without it every route, including all of your personal data, is public.\n" +
        "  Generate one:  openssl rand -base64 24\n" +
        "  Then set APP_ADMIN_PASSWORD in the environment.\n" +
        "To run without authentication anyway, set APP_ALLOW_NO_AUTH=true.",
      );
      process.exit(1);
    }
  }
  const port = Number(process.env.PORT || 4174);
  const { app, db, search } = createApp();
  const stopWorker = startWorker(db, search);
  const server = app.listen(port, () => {
    console.log(`Personal assistant API listening on http://localhost:${port}`);
  });
  const shutdown = (): void => {
    stopWorker();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
