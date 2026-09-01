/*
 * HTTP surface: POST / speaking The Graph's dialect.
 * Everything interesting happens in translate() and the shaping functions.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { GraphApiConfig } from "./config.js";
import { Db } from "./db.js";
import { errorBody, InternalError, isProxyError, UpstreamTransportError } from "./errors.js";
import { makeIdCodec } from "./ids.js";
import { shapeMeta, shapeRoot, type PostProcessCtx } from "./postprocess.js";
import { translate } from "./translate.js";

interface Body {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function createGraphApiServer(cfg: GraphApiConfig, db: Db): Server {
  const ids = makeIdCodec(cfg.chainId);
  const ctx: PostProcessCtx = {
    ids,
    chainId: cfg.chainId,
    loadTokens: (list) => db.loadTokens(list),
    loadList: (plan, parentIds) => db.loadList(plan, parentIds),
    warn: (m) => console.warn(`graph-api: ${m}`),
  };

  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          send(res, 200, { ok: true, chainId: cfg.chainId, schema: cfg.schema });
          return;
        }
        if (req.method !== "POST") {
          send(res, 400, errorBody([new InternalError("only POST is supported")], cfg.chainId));
          return;
        }

        let body: Body;
        try {
          body = JSON.parse(await readBody(req)) as Body;
        } catch {
          send(res, 400, errorBody([new InternalError("request body is not JSON")], cfg.chainId));
          return;
        }
        if (typeof body.query !== "string") {
          send(res, 400, errorBody([new InternalError("missing `query`")], cfg.chainId));
          return;
        }

        const variables = (body.variables ?? {}) as Record<string, unknown>;
        const operationName = typeof body.operationName === "string" ? body.operationName : undefined;
        const plan = translate(body.query, variables, cfg.chainId, cfg.schema, operationName);

        if (plan.shape.kind === "meta") {
          send(res, 200, { data: shapeMeta(await db.loadMeta(), ctx) });
          return;
        }

        // Roots are independent, so run them concurrently.
        const entries = await Promise.all(
          plan.shape.roots.map(async (root) => {
            const rows = await db.query(root.sql, root.params);
            return [root.out, await shapeRoot(root, rows, ctx)] as const;
          }),
        );
        send(res, 200, { data: Object.fromEntries(entries) });
      } catch (e) {
        if (isProxyError(e)) {
          const headers: Record<string, string> = {};
          if (e instanceof UpstreamTransportError && e.retryAfter) {
            headers["retry-after"] = e.retryAfter;
          }
          send(res, e.httpStatus, errorBody([e], cfg.chainId), headers);
          return;
        }
        console.error("graph-api: unhandled", e);
        send(res, 500, errorBody([new InternalError(String(e))], cfg.chainId));
      }
    })();
  });
}
