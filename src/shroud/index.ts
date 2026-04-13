import OpenAI from "openai";
import { config } from "../config.js";
import { ConfigError } from "../errors.js";

/**
 * Returns an OpenAI-compatible client pointed at the Shroud TEE proxy.
 * Use exactly like the standard OpenAI client — Shroud intercepts
 * the request, redacts secrets/PII, scores for injection, then
 * forwards to the upstream provider specified in the config.
 */
export function createShroudClient(): OpenAI {
  const token = config.shroudToken ?? config.oneClawAgentApiKey;
  if (!token) {
    throw new ConfigError(
      "SHROUD_TOKEN or ONECLAW_AGENT_API_KEY is required. Run `pnpm bootstrap` to configure.",
    );
  }

  return new OpenAI({
    baseURL: config.shroudUrl,
    apiKey: token,
    defaultHeaders: {
      "X-Shroud-Provider": config.shroudProvider,
    },
  });
}
