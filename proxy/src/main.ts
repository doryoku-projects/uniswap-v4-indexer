import { loadConfig } from "./config.js";
import { createProxyServer } from "./server.js";

const cfg = loadConfig();
createProxyServer(cfg).listen(cfg.port, () => {
  console.log(
    `envio-graph-proxy: chain ${cfg.chainId} on :${cfg.port} -> ${cfg.hasuraUrl}`,
  );
});
