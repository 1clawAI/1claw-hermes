import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `packages/1claw-hermes/.env` next to compiled output (`dist/` → package root). */
export function packageRootEnvPath(): string {
  return path.resolve(__dirname, "..", ".env");
}

export function expandTilde(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

export interface ResolveDotEnvOptions {
  /** Explicit path from CLI (`--env-file`). */
  explicit?: string;
  /** Directory to start walking upward for `.env` (default: `process.cwd()`). */
  startDir?: string;
}

/**
 * Picks which `.env` file to load for credentials.
 *
 * Precedence:
 * 1. `explicit` (CLI `--env-file`)
 * 2. `ONECLAW_ENV_FILE` environment variable
 * 3. Walk `process.cwd()` and ancestors for a file named `.env`
 * 4. `packageRootEnvPath()` (this package's `.env`)
 */
export function resolveDotEnvPath(options: ResolveDotEnvOptions = {}): string {
  if (options.explicit) {
    return path.resolve(expandTilde(options.explicit));
  }
  const fromEnv = process.env.ONECLAW_ENV_FILE?.trim();
  if (fromEnv) {
    return path.resolve(expandTilde(fromEnv));
  }
  let dir = options.startDir ?? process.cwd();
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return packageRootEnvPath();
}
