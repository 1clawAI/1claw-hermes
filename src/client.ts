import { createClient, type OneclawClient } from "@1claw/sdk";
import { config } from "./config.js";

let _client: OneclawClient | null = null;

/**
 * Returns a singleton OneclawClient that auto-exchanges the agent API key
 * for a short-lived JWT and refreshes it before expiry.
 * The SDK's HttpClient handles token lifecycle internally.
 */
export function getClient(): OneclawClient {
  if (!_client) {
    _client = createClient({
      baseUrl: config.oneClawApiBase,
      apiKey: config.oneClawAgentApiKey,
    });
  }
  return _client;
}

/**
 * Create a scoped client for a specific agent identity (e.g. a subagent).
 * Uses a pre-exchanged JWT rather than an API key.
 */
export function createScopedClient(token: string): OneclawClient {
  return createClient({
    baseUrl: config.oneClawApiBase,
    token,
  });
}
