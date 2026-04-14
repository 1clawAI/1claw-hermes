import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { config, requireVaultId, requireApiKey } from "../config.js";
import { getClient } from "../client.js";
import { VaultError } from "../errors.js";

/** Hermes `mcp_servers` key; tools appear as `mcp_oneclaw_*`. */
export const HERMES_ONECLAW_SERVER_KEY = "oneclaw";

export interface HermesHttpMcpEntry {
  url: string;
  headers: Record<string, string>;
  timeout: number;
  connect_timeout: number;
}

export function buildHermesMcpServerEntry(
  jwt: string,
  vaultId: string,
): HermesHttpMcpEntry {
  return {
    url: config.oneClawMcpUrl,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "X-Vault-ID": vaultId,
    },
    timeout: 120,
    connect_timeout: 60,
  };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, content, "utf-8");
  await fs.promises.rename(tmpPath, filePath);
}

function backupFile(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) return Promise.resolve();
  const backupPath = `${filePath}.bak.${Date.now()}`;
  return fs.promises.copyFile(filePath, backupPath);
}

function resolveHermesDir(configDir: string): string {
  if (path.isAbsolute(configDir)) return configDir;
  if (configDir.startsWith("~/")) {
    return path.join(os.homedir(), configDir.slice(2));
  }
  return path.resolve(configDir);
}

async function patchYaml(
  yamlPath: string,
  entry: HermesHttpMcpEntry,
): Promise<void> {
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(yamlPath)) {
    const raw = await fs.promises.readFile(yamlPath, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  }

  const mcpServers =
    (doc.mcp_servers as Record<string, unknown> | undefined) ?? {};
  doc.mcp_servers = {
    ...mcpServers,
    [HERMES_ONECLAW_SERVER_KEY]: entry,
  };

  const out = stringifyYaml(doc, { lineWidth: 100 });
  await atomicWrite(yamlPath, out.endsWith("\n") ? out : `${out}\n`);
}

async function patchJson(
  jsonPath: string,
  entry: HermesHttpMcpEntry,
): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(jsonPath, "utf-8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    existing = {};
  }

  const mcpServers =
    (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  const merged = {
    ...existing,
    mcpServers: {
      ...mcpServers,
      [HERMES_ONECLAW_SERVER_KEY]: entry,
    },
  };

  await atomicWrite(jsonPath, JSON.stringify(merged, null, 2));
}

/**
 * Merge 1Claw MCP into Hermes config. Prefers `~/.hermes/config.yaml` (Hermes
 * native); falls back to `config.json` if only that exists.
 *
 * Uses a **JWT** from `POST /v1/auth/agent-token` in `Authorization` — not the
 * raw `ocv_` API key. The MCP server also requires `X-Vault-ID`.
 */
export async function patchHermesConfig(configDir: string): Promise<void> {
  const resolved = resolveHermesDir(configDir);

  await fs.promises.mkdir(resolved, { recursive: true });

  const yamlPath = path.join(resolved, "config.yaml");
  const jsonPath = path.join(resolved, "config.json");

  const client = getClient();
  const tokenResponse = await client.auth.agentToken({
    api_key: requireApiKey(),
  });

  if (tokenResponse.error || !tokenResponse.data) {
    throw new VaultError(
      "TOKEN_EXCHANGE_FAILED",
      tokenResponse.error?.message ?? "Failed to exchange agent token",
    );
  }

  const entry = buildHermesMcpServerEntry(
    tokenResponse.data.access_token,
    requireVaultId(),
  );

  if (fs.existsSync(yamlPath)) {
    await backupFile(yamlPath);
    await patchYaml(yamlPath, entry);
    return;
  }

  if (fs.existsSync(jsonPath)) {
    await backupFile(jsonPath);
    await patchJson(jsonPath, entry);
    return;
  }

  await patchYaml(yamlPath, entry);
}
