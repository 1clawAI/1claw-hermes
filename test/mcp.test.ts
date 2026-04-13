import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("@1claw/sdk", () => ({
  createClient: vi.fn(() => ({
    auth: {
      agentToken: vi.fn().mockResolvedValue({
        data: { access_token: "jwt-token-abc", expires_in: 3600 },
        error: null,
      }),
    },
    secrets: {},
    access: {},
    agents: {},
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

import { buildMcpEntry, patchHermesConfig } from "../src/mcp/index.js";

describe("buildMcpEntry", () => {
  it("returns the correct shape with Authorization and X-Vault-ID headers", () => {
    const entry = buildMcpEntry("my-jwt", "vault-123");
    expect(entry).toEqual({
      url: "https://mcp.1claw.xyz/mcp",
      headers: {
        Authorization: "Bearer my-jwt",
        "X-Vault-ID": "vault-123",
      },
    });
  });

  it("uses the MCP URL from config", () => {
    const entry = buildMcpEntry("tok", "v");
    expect(entry.url).toBe("https://mcp.1claw.xyz/mcp");
  });
});

describe("patchHermesConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates config.json when it does not exist", async () => {
    await patchHermesConfig(tmpDir);

    const configPath = path.join(tmpDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers["1claw"]).toBeDefined();
    expect(parsed.mcpServers["1claw"].url).toBe("https://mcp.1claw.xyz/mcp");
  });

  it("creates a backup of the existing config", async () => {
    const configPath = path.join(tmpDir, "config.json");
    const original = { existingKey: "keep-me", mcpServers: {} };
    fs.writeFileSync(configPath, JSON.stringify(original));

    await patchHermesConfig(tmpDir);

    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith("config.json.bak."));
    expect(backups.length).toBe(1);

    const backupContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, backups[0]), "utf-8"),
    );
    expect(backupContent.existingKey).toBe("keep-me");
  });

  it("merges without overwriting unrelated keys", async () => {
    const configPath = path.join(tmpDir, "config.json");
    const original = {
      theme: "dark",
      mcpServers: { other: { url: "http://other.test" } },
    };
    fs.writeFileSync(configPath, JSON.stringify(original));

    await patchHermesConfig(tmpDir);

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.other.url).toBe("http://other.test");
    expect(parsed.mcpServers["1claw"]).toBeDefined();
  });
});
