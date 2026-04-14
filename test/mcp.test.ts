import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";

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

  it("creates config.yaml with mcp_servers.oneclaw when no config exists", async () => {
    await patchHermesConfig(tmpDir);

    const configPath = path.join(tmpDir, "config.yaml");
    expect(fs.existsSync(configPath)).toBe(true);

    const parsed = parseYaml(
      fs.readFileSync(configPath, "utf-8"),
    ) as Record<string, unknown>;
    const oneclaw = (parsed.mcp_servers as Record<string, unknown>).oneclaw as {
      url: string;
      headers: Record<string, string>;
    };
    expect(oneclaw.url).toBe("https://mcp.1claw.xyz/mcp");
    expect(oneclaw.headers.Authorization).toBe("Bearer jwt-token-abc");
    expect(oneclaw.headers["X-Vault-ID"]).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  it("creates a backup of the existing yaml config", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, "theme: dark\n");

    await patchHermesConfig(tmpDir);

    const backups = fs.readdirSync(tmpDir).filter((f) =>
      f.startsWith("config.yaml.bak."),
    );
    expect(backups.length).toBe(1);

    const backupContent = fs.readFileSync(
      path.join(tmpDir, backups[0]),
      "utf-8",
    );
    expect(backupContent).toContain("theme: dark");
  });

  it("merges yaml without overwriting unrelated keys", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "theme: dark\nmcp_servers:\n  other:\n    url: http://other.test\n",
    );

    await patchHermesConfig(tmpDir);

    const parsed = parseYaml(
      fs.readFileSync(configPath, "utf-8"),
    ) as Record<string, unknown>;
    expect(parsed.theme).toBe("dark");
    const servers = parsed.mcp_servers as Record<string, { url: string }>;
    expect(servers.other.url).toBe("http://other.test");
    expect(servers.oneclaw).toBeDefined();
  });

  it("uses config.json when yaml is absent (legacy)", async () => {
    const jsonPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(jsonPath, JSON.stringify({ theme: "light" }));

    await patchHermesConfig(tmpDir);

    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(parsed.theme).toBe("light");
    expect(parsed.mcpServers.oneclaw.url).toBe("https://mcp.1claw.xyz/mcp");
    expect(parsed.mcpServers.oneclaw.headers.Authorization).toBe(
      "Bearer jwt-token-abc",
    );
  });
});
