#!/usr/bin/env node
/**
 * Runnable entry for the OpenAI-compatible SSE adapter for Hermes.
 *
 * Starts an HTTP server that exposes `POST /v1/chat/completions` on a loopback
 * port and bridges to Hermes via the {@link SubprocessHermesDriver}.
 *
 * The sibling `packages/runtime-base` worker owns wiring this in — it points its
 * generic "proxy-to-native" backend resolver at this adapter's URL. This entry
 * only reads env and binds the port; it deploys nothing and rebuilds nothing.
 *
 * Environment (all optional):
 *   ONECLAW_HERMES_NATIVE_PORT   Listen port (default 8778).
 *   ONECLAW_HERMES_NATIVE_HOST   Bind host (default 127.0.0.1 — loopback only).
 *   ONECLAW_HERMES_NATIVE_TOKEN  Bearer token; when set, requests must send
 *                                `Authorization: Bearer <token>`.
 *   ONECLAW_HERMES_NATIVE_MODEL  Default model echoed when a request omits one.
 *   ONECLAW_HERMES_CLI           `hermes` executable (default `hermes`).
 *   ONECLAW_HERMES_CLI_ARGS      JSON array of argv for the CLI (advanced).
 */
import {
  createAdapterServer,
  type AdapterOptions,
} from "./openai-sse-adapter.js";
import { SubprocessHermesDriver } from "./hermes-driver.js";

/** Default loopback port for the adapter (avoids 8080 sidecar / 8000 user port). */
export const ADAPTER_DEFAULT_PORT = 8778;
/** Loopback bind by default — the adapter is never exposed off-host directly. */
export const ADAPTER_DEFAULT_HOST = "127.0.0.1";

export interface AdapterEnvConfig {
  port: number;
  host: string;
  token?: string;
  defaultModel?: string;
  command?: string;
  args?: string[];
}

/** Resolve the adapter's runtime config from an env-like map. Pure; exported for tests. */
export function resolveAdapterEnv(
  env: NodeJS.ProcessEnv = process.env,
): AdapterEnvConfig {
  const portRaw = env.ONECLAW_HERMES_NATIVE_PORT;
  const parsedPort = portRaw ? Number.parseInt(portRaw, 10) : NaN;
  const port =
    Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536
      ? parsedPort
      : ADAPTER_DEFAULT_PORT;

  let args: string[] | undefined;
  if (env.ONECLAW_HERMES_CLI_ARGS) {
    try {
      const parsed = JSON.parse(env.ONECLAW_HERMES_CLI_ARGS);
      if (Array.isArray(parsed) && parsed.every((a) => typeof a === "string")) {
        args = parsed;
      }
    } catch {
      // Ignore malformed override; fall back to the driver default.
    }
  }

  return {
    port,
    host: env.ONECLAW_HERMES_NATIVE_HOST || ADAPTER_DEFAULT_HOST,
    token: env.ONECLAW_HERMES_NATIVE_TOKEN || undefined,
    defaultModel: env.ONECLAW_HERMES_NATIVE_MODEL || undefined,
    command: env.ONECLAW_HERMES_CLI || undefined,
    args,
  };
}

function main(): void {
  const cfg = resolveAdapterEnv();
  const driver = new SubprocessHermesDriver({
    command: cfg.command,
    args: cfg.args,
  });
  const opts: AdapterOptions = {
    driver,
    token: cfg.token,
    host: cfg.host,
    defaultModel: cfg.defaultModel,
  };
  const server = createAdapterServer(opts);
  server.listen(cfg.port, cfg.host, () => {
    // Never log the token value.
    process.stderr.write(
      `[1claw-hermes] OpenAI-compatible adapter listening on ` +
        `http://${cfg.host}:${cfg.port}/v1/chat/completions ` +
        `(auth: ${cfg.token ? "required" : "disabled"})\n`,
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run when invoked directly (not when imported by tests / index).
const invokedDirectly =
  process.argv[1] !== undefined &&
  /adapter[\\/](serve)(\.[cm]?[jt]s)?$/.test(process.argv[1]);
if (invokedDirectly) {
  main();
}
