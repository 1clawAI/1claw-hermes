import { requireVaultId } from "../config.js";
import { getClient, createScopedClient } from "../client.js";
import { VaultError } from "../errors.js";
import type { OneclawClient, OneclawResponse, SecretsResource } from "@1claw/sdk";

type SdkSetSecretOptions = NonNullable<Parameters<SecretsResource["set"]>[3]>;

export interface AgentContext {
  agentId: string;
  token: string;
}

/** Options for {@link setSecret} / {@link putSecret} — matches MCP `put_secret` (REST `PUT .../secrets/{path}`). */
export interface HermesSetSecretOptions extends SdkSetSecretOptions {
  /** Subagent or alternate agent JWT scope (optional). */
  ctx?: AgentContext;
}

/** Third argument to {@link setSecret}: either a subagent context (legacy) or full options including `type`. */
export type SetSecretThirdArg = AgentContext | HermesSetSecretOptions | undefined;

function isAgentContext(x: unknown): x is AgentContext {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o);
  return (
    keys.length === 2 &&
    typeof o.agentId === "string" &&
    typeof o.token === "string"
  );
}

function resolveSetSecretThird(third: SetSecretThirdArg): {
  ctx?: AgentContext;
  sdkOpts: SdkSetSecretOptions;
} {
  if (third === undefined) return { sdkOpts: {} };
  if (isAgentContext(third)) return { ctx: third, sdkOpts: {} };
  const { ctx, ...rest } = third;
  return { ctx, sdkOpts: rest };
}

function resolveClient(ctx?: AgentContext): OneclawClient {
  return ctx ? createScopedClient(ctx.token) : getClient();
}

/** Builds a single error line from an SDK envelope (status, type, message, detail). */
function formatEnvelopeFailure<T>(
  res: OneclawResponse<T>,
  verb: string,
  target: string,
): string {
  const e = res.error;
  const status = res.meta?.status;
  if (!e) {
    return `${verb} ${target}${status != null ? ` (HTTP ${status})` : ""}: empty response`;
  }
  const detail =
    e.detail && e.detail !== e.message ? e.detail : undefined;
  const parts = [
    e.message || "(no message)",
    detail,
    e.type ? `[${e.type}]` : undefined,
    status != null ? `HTTP ${status}` : undefined,
  ].filter(Boolean);
  return `${verb} ${target}: ${parts.join(" — ")}`;
}

export async function getSecret(
  secretPath: string,
  ctx?: AgentContext,
): Promise<string> {
  const vaultId = requireVaultId();
  const client = resolveClient(ctx);
  const res = await client.secrets.get(vaultId, secretPath);

  if (res.error || !res.data) {
    throw new VaultError(
      "SECRET_READ_FAILED",
      formatEnvelopeFailure(res, "read", `"${secretPath}"`),
    );
  }

  return res.data.value;
}

/**
 * Store a secret via the Vault REST API (`PUT /v1/vaults/{vaultId}/secrets/{path}`).
 * This is the same operation as the MCP tool **`put_secret`** (names differ only on the wire).
 *
 * Pass `{ type: "api_key" }` (or other types) to mirror MCP auto-detection behaviour.
 */
export async function setSecret(
  secretPath: string,
  value: string,
  third?: SetSecretThirdArg,
): Promise<void> {
  const vaultId = requireVaultId();
  const { ctx, sdkOpts } = resolveSetSecretThird(third);
  const client = resolveClient(ctx);
  const res = await client.secrets.set(vaultId, secretPath, value, sdkOpts);

  if (res.error) {
    throw new VaultError(
      "SECRET_WRITE_FAILED",
      formatEnvelopeFailure(res, "write", `"${secretPath}"`),
    );
  }
}

/** Alias for {@link setSecret} — same name as the MCP tool (`put_secret`). */
export const putSecret = setSecret;

export async function listSecrets(
  prefix: string,
  ctx?: AgentContext,
): Promise<string[]> {
  const vaultId = requireVaultId();
  const client = resolveClient(ctx);
  const res = await client.secrets.list(vaultId, prefix);

  if (res.error || !res.data) {
    throw new VaultError(
      "SECRET_LIST_FAILED",
      formatEnvelopeFailure(res, "list", `"${prefix}"`),
    );
  }

  return res.data.secrets.map(
    (s: { path: string }) => s.path,
  );
}
