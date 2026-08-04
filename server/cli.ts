import { AlgoliaSync } from "./algolia.ts";
import { openDatabase, resetDatabase, seedDatabase } from "./db.ts";

export type CliCommand = "seed" | "reset" | "reindex" | "setup-algolia";

export async function runCli(command: CliCommand): Promise<void> {
  const db = openDatabase();
  const search = new AlgoliaSync(db);
  try {
    if (command === "seed") {
      console.log(JSON.stringify(seedDatabase(db)));
      await search.flush();
    } else if (command === "reset") {
      resetDatabase(db);
      console.log(JSON.stringify({ reset: true }));
    } else if (command === "reindex") {
      console.log(JSON.stringify(await search.reindex()));
    } else {
      console.log(JSON.stringify(await search.setup()));
    }
  } finally {
    db.close();
  }
}
