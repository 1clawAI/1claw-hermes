import { z } from "zod";
import { ConfigError } from "./errors.js";

const schema = z.object({
  oneClawApiBase: z.string().url().default("https://api.1claw.xyz"),
  oneClawVaultId: z.string().uuid().optional(),
  oneClawAgentApiKey: z.string().startsWith("ocv_").optional(),
  oneClawMcpUrl: z.string().url().default("https://mcp.1claw.xyz/mcp"),
  oneClawMcpToken: z.string().optional(),
  shroudUrl: z.string().url().default("https://shroud.1claw.xyz/v1"),
  shroudToken: z.string().optional(),
  shroudProvider: z
    .enum(["anthropic", "openai", "google", "mistral", "cohere"])
    .default("anthropic"),
  hermesConfigDir: z.string().default("~/.hermes"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(
  overrides: Partial<Record<string, string>> = {},
): Config {
  const raw = { ...process.env, ...overrides };
  const result = schema.safeParse({
    oneClawApiBase: raw.ONECLAW_API_BASE,
    oneClawVaultId: raw.ONECLAW_VAULT_ID,
    oneClawAgentApiKey: raw.ONECLAW_AGENT_API_KEY,
    oneClawMcpUrl: raw.ONECLAW_MCP_URL,
    oneClawMcpToken: raw.ONECLAW_MCP_TOKEN,
    shroudUrl: raw.SHROUD_URL,
    shroudToken: raw.SHROUD_TOKEN,
    shroudProvider: raw.SHROUD_PROVIDER,
    hermesConfigDir: raw.HERMES_CONFIG_DIR,
  });

  if (!result.success) {
    const missing = result.error.issues.map(
      (i) => `  ${i.path.join(".")}: ${i.message}`,
    );
    throw new ConfigError(
      `Invalid configuration:\n${missing.join("\n")}`,
    );
  }

  return Object.freeze(result.data);
}

/**
 * Returns true when the minimum credentials for operation are missing.
 * Use this to decide whether to run the bootstrap flow at startup.
 */
export function needsBootstrap(cfg?: Config): boolean {
  const c = cfg ?? config;
  return !c.oneClawAgentApiKey;
}

/**
 * Runtime assertion — throws ConfigError if vaultId is not configured.
 * Call this in modules that require a vault (secrets, MCP, subagents).
 */
export function requireVaultId(cfg?: Config): string {
  const c = cfg ?? config;
  if (!c.oneClawVaultId) {
    throw new ConfigError(
      "ONECLAW_VAULT_ID is required but not set. Run `pnpm bootstrap` to configure.",
    );
  }
  return c.oneClawVaultId;
}

/**
 * Runtime assertion for API key — throws ConfigError if missing.
 */
export function requireApiKey(cfg?: Config): string {
  const c = cfg ?? config;
  if (!c.oneClawAgentApiKey) {
    throw new ConfigError(
      "ONECLAW_AGENT_API_KEY is required but not set. Run `pnpm bootstrap` to configure.",
    );
  }
  return c.oneClawAgentApiKey;
}

export const config: Config = loadConfig();
