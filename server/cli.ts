import { AlgoliaSync } from "./algolia.ts";
import { sweepOrphanedAttachmentFiles } from "./attachments.ts";
import { loadStoreCatalog, openDatabase, resetDatabase, seedDatabase } from "./db.ts";

export type CliCommand = "seed" | "reset" | "reindex" | "setup-algolia";

export async function runCli(command: CliCommand): Promise<void> {
  const db = openDatabase();
  loadStoreCatalog(db);
  const search = new AlgoliaSync(db);
  try {
    if (command === "seed") {
      console.log(JSON.stringify(seedDatabase(db)));
      await search.flush();
    } else if (command === "reset") {
      resetDatabase(db);
      // The rows are gone with their messages; so are the files they named.
      console.log(JSON.stringify({ reset: true, attachmentFilesRemoved: sweepOrphanedAttachmentFiles(db, { graceMs: 0 }) }));
    } else if (command === "reindex") {
      console.log(JSON.stringify(await search.reindex()));
    } else {
      console.log(JSON.stringify(await search.setup()));
    }
  } finally {
    db.close();
  }
}
