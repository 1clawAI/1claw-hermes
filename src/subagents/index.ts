import { requireVaultId } from "../config.js";
import { getClient } from "../client.js";
import { VaultError } from "../errors.js";
import type { AgentPolicy } from "./policy.js";

export interface SubagentIdentity {
  agentId: string;
  apiKey: string;
  vaultToken: string;
  expiresAt: Date;
}

export class SubagentRegistry {
  private agents = new Map<string, SubagentIdentity>();

  register(identity: SubagentIdentity): void {
    this.agents.set(identity.agentId, identity);
  }

  get(agentId: string): SubagentIdentity | undefined {
    return this.agents.get(agentId);
  }

  getAll(): SubagentIdentity[] {
    return [...this.agents.values()];
  }

  remove(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  async revokeAll(): Promise<void> {
    const ids = [...this.agents.keys()];
    await Promise.allSettled(
      ids.map((id) => deprovisionSubagent(id, this)),
    );
  }
}

const defaultRegistry = new SubagentRegistry();

function installShutdownHook(registry: SubagentRegistry): void {
  const handler = () => {
    registry.revokeAll().catch(() => {});
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

let hookInstalled = false;

export async function provisionSubagent(
  name: string,
  policy: AgentPolicy,
  registry: SubagentRegistry = defaultRegistry,
): Promise<SubagentIdentity> {
  if (!hookInstalled) {
    installShutdownHook(registry);
    hookInstalled = true;
  }

  const vaultId = requireVaultId();
  const client = getClient();

  const createRes = await client.agents.create({
    name: `hermes-sub-${name}`,
    description: `Hermes subagent: ${name}`,
    auth_method: "api_key",
    token_ttl_seconds: policy.expiresAfterSeconds,
    vault_ids: [vaultId],
    intents_api_enabled: policy.allowedChains.length > 0,
    tx_allowed_chains: policy.allowedChains.length > 0 ? policy.allowedChains : undefined,
    tx_max_value_eth: policy.maxValueEth ?? undefined,
    tx_to_allowlist: policy.allowedAddresses.length > 0 ? policy.allowedAddresses : undefined,
  });

  if (createRes.error || !createRes.data) {
    throw new VaultError(
      "SUBAGENT_CREATE_FAILED",
      createRes.error?.message ?? "Failed to create subagent",
    );
  }

  const { agent, api_key } = createRes.data;

  if (!api_key) {
    throw new VaultError(
      "SUBAGENT_CREATE_FAILED",
      "Agent created but no API key returned",
    );
  }

  for (const secretPath of policy.secretPaths) {
    const grantRes = await client.access.grantAgent(
      vaultId,
      agent.id,
      policy.permissions,
      {
        secretPathPattern: secretPath,
        expires_at: new Date(
          Date.now() + policy.expiresAfterSeconds * 1000,
        ).toISOString(),
      },
    );

    if (grantRes.error) {
      await client.agents.delete(agent.id).catch(() => {});
      throw new VaultError(
        "SUBAGENT_POLICY_FAILED",
        `Failed to grant policy for path "${secretPath}": ${grantRes.error.message}`,
      );
    }
  }

  const tokenRes = await client.auth.agentToken({
    agent_id: agent.id,
    api_key,
  });

  if (tokenRes.error || !tokenRes.data) {
    await client.agents.delete(agent.id).catch(() => {});
    throw new VaultError(
      "SUBAGENT_TOKEN_FAILED",
      tokenRes.error?.message ?? "Failed to exchange subagent token",
    );
  }

  const expiresAt = new Date(
    Date.now() + (tokenRes.data.expires_in ?? policy.expiresAfterSeconds) * 1000,
  );

  const identity: SubagentIdentity = {
    agentId: agent.id,
    apiKey: api_key,
    vaultToken: tokenRes.data.access_token,
    expiresAt,
  };

  registry.register(identity);
  return identity;
}

export async function deprovisionSubagent(
  agentId: string,
  registry: SubagentRegistry = defaultRegistry,
): Promise<void> {
  const vaultId = requireVaultId();
  const client = getClient();

  const grants = await client.access.listGrants(vaultId);
  if (grants.data) {
    const agentPolicies = grants.data.policies.filter(
      (p: { principal_id: string }) => p.principal_id === agentId,
    );
    await Promise.allSettled(
      agentPolicies.map((p: { id: string }) =>
        client.access.revoke(vaultId, p.id),
      ),
    );
  }

  await client.agents.delete(agentId);
  registry.remove(agentId);
}
