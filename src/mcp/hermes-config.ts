import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { config, requireVaultId, requireApiKey } from "../config.js";
import { getClient } from "../client.js";
import { VaultError } from "../errors.js";

/** Hermes `mcp_servers` key; tools appear as `mcp_oneclaw_*`. */
export const HERMES_ONECLAW_SERVER_KEY = "oneclaw";

/** Default: local stdio MCP — JWT refreshed inside the process (no expiring Bearer in YAML). */
export type HermesMcpTransport = "stdio" | "http";

export interface PatchHermesOptions {
  /**
   * `stdio` (default): `npx @1claw/mcp` with env-based `ocv_` auth; token exchange
   * runs inside the MCP process on every tool call (no JWT expiry in config).
   * `http`: remote `mcp.1claw.xyz` with Bearer JWT (short-lived; re-run patch when 401).
   */
  transport?: HermesMcpTransport;
}

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

/** Stdio entry: same pattern as Cursor / Claude Desktop — stable credentials in env. */
export function buildHermesStdioMcpEntry(): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", "@1claw/mcp"],
    env: {
      ONECLAW_BASE_URL: config.oneClawApiBase,
      ONECLAW_AGENT_API_KEY: requireApiKey(),
      ONECLAW_VAULT_ID: requireVaultId(),
    },
    timeout: 120,
    connect_timeout: 60,
  };
}

async function buildHttpEntryFromExchange(): Promise<HermesHttpMcpEntry> {
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

  return buildHermesMcpServerEntry(
    tokenResponse.data.access_token,
    requireVaultId(),
  );
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
  entry: Record<string, unknown>,
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
  entry: Record<string, unknown>,
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
 * Merge 1Claw MCP into Hermes config. Prefers `~/.hermes/config.yaml`; falls back
 * to `config.json` if only that exists.
 *
 * **Default (`transport: 'stdio'`)** runs the official `@1claw/mcp` package via
 * `npx` with `ONECLAW_AGENT_API_KEY` in `env` — the MCP client refreshes JWTs
 * automatically (no stale Bearer in YAML).
 *
 * **`transport: 'http'`** targets the hosted MCP URL with a short-lived JWT
 * (re-run when it expires).
 */
export async function patchHermesConfig(
  configDir: string,
  options: PatchHermesOptions = {},
): Promise<void> {
  const transport = options.transport ?? "stdio";
  const resolved = resolveHermesDir(configDir);

  await fs.promises.mkdir(resolved, { recursive: true });

  const yamlPath = path.join(resolved, "config.yaml");
  const jsonPath = path.join(resolved, "config.json");

  const entry =
    transport === "stdio"
      ? buildHermesStdioMcpEntry()
      : { ...(await buildHttpEntryFromExchange()) };

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

// ---------------------------------------------------------------------------
// Hermes model config patching (Shroud sidecar integration)
// ---------------------------------------------------------------------------

export interface PatchHermesModelOptions {
  /** Sidecar listen address (default: `http://127.0.0.1:8080/v1`). */
  sidecarBaseUrl?: string;
  /** Model identifier Hermes should use (e.g. `google/gemini-2.5-flash`). */
  model?: string;
}

/**
 * Patch Hermes `config.yaml` so `model.provider = "custom"` and
 * `model.base_url` points at the local Shroud sidecar.
 *
 * Only touches `model.provider` and `model.base_url` — all other model
 * settings (name, temperature, etc.) are preserved.
 */
export async function patchHermesModel(
  configDir: string,
  options: PatchHermesModelOptions = {},
): Promise<void> {
  const resolved = resolveHermesDir(configDir);
  await fs.promises.mkdir(resolved, { recursive: true });

  const yamlPath = path.join(resolved, "config.yaml");

  let doc: Record<string, unknown> = {};
  if (fs.existsSync(yamlPath)) {
    await backupFile(yamlPath);
    const raw = await fs.promises.readFile(yamlPath, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  }

  const modelSection =
    (doc.model as Record<string, unknown> | undefined) ?? {};

  modelSection.provider = "custom";
  modelSection.base_url =
    options.sidecarBaseUrl ?? "http://127.0.0.1:8080/v1";

  if (options.model) {
    modelSection.name = options.model;
  }

  doc.model = modelSection;

  const out = stringifyYaml(doc, { lineWidth: 100 });
  await atomicWrite(yamlPath, out.endsWith("\n") ? out : `${out}\n`);
}

/**
 * Revert `model.provider` and `model.base_url` to their previous values
 * by removing the custom overrides. Hermes will fall back to its own defaults
 * or the user's prior provider.
 */
export async function unpatchHermesModel(
  configDir: string,
): Promise<void> {
  const resolved = resolveHermesDir(configDir);
  const yamlPath = path.join(resolved, "config.yaml");

  if (!fs.existsSync(yamlPath)) return;

  await backupFile(yamlPath);
  const raw = await fs.promises.readFile(yamlPath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

  const doc = parsed as Record<string, unknown>;
  const modelSection = doc.model as Record<string, unknown> | undefined;
  if (!modelSection) return;

  if (modelSection.provider === "custom") {
    delete modelSection.provider;
  }
  if (
    typeof modelSection.base_url === "string" &&
    modelSection.base_url.includes("127.0.0.1")
  ) {
    delete modelSection.base_url;
  }

  doc.model = modelSection;
  const out = stringifyYaml(doc, { lineWidth: 100 });
  await atomicWrite(yamlPath, out.endsWith("\n") ? out : `${out}\n`);
}
