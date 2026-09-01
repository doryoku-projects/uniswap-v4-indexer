/*
 * envio ships no types for its ReScript-generated internals, but it also has no
 * `exports` map, so deep imports resolve. `EnvioGlobal.value.persistence` is the
 * only reliable way for handler-loaded code to tell a real indexing run from
 * createTestIndexer, which never sets it.
 */
declare module "envio/src/EnvioGlobal.res.mjs" {
  export const value: { persistence?: unknown; indexerState?: unknown } | undefined;
}
