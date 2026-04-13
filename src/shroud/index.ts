import OpenAI from "openai";
import { config } from "../config.js";

/**
 * Returns an OpenAI-compatible client pointed at the Shroud TEE proxy.
 * Use exactly like the standard OpenAI client — Shroud intercepts
 * the request, redacts secrets/PII, scores for injection, then
 * forwards to the upstream provider specified in the config.
 */
export function createShroudClient(): OpenAI {
  return new OpenAI({
    baseURL: config.shroudUrl,
    apiKey: config.shroudToken,
    defaultHeaders: {
      "X-Shroud-Provider": config.shroudProvider,
    },
  });
}
