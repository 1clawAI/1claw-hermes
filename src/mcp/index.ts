import { config } from "../config.js";

export interface McpServerEntry {
  url: string;
  headers: { Authorization: string; "X-Vault-ID": string };
}

/**
 * Minimal MCP entry (JWT Bearer + vault header). For Hermes YAML, prefer
 * {@link buildHermesMcpServerEntry} which adds `timeout` / `connect_timeout`.
 */
export function buildMcpEntry(
  jwt: string,
  vaultId: string,
): McpServerEntry {
  return {
    url: config.oneClawMcpUrl,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "X-Vault-ID": vaultId,
    },
  };
}

export {
  patchHermesConfig,
  buildHermesMcpServerEntry,
  buildHermesStdioMcpEntry,
  HERMES_ONECLAW_SERVER_KEY,
  type HermesHttpMcpEntry,
  type PatchHermesOptions,
  type HermesMcpTransport,
} from "./hermes-config.js";
