#!/usr/bin/env node
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDotEnv } from "../bootstrap.js";

const SIDECAR_BINARY = "shroud-sidecar";
const DEFAULT_LISTEN = ":8080";
const HEALTH_URL = "http://127.0.0.1:8080/healthz";
const INSTALL_SCRIPT =
  "https://raw.githubusercontent.com/1clawAI/1claw-shroud-sidecar/main/install.sh";

export interface SidecarOptions {
  /** Override listen address (default: `:8080`). */
  listenAddr?: string;
  /** Upstream LLM provider — required for Hermes models like `google/gemini-*`. */
  provider?: string;
  /** Default model name (optional; usually resolved from request body). */
  model?: string;
  /** Path to .env to read credentials from (default: package root .env). */
  envPath?: string;
  /** Skip auto-install if binary not found (default: false — will try install.sh). */
  skipInstall?: boolean;
  /** Shroud URL override (default: https://shroud.1claw.xyz). */
  shroudUrl?: string;
}

function defaultEnvPath(): string {
  return path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    ".env",
  );
}

function findBinary(): string | null {
  try {
    const where = process.platform === "win32" ? "where" : "which";
    return execSync(`${where} ${SIDECAR_BINARY}`, { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }

}

function localBin(): string {
  return path.join(os.homedir(), ".local", "bin", SIDECAR_BINARY);
}

function installSidecar(): string {
  const localPath = localBin();
  if (fs.existsSync(localPath)) return localPath;

  console.error(`[1claw-hermes] ${SIDECAR_BINARY} not found — installing via install.sh ...`);
  try {
    execSync(`curl -fsSL ${INSTALL_SCRIPT} | sh`, {
      stdio: "inherit",
      env: { ...process.env, PREFIX: path.dirname(localPath) },
    });
  } catch (err) {
    throw new Error(
      `Failed to install ${SIDECAR_BINARY}. Install manually: curl -fsSL ${INSTALL_SCRIPT} | sh`,
    );
  }

  if (!fs.existsSync(localPath)) {
    throw new Error(
      `Install script ran but binary not found at ${localPath}. Check install output above.`,
    );
  }
  return localPath;
}

function loadCredsFromEnv(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, "utf-8");
  return parseDotEnv(raw);
}

export async function waitForHealth(
  url: string = HEALTH_URL,
  timeoutMs: number = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Start the shroud-sidecar process. Installs the binary if absent.
 * Returns the ChildProcess so callers can manage its lifecycle.
 */
export function startSidecar(options: SidecarOptions = {}): ChildProcess {
  const envPath = options.envPath ?? defaultEnvPath();
  const creds = loadCredsFromEnv(envPath);

  const agentId = process.env.ONECLAW_AGENT_ID ?? creds.ONECLAW_AGENT_ID ?? "";
  const apiKey =
    process.env.ONECLAW_AGENT_API_KEY ?? creds.ONECLAW_AGENT_API_KEY ?? "";
  const vaultId = process.env.ONECLAW_VAULT_ID ?? creds.ONECLAW_VAULT_ID ?? "";

  if (!apiKey.startsWith("ocv_")) {
    throw new Error(
      "ONECLAW_AGENT_API_KEY (ocv_…) required. Run `pnpm bootstrap` first.",
    );
  }

  let bin = findBinary();
  if (!bin) {
    if (options.skipInstall) {
      throw new Error(
        `${SIDECAR_BINARY} not on PATH. Install: curl -fsSL ${INSTALL_SCRIPT} | sh`,
      );
    }
    bin = installSidecar();
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    LISTEN_ADDR: options.listenAddr ?? DEFAULT_LISTEN,
    ONECLAW_AGENT_API_KEY: apiKey,
    ONECLAW_SHROUD_URL:
      options.shroudUrl ??
      process.env.ONECLAW_SHROUD_URL ??
      "https://shroud.1claw.xyz",
  };

  if (agentId) env.ONECLAW_AGENT_ID = agentId;
  if (vaultId) env.ONECLAW_VAULT_ID = vaultId;
  if (options.provider) env.ONECLAW_DEFAULT_PROVIDER = options.provider;
  if (options.model) env.ONECLAW_DEFAULT_MODEL = options.model;

  const child = spawn(bin, [], {
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  child.on("error", (err) => {
    console.error(`[shroud-sidecar] failed to start: ${err.message}`);
  });

  return child;
}

/**
 * Start sidecar + wait for /healthz. Returns the child process.
 * Throws if health check times out.
 */
export async function startSidecarAndWait(
  options: SidecarOptions = {},
): Promise<ChildProcess> {
  const child = startSidecar(options);

  const port = (options.listenAddr ?? DEFAULT_LISTEN).replace(/^:/, "");
  const healthUrl = `http://127.0.0.1:${port}/healthz`;

  const ok = await waitForHealth(healthUrl);
  if (!ok) {
    child.kill();
    throw new Error(
      `Sidecar started but /healthz at ${healthUrl} did not respond within 15s. ` +
        `Check stderr output above for errors.`,
    );
  }

  console.error(`[1claw-hermes] Shroud sidecar ready at http://127.0.0.1:${port}/v1`);
  return child;
}

/** CLI entry: start sidecar, keep running until SIGINT/SIGTERM. */
async function main(): Promise<void> {
  const envPath = defaultEnvPath();
  const creds = loadCredsFromEnv(envPath);

  const provider =
    process.env.ONECLAW_DEFAULT_PROVIDER ??
    process.env.SHROUD_PROVIDER ??
    creds.SHROUD_PROVIDER ??
    undefined;

  const child = await startSidecarAndWait({ provider, envPath });

  const shutdown = () => {
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
