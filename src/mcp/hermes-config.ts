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
   * `http`: remote `mcp.1claw.co` with Bearer JWT (short-lived; re-run patch when 401).
   */
  transport?: HermesMcpTransport;
  /** Pre-exchanged JWT for cloud runtimes (skips ocv_ token exchange). */
  jwt?: string;
  /** Required when `jwt` is set. */
  vaultId?: string;
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
  const resolved = resolveHermesDir(configDir);

  await fs.promises.mkdir(resolved, { recursive: true });

  const yamlPath = path.join(resolved, "config.yaml");
  const jsonPath = path.join(resolved, "config.json");

  let entry: Record<string, unknown>;
  if (options.jwt) {
    const vaultId = options.vaultId ?? requireVaultId();
    entry = { ...buildHermesMcpServerEntry(options.jwt, vaultId) };
  } else if ((options.transport ?? "stdio") === "stdio") {
    entry = buildHermesStdioMcpEntry();
  } else {
    entry = { ...(await buildHttpEntryFromExchange()) };
  }

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

/** Header Shroud's authenticated `POST /v1/chat/completions` requires to name the upstream. */
export const SHROUD_PROVIDER_HEADER = "X-Shroud-Provider";

/**
 * Best-effort map of a model identifier to the Shroud upstream provider name.
 * Accepts either a bare model id (`claude-opus-4.6`) or a `provider/model`
 * slug (`anthropic/claude-opus-4.6`). Returns `undefined` when it cannot tell —
 * callers should prefer an explicitly-configured provider over this guess.
 */
export function providerForModel(model?: string): string | undefined {
  if (!model) return undefined;
  const raw = model.trim().toLowerCase();
  if (!raw) return undefined;

  const known = new Set([
    "anthropic",
    "openai",
    "google",
    "mistral",
    "cohere",
    "openrouter",
  ]);

  // `provider/model` slug: trust a recognised prefix, otherwise map the tail.
  const slash = raw.indexOf("/");
  const prefix = slash > 0 ? raw.slice(0, slash) : "";
  if (prefix && known.has(prefix)) return prefix;
  const name = slash > 0 ? raw.slice(slash + 1) : raw;

  if (name.startsWith("claude")) return "anthropic";
  if (
    name.startsWith("gpt") ||
    name.startsWith("o1") ||
    name.startsWith("o3") ||
    name.startsWith("o4") ||
    name.startsWith("chatgpt")
  ) {
    return "openai";
  }
  if (name.startsWith("gemini")) return "google";
  if (
    name.startsWith("mistral") ||
    name.startsWith("mixtral") ||
    name.startsWith("codestral")
  ) {
    return "mistral";
  }
  if (name.startsWith("command")) return "cohere";
  return undefined;
}

export interface PatchHermesModelOptions {
  /** Sidecar listen address (default: `http://127.0.0.1:8080/v1`). */
  sidecarBaseUrl?: string;
  /** Model identifier Hermes should use (e.g. `google/gemini-2.5-flash`). */
  model?: string;
  /**
   * Credential Hermes' `custom` (OpenAI-compatible) provider sends to the
   * 1Claw/Shroud LLM gateway as its `Authorization: Bearer` token. Shroud
   * accepts a pre-minted agent JWT directly, or an `ocv_` agent key / router
   * key it exchanges. Without it Hermes has no credential for the custom
   * endpoint and Shroud answers 401 ("invalid agent key: expected an
   * sk-shroud-v1 router key, an ocv_ agent key, or agent_id:api_key").
   */
  apiKey?: string;
  /**
   * Upstream provider Shroud forwards to, written as the `X-Shroud-Provider`
   * header on the `custom` provider's requests (`model.extra_headers`).
   * Shroud's authenticated `POST /v1/chat/completions` REQUIRES this header
   * (`openai`, `anthropic`, `google`, `mistral`, `cohere`, `openrouter`, …);
   * missing → `HTTP 400: missing X-Shroud-Provider header`. When omitted,
   * {@link patchHermesModel} derives it from {@link PatchHermesModelOptions.model}
   * via {@link providerForModel}; when neither yields a value no header is
   * written (nothing to guess with).
   */
  shroudProvider?: string;
}

/**
 * Patch Hermes `config.yaml` so `model.provider = "custom"`,
 * `model.base_url` points at the 1Claw/Shroud LLM gateway, `model.api_key`
 * carries the injected agent credential Shroud authenticates, and
 * `model.extra_headers` carries the `X-Shroud-Provider` header Shroud requires
 * to name the upstream.
 *
 * Only touches `model.provider`, `model.base_url`, and (when derivable)
 * `model.api_key` / `model.extra_headers["X-Shroud-Provider"]` — all other
 * model settings (name, temperature, existing headers, etc.) are preserved.
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

  // Hermes' `custom` provider reads `model.api_key` inline (built-in providers
  // resolve creds from env/auth instead). Without it the custom endpoint has no
  // usable credential and Shroud rejects the request with 401. Only write a
  // non-empty value so we never clobber an existing key with a blank.
  if (options.apiKey && options.apiKey.trim()) {
    modelSection.api_key = options.apiKey.trim();
  }

  // Shroud's authenticated /v1/chat/completions requires an X-Shroud-Provider
  // header naming the upstream; missing → "HTTP 400: missing X-Shroud-Provider
  // header" before the model runs. Hermes' `custom` provider forwards
  // `model.extra_headers` verbatim on every LLM request and preserves them
  // across `/model` switches and client rebuilds, so that is where it belongs.
  // Prefer an explicitly-configured provider; otherwise derive it from the
  // model id. NOTE: the header is static per config write — if the operator
  // switches to a model from a *different* upstream via `/model` without a
  // re-patch, this value can go stale (documented limitation).
  const shroudProvider =
    (options.shroudProvider && options.shroudProvider.trim().toLowerCase()) ||
    providerForModel(options.model);
  if (shroudProvider) {
    const existingHeaders =
      (modelSection.extra_headers as Record<string, unknown> | undefined) ?? {};
    modelSection.extra_headers = {
      ...existingHeaders,
      [SHROUD_PROVIDER_HEADER]: shroudProvider,
    };
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
    // The api_key we injected is only meaningful for the custom Shroud
    // endpoint; leaving it behind would leak a stale credential onto whatever
    // provider Hermes falls back to.
    delete modelSection.api_key;
    // Likewise the X-Shroud-Provider header only makes sense for the Shroud
    // endpoint; strip it (and an emptied extra_headers map) so it does not ride
    // along to the fallback provider. Preserve any other headers the user set.
    const headers = modelSection.extra_headers as
      | Record<string, unknown>
      | undefined;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      delete headers[SHROUD_PROVIDER_HEADER];
      if (Object.keys(headers).length === 0) {
        delete modelSection.extra_headers;
      } else {
        modelSection.extra_headers = headers;
      }
    }
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
