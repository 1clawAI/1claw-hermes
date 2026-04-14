#!/usr/bin/env node
/**
 * Unified setup: finalize bootstrap → patch Hermes MCP → patch Hermes model
 * → install + start sidecar → health check.
 *
 * Usage:
 *   pnpm setup                           # defaults: google provider
 *   pnpm setup --provider openai         # different upstream
 *   pnpm setup --model gpt-4o            # also set the model name in Hermes
 *   pnpm setup --no-sidecar              # skip sidecar start (MCP + model patch only)
 *   pnpm setup --hermes-dir ~/.hermes    # custom Hermes config dir
 */
import { parseArgs } from "node:util";
import * as fs from "node:fs";
import {
  completeBootstrapFromEnv,
  ensureAgentIdInDotEnv,
  parseDotEnv,
} from "./bootstrap.js";
import { resolveDotEnvPath } from "./dotenv-path.js";
import { patchHermesConfig, patchHermesModel } from "./mcp/hermes-config.js";
import { startSidecarAndWait } from "./shroud/sidecar.js";

function log(msg: string): void {
  process.stderr.write(`[setup] ${msg}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "google" },
      model: { type: "string" },
      "hermes-dir": { type: "string", default: "~/.hermes" },
      "env-path": { type: "string" },
      "no-sidecar": { type: "boolean", default: false },
      "sidecar-port": { type: "string", default: "8080" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    process.stderr.write(`
Usage: pnpm setup [options]

Options:
  --provider <name>       Upstream LLM provider (default: google)
  --model <name>          Model name for Hermes (e.g. google/gemini-2.5-flash)
  --hermes-dir <path>     Hermes config directory (default: ~/.hermes)
  --env-path <path>       Path to .env (else ONECLAW_ENV_FILE, else cwd walk, else package .env)
  --no-sidecar            Only patch configs; don't start the sidecar
  --sidecar-port <port>   Sidecar listen port (default: 8080)
  -h, --help              Show this help

What this does:
  1. Reads credentials from .env (run 'pnpm bootstrap' first)
  2. Patches ~/.hermes/config.yaml with 1Claw MCP (stdio)
  3. Patches ~/.hermes/config.yaml model.provider=custom, base_url=localhost sidecar
  4. Installs shroud-sidecar binary (if not found)
  5. Starts the sidecar + waits for health check
  6. Hermes talks to sidecar → sidecar talks to Shroud → Shroud talks to LLM
`);
    process.exit(0);
  }

  const envPath = resolveDotEnvPath({ explicit: values["env-path"] });
  const hermesDir = values["hermes-dir"]!;
  const provider = values.provider!;
  const port = values["sidecar-port"]!;
  const noSidecar = values["no-sidecar"]!;

  // ── Step 1: Ensure bootstrap is complete ──
  log("Step 1/4: Checking bootstrap credentials...");
  if (!fs.existsSync(envPath)) {
    process.stderr.write(
      `\nNo .env found at ${envPath}. Run this first:\n` +
        `  pnpm bootstrap --email you@example.com --name my-agent\n\n`,
    );
    process.exit(1);
  }
  const envVars = parseDotEnv(fs.readFileSync(envPath, "utf-8"));
  if (!envVars.ONECLAW_AGENT_API_KEY?.startsWith("ocv_")) {
    process.stderr.write(
      `\nONECLAW_AGENT_API_KEY not set in ${envPath}. Complete bootstrap first:\n` +
        `  pnpm bootstrap:complete\n\n`,
    );
    process.exit(1);
  }

  if (!envVars.ONECLAW_VAULT_ID) {
    log("Vault ID not in .env — running bootstrap complete to auto-discover...");
    await completeBootstrapFromEnv({ envPath, shroudProvider: provider });
  } else {
    log(`Credentials OK (agent key: ${envVars.ONECLAW_AGENT_API_KEY.slice(0, 12)}…)`);
  }

  await ensureAgentIdInDotEnv(envPath);

  // Reload env into process so config.ts picks it up
  const freshEnv = parseDotEnv(fs.readFileSync(envPath, "utf-8"));
  for (const [k, v] of Object.entries(freshEnv)) {
    if (v) process.env[k] = v;
  }

  // ── Step 2: Patch Hermes MCP (stdio) ──
  log("Step 2/4: Patching Hermes MCP config (stdio @1claw/mcp)...");
  await patchHermesConfig(hermesDir);
  log("MCP patched → mcp_servers.oneclaw");

  // ── Step 3: Patch Hermes model to point at sidecar ──
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  log(`Step 3/4: Patching Hermes model → provider: custom, base_url: ${baseUrl}`);
  await patchHermesModel(hermesDir, {
    sidecarBaseUrl: baseUrl,
    model: values.model,
  });
  log("Model patched");

  if (noSidecar) {
    log("Done (--no-sidecar). Start the sidecar separately: pnpm shroud");
    process.exit(0);
  }

  // ── Step 4: Start sidecar ──
  log(`Step 4/4: Starting shroud-sidecar on :${port} (provider: ${provider})...`);
  const child = await startSidecarAndWait({
    provider,
    listenAddr: `:${port}`,
    envPath,
  });

  log("All set! Open Hermes and run /reload-mcp to pick up the new config.");
  log("Press Ctrl+C to stop the sidecar.\n");

  const shutdown = () => {
    log("Stopping sidecar...");
    child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
