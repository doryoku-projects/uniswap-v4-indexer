/*
 * Minimal HTTP surface: POST / (and /graphql) speaking The Graph's dialect.
 * Everything interesting happens in translate() and postProcess().
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { ProxyConfig } from "./config.js";
import { errorBody, InternalError, isProxyError, UpstreamTransportError } from "./errors.js";
import { HasuraClient } from "./hasura-client.js";
import { makeIdCodec } from "./ids.js";
import { postProcess } from "./postprocess.js";
import { translate } from "./translate.js";

interface GraphQLRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function createProxyServer(cfg: ProxyConfig) {
  const client = new HasuraClient(cfg);
  const ids = makeIdCodec(cfg.chainId);

  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          send(res, 200, { ok: true, chainId: cfg.chainId });
          return;
        }
        if (req.method !== "POST") {
          send(res, 400, errorBody([new InternalError("only POST is supported")], cfg.chainId));
          return;
        }

        let body: GraphQLRequestBody;
        try {
          body = JSON.parse(await readBody(req)) as GraphQLRequestBody;
        } catch {
          send(res, 400, errorBody([new InternalError("request body is not JSON")], cfg.chainId));
          return;
        }
        if (typeof body.query !== "string") {
          send(res, 400, errorBody([new InternalError("missing `query`")], cfg.chainId));
          return;
        }

        const variables = (body.variables ?? {}) as Record<string, unknown>;
        const operationName =
          typeof body.operationName === "string" ? body.operationName : undefined;

        const plan = translate(body.query, variables, cfg.chainId, operationName);
        const upstream = await client.execute(plan.query, plan.variables);

        // Hasura's own errors pass through verbatim — rewording them either
        // destroys or fabricates a match against the backend's retry heuristic.
        if (upstream.errors?.length) {
          send(res, 200, { errors: upstream.errors });
          return;
        }
        if (!upstream.data) {
          send(res, 200, errorBody([new InternalError("upstream returned no data")], cfg.chainId));
          return;
        }

        const data = await postProcess(plan.shape, upstream.data, {
          ids,
          chainId: cfg.chainId,
          loadTokens: (list) => client.loadTokens(list),
          warn: (m) => console.warn(m),
        });
        send(res, 200, { data });
      } catch (e) {
        if (isProxyError(e)) {
          const headers =
            e instanceof UpstreamTransportError && e.retryAfter
              ? { "retry-after": e.retryAfter }
              : {};
          send(res, e.httpStatus, errorBody([e], cfg.chainId), headers);
          return;
        }
        console.error("envio-graph-proxy: unhandled", e);
        send(res, 500, errorBody([new InternalError(String(e))], cfg.chainId));
      }
    })();
  });
}
