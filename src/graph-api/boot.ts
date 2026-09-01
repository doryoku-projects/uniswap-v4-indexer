/*
 * Starts the Graph-dialect API inside the indexer process.
 *
 * Deliberately never rethrows: a failure here must leave the indexer indexing.
 * HandlerLoader wraps every handler import in a Promise.all whose rejection
 * aborts startup entirely, so an unguarded throw would take the indexer down.
 */

import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { createGraphApiServer } from "./server.js";

let started = false;

export function bootGraphApi(): void {
  // Handler modules are imported once per process, but guard anyway so a
  // double import cannot produce EADDRINUSE against ourselves.
  if (started) return;
  started = true;

  try {
    const cfg = loadConfig();
    if (!cfg) return;

    const db = new Db(cfg);
    const server = createGraphApiServer(cfg, db);

    server.on("error", (e) => {
      console.error(`graph-api: server error, API unavailable (indexing continues): ${String(e)}`);
    });

    server.listen(cfg.port, () => {
      console.log(
        `graph-api: chain ${cfg.chainId} on :${cfg.port} ` +
          `-> ${cfg.pg.host}:${cfg.pg.port}/${cfg.pg.database} schema=${cfg.schema}`,
      );
    });

    const shutdown = () => {
      server.close();
      void db.close();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (e) {
    console.error(`graph-api: failed to start, API unavailable (indexing continues): ${String(e)}`);
  }
}
