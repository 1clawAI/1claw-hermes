#!/usr/bin/env node
/**
 * Cloud runtime entrypoint for Hermes + 1Claw integration.
 * Patches ~/.hermes config (MCP + model) from ONECLAW_* env injected by Vault.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { runtimeCredentialsReady, setupHermesRuntime } from "./runtime/setup.js";

function log(msg: string): void {
  process.stderr.write(`[1claw-hermes-runtime] ${msg}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    process.stderr.write(`
Usage: 1claw-hermes-runtime-start

Patches Hermes config for 1Claw MCP + LLM routing using runtime env:
  ONECLAW_AGENT_TOKEN / ONECLAW_TOKEN (JWT from Vault at start)
  ONECLAW_VAULT_ID, ONECLAW_AGENT_ID
  ONECLAW_SHROUD_ENABLED, LLM_PROVIDER, LLM_MODEL

Called by /app/hermes-agent-start.sh before \`hermes gateway\`.
Dashboard chat stays on chat-bridge (USER_PORT); this wires the Hermes agent process.
`);
    process.exit(0);
  }

  if (!runtimeCredentialsReady()) {
    log(
      "WARN: missing ONECLAW_VAULT_ID or auth token — skipping Hermes integration patch",
    );
    process.exit(0);
  }

  const cfg = loadConfig();
  const result = await setupHermesRuntime({
    jwt: cfg.oneClawAgentToken,
    vaultId: cfg.oneClawVaultId,
  });

  log(`Patched Hermes config at ${result.hermesConfigDir}`);
  log(`Model base_url → ${result.sidecarBaseUrl}`);
  log("Run /reload-mcp in Hermes after first start if MCP tools are missing.");
}

main().catch((err: unknown) => {
  console.error(
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
