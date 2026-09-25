import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type Config } from "../config.js";
import { patchHermesConfig, patchHermesModel } from "../mcp/hermes-config.js";

export interface RuntimeSetupOptions {
  hermesConfigDir?: string;
  jwt?: string;
  vaultId?: string;
  shroudEnabled?: boolean;
  llmProvider?: string;
  llmModel?: string;
}

function resolveHermesDir(configDir?: string): string {
  const raw = configDir ?? process.env.HERMES_CONFIG_DIR ?? "~/.hermes";
  if (path.isAbsolute(raw)) return raw;
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

function resolveSidecarBaseUrl(shroudEnabled: boolean): string {
  if (shroudEnabled) {
    return "http://127.0.0.1:8082/v1";
  }
  const openaiBase = (process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  if (openaiBase) {
    return openaiBase.endsWith("/v1") ? openaiBase : `${openaiBase}/v1`;
  }
  const shroud = (process.env.ONECLAW_SHROUD_URL || "https://shroud.1claw.co").replace(
    /\/$/,
    "",
  );
  return `${shroud}/v1`;
}

function resolveModelName(
  provider?: string,
  model?: string,
): string | undefined {
  const p =
    provider ||
    process.env.LLM_PROVIDER ||
    process.env.ONECLAW_DEFAULT_PROVIDER ||
    process.env.SHROUD_PROVIDER;
  const m =
    model ||
    process.env.LLM_MODEL ||
    process.env.ONECLAW_DEFAULT_MODEL;
  if (p && m) return `${p}/${m}`;
  return m || undefined;
}

/**
 * Apply 1Claw ↔ Hermes integration inside a cloud runtime container.
 * Uses injected ONECLAW_AGENT_TOKEN (JWT) when no ocv_ key is present.
 */
export async function setupHermesRuntime(
  options: RuntimeSetupOptions = {},
): Promise<{ hermesConfigDir: string; sidecarBaseUrl: string }> {
  const cfg = loadConfig();
  const hermesDir = resolveHermesDir(options.hermesConfigDir);

  const jwt =
    options.jwt ||
    process.env.ONECLAW_AGENT_TOKEN ||
    process.env.ONECLAW_TOKEN ||
    cfg.oneClawAgentToken;
  const vaultId =
    options.vaultId ||
    process.env.ONECLAW_VAULT_ID ||
    cfg.oneClawVaultId;

  if (!vaultId) {
    throw new Error(
      "ONECLAW_VAULT_ID is required for runtime setup (bind an agent with vault access).",
    );
  }

  const shroudEnabled =
    options.shroudEnabled ??
    (process.env.ONECLAW_SHROUD_ENABLED === "1" ||
      process.env.ONECLAW_SHROUD_ENABLED === "true");

  // Prefer stdio when an ocv_ API key is available — stdio auto-refreshes
  // tokens on each tool call, avoiding JWT expiry on long-running gateways.
  const hasApiKey = Boolean(
    process.env.ONECLAW_AGENT_API_KEY && !process.env.ONECLAW_AGENT_API_KEY.startsWith("eyJ"),
  );

  if (hasApiKey) {
    await patchHermesConfig(hermesDir, { transport: "stdio" });
  } else if (jwt) {
    await patchHermesConfig(hermesDir, { transport: "http", jwt, vaultId });
  } else {
    await patchHermesConfig(hermesDir, { transport: "stdio" });
  }

  // Credential the custom (Shroud) provider sends as its Bearer token. Prefer a
  // long-lived ocv_ agent key when one is present (Shroud re-exchanges it as the
  // minted JWT expires); otherwise fall back to the injected agent JWT, which
  // Shroud verifies directly. Without this the custom endpoint has no usable
  // credential and Shroud answers 401.
  const ocvKey =
    process.env.ONECLAW_AGENT_API_KEY &&
    !process.env.ONECLAW_AGENT_API_KEY.startsWith("eyJ")
      ? process.env.ONECLAW_AGENT_API_KEY
      : "";
  const modelApiKey = ocvKey || jwt || "";

  // Shroud requires an X-Shroud-Provider header naming the upstream. Prefer an
  // explicitly-injected provider hint (same env the dashboard bridge reads:
  // LLM_PROVIDER / ONECLAW_DEFAULT_PROVIDER, plus the Shroud-specific vars);
  // patchHermesModel falls back to deriving it from the model id when unset.
  const shroudProvider =
    options.llmProvider ||
    process.env.ONECLAW_SHROUD_PROVIDER ||
    process.env.LLM_PROVIDER ||
    process.env.ONECLAW_DEFAULT_PROVIDER ||
    process.env.SHROUD_PROVIDER ||
    undefined;

  const sidecarBaseUrl = resolveSidecarBaseUrl(shroudEnabled);
  await patchHermesModel(hermesDir, {
    sidecarBaseUrl,
    model: resolveModelName(options.llmProvider, options.llmModel),
    apiKey: modelApiKey,
    shroudProvider,
  });

  return { hermesConfigDir: hermesDir, sidecarBaseUrl };
}

export function runtimeCredentialsReady(cfg?: Config): boolean {
  const c = cfg ?? loadConfig();
  const hasAuth = Boolean(c.oneClawAgentApiKey || c.oneClawAgentToken);
  return hasAuth && Boolean(c.oneClawVaultId);
}
