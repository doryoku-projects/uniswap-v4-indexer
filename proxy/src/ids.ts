/*
 * Bidirectional id translation between the vanilla subgraph's id formats and
 * this Envio indexer's.
 *
 * Envio is multi-chain on one endpoint and config.yaml sets no
 * `disable_default_cross_chain`, so every id carries a `<chainId>_` prefix.
 * A subgraph is single-chain and its ids do not. One proxy process serves one
 * chain, which makes the whole mapping a pure string transform.
 *
 *   entity        subgraph id              envio id
 *   Pool          0xabc…                   1_0xabc…
 *   Token         0xdef…                   1_0xdef…
 *   Tick          0xabc…#-887220           1_0xabc…#-887220
 *   *DayData      0xabc…-20468             1_0xabc…_20468
 *   *HourData     0xabc…-491244            1_0xabc…_491244
 *   Bundle        1                        <chainId>
 */

import { TranslationError, UpstreamShapeError } from "./errors.js";

export type IdClass = "pool" | "token" | "tick" | "interval" | "bundle" | "opaque";

export interface IdCodec {
  /** subgraph value -> envio value */
  inbound(value: string, cls: IdClass): string;
  /** envio value -> subgraph value */
  outbound(value: string, cls: IdClass): string;
}

export function makeIdCodec(chainId: number): IdCodec {
  const prefix = `${chainId}_`;

  function inbound(value: string, cls: IdClass): string {
    switch (cls) {
      case "opaque":
        return value;
      // Bundle.id IS the chain id in Envio (initialize-handler.ts:53). The
      // subgraph's canonical "1" is discarded rather than prefixed.
      case "bundle":
        return String(chainId);
      case "pool":
      case "token":
      case "tick":
        return prefix + value;
      case "interval": {
        // The historical pricing provider seeds its cursor with "" on page 1.
        if (value === "") return "";
        const i = value.lastIndexOf("-");
        if (i <= 0 || i === value.length - 1) {
          throw new TranslationError(
            `malformed interval id ${JSON.stringify(value)}: expected <parent>-<periodIndex>`,
          );
        }
        return `${prefix}${value.slice(0, i)}_${value.slice(i + 1)}`;
      }
    }
  }

  function outbound(value: string, cls: IdClass): string {
    if (cls === "opaque") return value;
    if (cls === "bundle") return "1";
    if (!value.startsWith(prefix)) {
      throw new UpstreamShapeError(
        `id ${JSON.stringify(value)} lacks the chain-${chainId} prefix`,
      );
    }
    const bare = value.slice(prefix.length);
    if (cls === "pool" || cls === "token") return bare.toLowerCase();
    if (cls === "tick") return bare;
    const i = bare.lastIndexOf("_");
    if (i <= 0 || i === bare.length - 1) {
      throw new UpstreamShapeError(
        `malformed envio interval id ${JSON.stringify(value)}`,
      );
    }
    return `${bare.slice(0, i)}-${bare.slice(i + 1)}`;
  }

  return { inbound, outbound };
}
