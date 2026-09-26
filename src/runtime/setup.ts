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

/**
 * Is this base URL a destination that may be handed a 1Claw credential?
 *
 * Only two things qualify: the sidecar listening on loopback inside this very
 * container, and 1Claw's own Shroud. Everything else — including a perfectly
 * reasonable `OPENAI_BASE_URL=https://openrouter.ai/api/v1` — is a third party,
 * and a third party must never receive the agent's vault token.
 *
 * The host list is deliberately hardcoded rather than read from an env var.
 * `OPENAI_BASE_URL` and `ONECLAW_SHROUD_URL` are both tenant-settable, so
 * deriving "is this ours?" from the environment would just restate the bug in
 * another variable: a configurable base is not a host pin.
 */
export function baseUrlMayHold1ClawCredential(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }

  // The in-container sidecar. Loopback only — a LAN address is someone else's
  // machine, and `localhost` can be re-pointed by /etc/hosts.
  if (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]") {
    return true;
  }

  // 1Claw's own Shroud, over TLS. Suffix match is anchored on a dot so that
  // `shroud.1claw.co.evil.example` and `not1claw.co` both fail.
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return ONECLAW_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

const ONECLAW_DOMAINS = ["1claw.co", "1claw.xyz"];

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
  const oneClawCredential = ocvKey || jwt || "";

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

  // Which key the provider sends depends on *where it is sending it*, not on
  // whether Shroud is enabled. With Shroud off, the base URL comes from the
  // tenant's own `OPENAI_BASE_URL`; attaching the agent's vault credential to
  // that would hand a third-party host a token with the agent's scopes.
  // Such a host gets the tenant's own provider key, which is what it expects
  // anyway — the previous behaviour silently replaced that key with a JWT the
  // host could not use, so this fixes the benign misconfiguration too.
  const sendsTo1Claw = baseUrlMayHold1ClawCredential(sidecarBaseUrl);
  const modelApiKey = sendsTo1Claw
    ? oneClawCredential
    : process.env.OPENAI_API_KEY || "";

  if (!sendsTo1Claw && oneClawCredential) {
    // `sidecarBaseUrl` may be unparseable — that is one of the ways
    // `baseUrlMayHold1ClawCredential` returns false — so don't re-parse it here.
    console.warn(
      `[1claw] OPENAI_BASE_URL points at ${sidecarBaseUrl}, which is not ` +
        `1Claw — sending your OPENAI_API_KEY instead of the agent credential. ` +
        `Enable Shroud on this agent to route LLM traffic through 1Claw.`,
    );
  }

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
