import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockGrantAgent = vi.fn();
const mockListGrants = vi.fn();
const mockAgentToken = vi.fn();

vi.mock("@1claw/sdk", () => ({
  createClient: vi.fn(() => ({
    agents: {
      create: mockCreate,
      delete: mockDelete,
    },
    access: {
      grantAgent: mockGrantAgent,
      listGrants: mockListGrants,
      revoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    auth: {
      agentToken: mockAgentToken,
    },
    secrets: {},
    audit: {},
  })),
}));

vi.mock("../src/config.js", () => ({
  config: {
    oneClawApiBase: "https://api.1claw.xyz",
    oneClawVaultId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    oneClawAgentApiKey: "ocv_test_key_123",
    oneClawMcpUrl: "https://mcp.1claw.xyz/mcp",
    shroudUrl: "https://shroud.1claw.xyz/v1",
    shroudToken: "shroud-tok",
    shroudProvider: "anthropic",
    hermesConfigDir: "~/.hermes",
  },
  requireVaultId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  requireApiKey: () => "ocv_test_key_123",
}));

import {
  provisionSubagent,
  deprovisionSubagent,
  SubagentRegistry,
} from "../src/subagents/index.js";
import { ephemeralReadPolicy } from "../src/subagents/policy.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provisionSubagent", () => {
  it("returns an identity with a future expiresAt", async () => {
    mockCreate.mockResolvedValue({
      data: {
        agent: { id: "agent-001" },
        api_key: "ocv_sub_key_abc",
      },
      error: null,
    });
    mockGrantAgent.mockResolvedValue({ data: {}, error: null });
    mockAgentToken.mockResolvedValue({
      data: { access_token: "jwt-sub-001", expires_in: 300 },
      error: null,
    });

    const registry = new SubagentRegistry();
    const policy = ephemeralReadPolicy("api-keys/stripe");
    const now = Date.now();
    const identity = await provisionSubagent("stripe-checker", policy, registry);

    expect(identity.agentId).toBe("agent-001");
    expect(identity.apiKey).toBe("ocv_sub_key_abc");
    expect(identity.vaultToken).toBe("jwt-sub-001");
    expect(identity.expiresAt.getTime()).toBeGreaterThan(now);
  });

  it("registers the identity in the provided registry", async () => {
    mockCreate.mockResolvedValue({
      data: { agent: { id: "agent-002" }, api_key: "ocv_sub_key_def" },
      error: null,
    });
    mockGrantAgent.mockResolvedValue({ data: {}, error: null });
    mockAgentToken.mockResolvedValue({
      data: { access_token: "jwt-sub-002", expires_in: 300 },
      error: null,
    });

    const registry = new SubagentRegistry();
    await provisionSubagent("reader", ephemeralReadPolicy("config/*"), registry);

    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get("agent-002")).toBeDefined();
  });
});

describe("SubagentRegistry.revokeAll", () => {
  it("calls deprovision for each live agent", async () => {
    mockListGrants.mockResolvedValue({
      data: { policies: [] },
      error: null,
    });
    mockDelete.mockResolvedValue({ data: null, error: null });

    const registry = new SubagentRegistry();
    registry.register({
      agentId: "a1",
      apiKey: "ocv_k1",
      vaultToken: "jwt1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    registry.register({
      agentId: "a2",
      apiKey: "ocv_k2",
      vaultToken: "jwt2",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await registry.revokeAll();

    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(registry.getAll()).toHaveLength(0);
  });
});

describe("deprovisionSubagent", () => {
  it("deletes the agent and removes it from the registry", async () => {
    mockListGrants.mockResolvedValue({
      data: { policies: [] },
      error: null,
    });
    mockDelete.mockResolvedValue({ data: null, error: null });

    const registry = new SubagentRegistry();
    registry.register({
      agentId: "a3",
      apiKey: "ocv_k3",
      vaultToken: "jwt3",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await deprovisionSubagent("a3", registry);

    expect(mockDelete).toHaveBeenCalledWith("a3");
    expect(registry.get("a3")).toBeUndefined();
  });
});
