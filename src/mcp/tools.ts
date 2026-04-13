import { config } from "../config.js";
import { getClient, createScopedClient } from "../client.js";
import { VaultError } from "../errors.js";
import type { OneclawClient } from "@1claw/sdk";

export interface AgentContext {
  agentId: string;
  token: string;
}

function resolveClient(ctx?: AgentContext): OneclawClient {
  return ctx ? createScopedClient(ctx.token) : getClient();
}

export async function getSecret(
  secretPath: string,
  ctx?: AgentContext,
): Promise<string> {
  const client = resolveClient(ctx);
  const res = await client.secrets.get(config.oneClawVaultId, secretPath);

  if (res.error || !res.data) {
    throw new VaultError(
      "SECRET_READ_FAILED",
      `Failed to read secret at "${secretPath}": ${res.error?.message ?? "unknown"}`,
    );
  }

  return res.data.value;
}

export async function setSecret(
  secretPath: string,
  value: string,
  ctx?: AgentContext,
): Promise<void> {
  const client = resolveClient(ctx);
  const res = await client.secrets.set(
    config.oneClawVaultId,
    secretPath,
    value,
  );

  if (res.error) {
    throw new VaultError(
      "SECRET_WRITE_FAILED",
      `Failed to write secret at "${secretPath}": ${res.error.message}`,
    );
  }
}

export async function listSecrets(
  prefix: string,
  ctx?: AgentContext,
): Promise<string[]> {
  const client = resolveClient(ctx);
  const res = await client.secrets.list(config.oneClawVaultId, prefix);

  if (res.error || !res.data) {
    throw new VaultError(
      "SECRET_LIST_FAILED",
      `Failed to list secrets under "${prefix}": ${res.error?.message ?? "unknown"}`,
    );
  }

  return res.data.secrets.map(
    (s: { path: string }) => s.path,
  );
}
