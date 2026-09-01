/*
 * The only module that touches the database.
 *
 * Its own small connection pool, deliberately separate from the indexer's
 * writer pool (ENVIO_PG_MAX_CONNECTIONS defaults to 2) so read traffic can
 * never starve indexing.
 */

import postgres from "postgres";

import type { GraphApiConfig } from "./config.js";
import { UpstreamTransportError } from "./errors.js";
import type { Row } from "./postprocess.js";
import type { ListPlan } from "./shape.js";
import { ident, ParamBag } from "./sql-util.js";

export class Db {
  private readonly sql: postgres.Sql;

  constructor(private readonly cfg: GraphApiConfig) {
    this.sql = postgres({
      host: cfg.pg.host,
      port: cfg.pg.port,
      user: cfg.pg.user,
      password: cfg.pg.password,
      database: cfg.pg.database,
      max: cfg.pg.max,
      // Leave numeric as the exact string postgres.js already gives us. Any
      // transform here would be a precision bug on uint256 values.
      prepare: true,
      onnotice: () => {},
    });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  private async run(text: string, params: readonly unknown[]): Promise<Row[]> {
    try {
      // Every statement this emitter produces binds at least a LIMIT, so the
      // extended protocol is always used and Postgres itself refuses
      // multi-statement payloads (SQLSTATE 42601).
      const rows = await this.sql.unsafe(text, params as never[]);
      return rows as unknown as Row[];
    } catch (e) {
      const err = e as { code?: string; message?: string };
      throw new UpstreamTransportError(
        `indexer database error${err.code ? ` (${err.code})` : ""}: ${err.message ?? String(e)}`,
        502,
      );
    }
  }

  query(text: string, params: readonly unknown[]): Promise<Row[]> {
    return this.run(text, params);
  }

  /**
   * Batched nested-list fetch.
   *
   * ONE windowed query for the whole page rather than a LATERAL per parent row.
   * envio does not create the declared @index directives until finalizeBackfill,
   * so during a backfill every strategy is a sequential scan — and one scan for
   * the page beats one scan per parent.
   */
  async loadList(plan: ListPlan, parentIds: readonly string[]): Promise<Map<string, Row[]>> {
    const bag = new ParamBag();
    const fk = ident(plan.fkColumn);
    const cols = [...new Set([...plan.columns, fk])].join(", ");
    const idsParam = bag.addTextArray(parentIds);
    const limitParam = bag.add(plan.limit);
    const text =
      `SELECT * FROM (` +
      `SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY ${fk} ORDER BY ${plan.orderBy}) AS __rn ` +
      `FROM ${ident(this.cfg.schema)}.${ident(plan.entity)} ` +
      `WHERE ${fk} = ANY(${idsParam})` +
      `) t WHERE t.__rn <= ${limitParam}`;

    const rows = await this.run(text, bag.values);
    const out = new Map<string, Row[]>();
    for (const row of rows) {
      const key = String(row[plan.fkColumn]);
      const list = out.get(key);
      if (list) list.push(row);
      else out.set(key, [row]);
    }
    return out;
  }

  /** Batched Token primary-key lookup backing the Pool.token0/token1 stitch. */
  async loadTokens(envioIds: readonly string[]): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    const CHUNK = 1000;
    for (let i = 0; i < envioIds.length; i += CHUNK) {
      const bag = new ParamBag();
      const idsParam = bag.addTextArray(envioIds.slice(i, i + CHUNK));
      const limitParam = bag.add(CHUNK);
      const text =
        `SELECT "id", "chainId", "symbol", "name", "decimals", "totalSupply", "volume", ` +
        `"volumeUSD", "untrackedVolumeUSD", "feesUSD", "txCount", "poolCount", ` +
        `"totalValueLocked", "totalValueLockedUSD", "totalValueLockedUSDUntracked", "derivedETH" ` +
        `FROM ${ident(this.cfg.schema)}.${ident("Token")} ` +
        `WHERE "id" = ANY(${idsParam}) LIMIT ${limitParam}`;
      for (const row of await this.run(text, bag.values)) {
        out.set(String(row.id), row);
      }
    }
    return out;
  }

  /**
   * `_meta` inputs. progressBlock comes from envio's own view; the block
   * timestamp has no column anywhere, so it is the newest indexed event.
   */
  async loadMeta(): Promise<{ progressBlock: unknown; latestEventTimestamp: unknown }> {
    const s = ident(this.cfg.schema);
    const bag = new ParamBag();
    const chain = bag.add(this.cfg.chainId);
    const chainNum = bag.add(String(this.cfg.chainId));
    const text =
      `SELECT (SELECT "progressBlock" FROM ${s}."_meta" WHERE "chainId" = ${chain} LIMIT 1) AS "progressBlock", ` +
      `GREATEST(` +
      `COALESCE((SELECT MAX("timestamp") FROM ${s}."Swap" WHERE "chainId" = ${chainNum}::numeric), 0), ` +
      `COALESCE((SELECT MAX("timestamp") FROM ${s}."ModifyLiquidity" WHERE "chainId" = ${chainNum}::numeric), 0)` +
      `) AS "latestEventTimestamp"`;
    const rows = await this.run(text, bag.values);
    const row = rows[0] ?? {};
    return {
      progressBlock: row.progressBlock ?? null,
      latestEventTimestamp: row.latestEventTimestamp ?? null,
    };
  }
}
