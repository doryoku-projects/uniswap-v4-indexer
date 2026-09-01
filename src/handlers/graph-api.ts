/*
 * The only file under src/handlers/ that is not an event handler.
 *
 * envio auto-imports every src/handlers/**‌/*.ts into the indexer process
 * (HandlerLoader.res.mjs:41), which is the hook that lets the Graph-dialect API
 * run in-process — no separate server, no Hasura.
 *
 * It must NOT bind a port in every context that loads handlers:
 *
 *   envio dev / start  Main.res.mjs sets EnvioGlobal.value.persistence at :492,
 *                      two statements before handlers load at :494.  -> START
 *   createTestIndexer  TestIndexer.res.mjs:420 loads handlers too, and never
 *                      touches EnvioGlobal at all.                   -> SKIP
 *   envio codegen      never enters this JS path at all.             -> n/a
 *
 * So the presence of a live persistence layer is the discriminator, and the
 * whole thing is opt-in behind GRAPH_API_CHAIN_ID besides.
 */

import { value as envioGlobal } from "envio/src/EnvioGlobal.res.mjs";

import { bootGraphApi } from "../graph-api/boot.js";

if (envioGlobal?.persistence !== undefined) {
  bootGraphApi();
}
