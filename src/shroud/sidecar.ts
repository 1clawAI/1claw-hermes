#!/usr/bin/env node
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureAgentIdInDotEnv, parseDotEnv } from "../bootstrap.js";
import { expandTilde, resolveDotEnvPath } from "../dotenv-path.js";

const SIDECAR_BINARY = "shroud-sidecar";
const DEFAULT_LISTEN = ":8080";
const HEALTH_URL = "http://127.0.0.1:8080/healthz";

export interface SidecarOptions {
  /** Override listen address (default: `:8080`). */
  listenAddr?: string;
  /** Upstream LLM provider — required for Hermes models like `google/gemini-*`. */
  provider?: string;
  /** Default model name (optional; usually resolved from request body). */
  model?: string;
  /** Path to .env to read credentials from (default: package root .env). */
  envPath?: string;
  /**
   * Retained for compatibility and ignored: nothing is installed any more.
   * The binary comes from an optional dependency, PATH, or a local build.
   */
  skipInstall?: boolean;
  /** Shroud URL override (default: https://shroud.1claw.co). */
  shroudUrl?: string;
}

function resolveEnvFilePath(options: SidecarOptions): string {
  if (options.envPath) {
    return path.resolve(expandTilde(options.envPath));
  }
  return resolveDotEnvPath({});
}

/**
 * The platform package that carries this host's binary.
 *
 * `@1claw/hermes` lists both targets under `optionalDependencies`, so npm
 * installs the one whose `os`/`cpu` match and skips the other. Nothing is
 * downloaded or executed at install time, the version is fixed by the
 * lockfile, and npm has already verified the tarball against the integrity
 * hash recorded there.
 */
function platformPackage(): string | null {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "linux-x64":
      return "@1claw/shroud-sidecar-linux-x64";
    case "darwin-arm64":
      return "@1claw/shroud-sidecar-darwin-arm64";
    default:
      return null;
  }
}

/** The binary from the installed platform package, if it is there. */
function binaryFromPackage(): string | null {
  const pkg = platformPackage();
  if (!pkg) return null;
  try {
    // Resolve the package's manifest and take the binary beside it, rather
            // than `require.resolve(pkg + "/bin/...")`, which needs an exports entry.
    const manifest = require.resolve(`${pkg}/package.json`);
    const bin = path.join(path.dirname(manifest), "bin", SIDECAR_BINARY);
    return fs.existsSync(bin) ? bin : null;
  } catch {
    // Not installed: an optional dependency that did not match, or a
    // node_modules tree without it.
    return null;
  }
}

/** `shroud-sidecar` on PATH, for a hand-installed or locally built binary. */
function findBinary(): string | null {
  try {
    // `execFileSync`, not a shell: both operands are module constants so this
    // was never injectable, but a shell is not needed to look a binary up.
    const where = process.platform === "win32" ? "where" : "which";
    return execFileSync(where, [SIDECAR_BINARY], { encoding: "utf-8" })
      .split("\n")[0]
      .trim() || null;
  } catch {
    return null;
  }
}

function localBin(): string {
  return path.join(os.homedir(), ".local", "bin", SIDECAR_BINARY);
}

/**
 * Where the sidecar binary is, or an error saying how to get one.
 *
 * Hermes used to fetch `install.sh` from the sidecar repo's `main` branch and
 * pipe it to `sh` when the binary was missing. The script itself was sound —
 * release artifacts, sha256 verification, version pinning — but the
 * arrangement was not:
 *
 *   - its checksum step warned and continued when `checksums.txt` could not be
 *     fetched, so withholding one file downgraded the install to no
 *     verification at all;
 *   - we fetched the script from `main`, the least pinned form of a script
 *     built to be pinned;
 *   - and it resolved the *latest* release at install time, so two installs a
 *     week apart produced different binaries.
 *
 * A package manager already solves all three, so the binary now arrives as an
 * optional dependency and nothing is downloaded or executed here. Production
 * runtimes are unaffected either way: `runtime-base` builds the sidecar from
 * source and bakes it into the image, so this path only ever served local use.
 *
 * Order: the platform package, then PATH (a hand-installed or locally built
 * binary), then `~/.local/bin` (where the old installer put it, so an existing
 * machine keeps working).
 */
function resolveSidecarBinary(): string {
  const fromPackage = binaryFromPackage();
  if (fromPackage) return fromPackage;

  const onPath = findBinary();
  if (onPath) return onPath;

  const legacy = localBin();
  if (fs.existsSync(legacy)) return legacy;

  const pkg = platformPackage();
  if (!pkg) {
    throw new Error(
      `No prebuilt ${SIDECAR_BINARY} for ${process.platform}/${process.arch} ` +
        `(supported: linux/x64, darwin/arm64). Build it from source: ` +
        `go build -o ~/.local/bin/${SIDECAR_BINARY} . in 1claw-shroud-sidecar.`,
    );
  }
  return (() => {
    throw new Error(
      `${SIDECAR_BINARY} not found. It ships as an optional dependency, so the ` +
        `usual cause is an install that skipped optional packages ` +
        `(\`--no-optional\`, or a lockfile from another platform).\n` +
        `  Reinstall:        npm install\n` +
        `  Or install it:    npm install ${pkg}\n` +
        `  Or build it:      go build -o ~/.local/bin/${SIDECAR_BINARY} .  ` +
        `(in 1claw-shroud-sidecar)`,
    );
  })();
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
  const envPath = resolveEnvFilePath(options);
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

  const bin = resolveSidecarBinary();

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    LISTEN_ADDR: options.listenAddr ?? DEFAULT_LISTEN,
    ONECLAW_AGENT_API_KEY: apiKey,
    ONECLAW_SHROUD_URL:
      options.shroudUrl ??
      process.env.ONECLAW_SHROUD_URL ??
      "https://shroud.1claw.co",
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
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "env-file": { type: "string" },
      provider: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    process.stderr.write(`Usage: pnpm shroud [--env-file <path>] [--provider <name>]

Reads credentials from .env (see resolve order in README).
Environment:
  ONECLAW_ENV_FILE          Path to .env if not using --env-file
  ONECLAW_DEFAULT_PROVIDER  Default upstream (google, openai, …)
`);
    process.exit(0);
  }

  const envPath = resolveDotEnvPath({ explicit: values["env-file"] });
  await ensureAgentIdInDotEnv(envPath);

  const creds = loadCredsFromEnv(envPath);
  const provider =
    values.provider ??
    process.env.ONECLAW_DEFAULT_PROVIDER ??
    process.env.SHROUD_PROVIDER ??
    creds.SHROUD_PROVIDER ??
    undefined;

  const child = await startSidecarAndWait({
    provider,
    envPath,
  });

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
