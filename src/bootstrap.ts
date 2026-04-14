import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { packageRootEnvPath } from "./dotenv-path.js";
import { VaultError, ConfigError } from "./errors.js";

export interface BootstrapOptions {
  email: string;
  agentName: string;
  apiKey?: string;
  apiBase?: string;
  envPath?: string;
  shroudProvider?: string;
}

/** Finished bootstrap — key exchanged and .env written with discovered vault. */
export interface BootstrapCompleteResult {
  status: "complete";
  agentId: string;
  vaultId: string | undefined;
  apiKey: string;
  envPath: string;
}

/** Enrollment-only (e.g. non-TTY): stub .env written; user adds key locally, then runs `complete`. */
export interface BootstrapPendingResult {
  status: "pending_key";
  agentId: string;
  envPath: string;
  message: string;
}

export type BootstrapResult = BootstrapCompleteResult | BootstrapPendingResult;

export interface EnrollOnlyOptions {
  email: string;
  agentName: string;
  apiBase?: string;
  envPath?: string;
}

export interface CompleteFromEnvOptions {
  envPath?: string;
  apiBase?: string;
  shroudProvider?: string;
}

interface TokenExchangeResponse {
  access_token: string;
  expires_in: number;
  agent_id?: string;
  vault_ids?: string[];
}

function defaultEnvPath(): string {
  return packageRootEnvPath();
}

/** Agent UUID from Vault token responses. */
const AGENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parse a minimal .env file (KEY=value, # comments, quoted values). */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * If `.env` has an `ocv_` key but no `ONECLAW_AGENT_ID`, exchange once and append the id.
 * Raw `shroud-sidecar` requires both; this avoids manual copy-paste after bootstrap.
 */
export async function ensureAgentIdInDotEnv(envPath: string): Promise<void> {
  if (!fs.existsSync(envPath)) return;
  const raw = await fs.promises.readFile(envPath, "utf-8");
  const parsed = parseDotEnv(raw);
  if (
    parsed.ONECLAW_AGENT_ID &&
    AGENT_UUID_RE.test(parsed.ONECLAW_AGENT_ID.trim())
  ) {
    return;
  }
  const apiKey = parsed.ONECLAW_AGENT_API_KEY?.trim() ?? "";
  if (!apiKey.startsWith("ocv_")) return;
  const apiBase = parsed.ONECLAW_API_BASE?.trim() || "https://api.1claw.xyz";

  let tokenData: TokenExchangeResponse;
  try {
    tokenData = await exchangeToken(apiBase, apiKey);
  } catch {
    return;
  }

  const id = tokenData.agent_id?.trim();
  if (!id || !AGENT_UUID_RE.test(id)) return;

  const sep = raw.endsWith("\n") ? "" : "\n";
  const addition =
    `${sep}# Added by 1claw-hermes (required for shroud-sidecar manual mode)\nONECLAW_AGENT_ID=${id}\n`;
  await atomicWrite(envPath, raw.trimEnd() + addition);
  process.stderr.write(
    `[1claw-hermes] Appended ONECLAW_AGENT_ID to ${envPath}\n`,
  );
}

async function enrollAgent(
  apiBase: string,
  email: string,
  name: string,
): Promise<{ agent_id: string; message: string }> {
  const res = await fetch(`${apiBase}/v1/agents/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, human_email: email }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new VaultError(
      "ENROLL_FAILED",
      body.detail || body.message || `Enrollment failed (HTTP ${res.status})`,
    );
  }

  return res.json() as Promise<{ agent_id: string; message: string }>;
}

async function exchangeToken(
  apiBase: string,
  apiKey: string,
): Promise<TokenExchangeResponse> {
  const res = await fetch(`${apiBase}/v1/auth/agent-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new VaultError(
      "TOKEN_EXCHANGE_FAILED",
      body.detail || body.message || `Token exchange failed (HTTP ${res.status})`,
    );
  }

  return res.json() as Promise<TokenExchangeResponse>;
}

async function verifyConnection(
  apiBase: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${apiBase}/v1/agents/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new VaultError(
      "VERIFY_FAILED",
      `Verification failed (HTTP ${res.status}). Is the API key correct?`,
    );
  }
}

function promptLine(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function buildEnvContent(vars: Record<string, string>): string {
  const lines: string[] = [
    "# Generated by 1claw-hermes bootstrap",
    `# ${new Date().toISOString()}`,
    "",
  ];

  for (const [key, value] of Object.entries(vars)) {
    lines.push(`${key}=${value}`);
  }

  lines.push("");
  lines.push("# Optional overrides (uncomment to customize):");
  lines.push("# ONECLAW_MCP_URL=https://mcp.1claw.xyz/mcp");
  lines.push("# SHROUD_URL=https://shroud.1claw.xyz/v1");
  lines.push("# SHROUD_PROVIDER=anthropic");
  lines.push("# HERMES_CONFIG_DIR=~/.hermes");
  lines.push("");

  return lines.join("\n");
}

function buildStubEnvContent(params: {
  email: string;
  agentName: string;
  agentId: string;
  apiBase: string;
}): string {
  return [
    "# 1claw-hermes — enrollment requested",
    `# Agent name: ${params.agentName}`,
    `# Pending agent id (from enrollment): ${params.agentId}`,
    `# Human email: ${params.email}`,
    "#",
    "# After you approve the email, paste your ocv_ API key on the line below",
    "# (use your editor — do not paste the key into chat). Then run:",
    "#   pnpm bootstrap complete",
    "#",
    "ONECLAW_AGENT_API_KEY=",
    `ONECLAW_API_BASE=${params.apiBase}`,
    "",
  ].join("\n");
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, content, "utf-8");
  await fs.promises.rename(tmpPath, filePath);
}

/**
 * Phase 1 — request enrollment and write a stub .env with an empty
 * ONECLAW_AGENT_API_KEY line. Safe for non-TTY / agent runners: the user
 * fills the key in the file locally, then runs `completeBootstrapFromEnv`.
 */
export async function bootstrapEnroll(
  options: EnrollOnlyOptions,
): Promise<BootstrapPendingResult> {
  const apiBase = options.apiBase ?? "https://api.1claw.xyz";
  const envPath = options.envPath ?? defaultEnvPath();

  log(`Enrolling agent "${options.agentName}" for ${options.email}...`);
  const enroll = await enrollAgent(apiBase, options.email, options.agentName);
  log(`Enrollment sent! Check ${options.email} for the approval email.`);

  if (fs.existsSync(envPath)) {
    const prev = await fs.promises.readFile(envPath, "utf-8");
    const parsed = parseDotEnv(prev);
    if (parsed.ONECLAW_AGENT_API_KEY?.startsWith("ocv_")) {
      log(
        `${envPath} already contains an API key. Run \`pnpm bootstrap complete\` to finish, or remove the key line to replace.`,
      );
      return {
        status: "pending_key",
        agentId: enroll.agent_id,
        envPath,
        message:
          "Existing API key found in .env — run `pnpm bootstrap complete` to verify and merge vault id.",
      };
    }
    const backupPath = `${envPath}.bak.${Date.now()}`;
    await fs.promises.copyFile(envPath, backupPath);
    log(`Backed up existing file to ${backupPath}`);
  }

  const stub = buildStubEnvContent({
    email: options.email,
    agentName: options.agentName,
    agentId: enroll.agent_id,
    apiBase,
  });
  await atomicWrite(envPath, stub);

  const msg =
    `Stub written to ${envPath}. Add your ocv_ key to ONECLAW_AGENT_API_KEY in that file, then run: pnpm bootstrap complete`;

  log("");
  log(msg);
  log("");

  return {
    status: "pending_key",
    agentId: enroll.agent_id,
    envPath,
    message: msg,
  };
}

/**
 * Phase 2 — read ONECLAW_AGENT_API_KEY from .env (never from stdin / chat),
 * exchange, verify, and write the full merged .env with vault id.
 */
export async function completeBootstrapFromEnv(
  options: CompleteFromEnvOptions = {},
): Promise<BootstrapCompleteResult> {
  const envPath = options.envPath ?? defaultEnvPath();
  const shroudProvider = options.shroudProvider ?? "anthropic";

  if (!fs.existsSync(envPath)) {
    throw new ConfigError(
      `No .env file at ${envPath}. Run \`pnpm bootstrap\` or \`pnpm bootstrap enroll\` first.`,
    );
  }

  const raw = await fs.promises.readFile(envPath, "utf-8");
  const parsed = parseDotEnv(raw);
  const resolvedBase =
    options.apiBase?.trim() ||
    parsed.ONECLAW_API_BASE?.trim() ||
    "https://api.1claw.xyz";
  const apiKey = parsed.ONECLAW_AGENT_API_KEY?.trim() ?? "";

  if (!apiKey.startsWith("ocv_")) {
    throw new ConfigError(
      `Set ONECLAW_AGENT_API_KEY in ${envPath} to your ocv_ key from the approval email, save the file, then run this command again.`,
    );
  }

  log("Exchanging credentials from .env...");
  const tokenData = await exchangeToken(resolvedBase, apiKey);

  const agentId = tokenData.agent_id ?? "unknown";
  const vaultId = tokenData.vault_ids?.[0];

  log("Verifying connection...");
  await verifyConnection(resolvedBase, tokenData.access_token);

  log(`Connected! Agent (${agentId})`);
  if (vaultId) {
    log(`Vault: ${vaultId} (auto-discovered)`);
  } else {
    log(
      "No vault auto-discovered — set ONECLAW_VAULT_ID manually or create a vault at https://1claw.xyz",
    );
  }

  if (fs.existsSync(envPath)) {
    if (process.stdin.isTTY) {
      const overwrite = await promptLine(
        `Overwrite ${envPath} with merged values? [Y/n] `,
      );
      if (overwrite.toLowerCase() === "n") {
        log("Skipped writing .env — values verified.");
        return {
          status: "complete",
          agentId,
          vaultId,
          apiKey,
          envPath,
        };
      }
    } else {
      const backupPath = `${envPath}.bak.${Date.now()}`;
      await fs.promises.copyFile(envPath, backupPath);
      log(`Backed up existing .env to ${backupPath}`);
    }
  }

  const envVars: Record<string, string> = {
    ONECLAW_AGENT_API_KEY: apiKey,
    ONECLAW_API_BASE: resolvedBase,
  };
  if (agentId && agentId !== "unknown") envVars.ONECLAW_AGENT_ID = agentId;
  if (vaultId) envVars.ONECLAW_VAULT_ID = vaultId;
  if (shroudProvider !== "anthropic") envVars.SHROUD_PROVIDER = shroudProvider;

  await atomicWrite(envPath, buildEnvContent(envVars));
  log(`Wrote ${envPath} — you're ready to go.`);

  return {
    status: "complete",
    agentId,
    vaultId,
    apiKey,
    envPath,
  };
}

async function finishBootstrapWithKey(params: {
  apiKey: string;
  apiBase: string;
  envPath: string;
  shroudProvider: string;
  agentName: string;
}): Promise<BootstrapCompleteResult> {
  const { apiKey, apiBase, envPath, shroudProvider, agentName } = params;

  if (!apiKey.startsWith("ocv_")) {
    throw new ConfigError(
      `Invalid API key format — expected "ocv_" prefix, got "${apiKey.slice(0, 8)}..."`,
    );
  }

  log("Exchanging credentials...");
  const tokenData = await exchangeToken(apiBase, apiKey);

  const agentId = tokenData.agent_id ?? "unknown";
  const vaultId = tokenData.vault_ids?.[0];

  log("Verifying connection...");
  await verifyConnection(apiBase, tokenData.access_token);

  log(`Connected! Agent: ${agentName} (${agentId})`);
  if (vaultId) {
    log(`Vault: ${vaultId} (auto-discovered)`);
  } else {
    log(
      "No vault auto-discovered — set ONECLAW_VAULT_ID manually or create a vault at https://1claw.xyz",
    );
  }

  if (fs.existsSync(envPath)) {
    if (process.stdin.isTTY) {
      const overwrite = await promptLine(
        `.env already exists at ${envPath}. Overwrite? [y/N] `,
      );
      if (overwrite.toLowerCase() !== "y") {
        log("Skipped writing .env — configure manually.");
        return {
          status: "complete",
          agentId,
          vaultId,
          apiKey,
          envPath,
        };
      }
    } else {
      const backupPath = `${envPath}.bak.${Date.now()}`;
      await fs.promises.copyFile(envPath, backupPath);
      log(`Backed up existing .env to ${backupPath}`);
    }
  }

  const envVars: Record<string, string> = {
    ONECLAW_AGENT_API_KEY: apiKey,
    ONECLAW_API_BASE: apiBase,
  };
  if (agentId && agentId !== "unknown") envVars.ONECLAW_AGENT_ID = agentId;
  if (vaultId) envVars.ONECLAW_VAULT_ID = vaultId;
  if (shroudProvider !== "anthropic") envVars.SHROUD_PROVIDER = shroudProvider;

  await atomicWrite(envPath, buildEnvContent(envVars));
  log(`Wrote ${envPath} — you're ready to go.`);

  return {
    status: "complete",
    agentId,
    vaultId,
    apiKey,
    envPath,
  };
}

/**
 * Full bootstrap: enrolls, then obtains the key via --api-key, TTY prompt,
 * or (non-TTY) writes a stub .env and returns `pending_key` for file-based completion.
 */
export async function bootstrap(
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const apiBase = options.apiBase ?? "https://api.1claw.xyz";
  const envPath = options.envPath ?? defaultEnvPath();
  const shroudProvider = options.shroudProvider ?? "anthropic";

  if (!options.apiKey && !process.stdin.isTTY) {
    return bootstrapEnroll({
      email: options.email,
      agentName: options.agentName,
      apiBase,
      envPath,
    });
  }

  log(`Enrolling agent "${options.agentName}" for ${options.email}...`);
  await enrollAgent(apiBase, options.email, options.agentName);
  log(`Enrollment sent! Check ${options.email} for the approval email.`);

  let apiKey = options.apiKey;
  if (!apiKey) {
    log("");
    log("After approving the enrollment, you'll receive an API key (ocv_...).");
    apiKey = await promptLine("Paste your API key: ");
  }

  const complete = await finishBootstrapWithKey({
    apiKey: apiKey!,
    apiBase,
    envPath,
    shroudProvider,
    agentName: options.agentName,
  });

  return complete;
}

export function isBootstrapComplete(
  r: BootstrapResult,
): r is BootstrapCompleteResult {
  return r.status === "complete";
}
