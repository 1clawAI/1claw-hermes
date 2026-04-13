import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { needsBootstrap } from "../src/config.js";
import type { Config } from "../src/config.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("needsBootstrap", () => {
  it("returns true when API key is missing", () => {
    const cfg = {
      oneClawApiBase: "https://api.1claw.xyz",
      oneClawMcpUrl: "https://mcp.1claw.xyz/mcp",
      shroudUrl: "https://shroud.1claw.xyz/v1",
      shroudProvider: "anthropic" as const,
      hermesConfigDir: "~/.hermes",
    } as Config;

    expect(needsBootstrap(cfg)).toBe(true);
  });

  it("returns false when API key is present", () => {
    const cfg = {
      oneClawApiBase: "https://api.1claw.xyz",
      oneClawAgentApiKey: "ocv_test_key_123",
      oneClawMcpUrl: "https://mcp.1claw.xyz/mcp",
      shroudUrl: "https://shroud.1claw.xyz/v1",
      shroudProvider: "anthropic" as const,
      hermesConfigDir: "~/.hermes",
    } as Config;

    expect(needsBootstrap(cfg)).toBe(false);
  });
});

describe("bootstrap", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bootstrap-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupMocks() {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : String(url);

      if (urlStr.includes("/v1/agents/enroll")) {
        return new Response(
          JSON.stringify({ agent_id: "agent-abc-123", message: "Enrollment sent" }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("/v1/auth/agent-token")) {
        return new Response(
          JSON.stringify({
            access_token: "jwt-token-xyz",
            expires_in: 3600,
            agent_id: "agent-abc-123",
            vault_ids: ["vault-def-456"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("/v1/agents/me")) {
        return new Response(
          JSON.stringify({ id: "agent-abc-123", name: "test-agent" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    });
  }

  it("produces correct .env content in fully headless mode", async () => {
    setupMocks();
    const envPath = path.join(tmpDir, ".env");

    const { bootstrap } = await import("../src/bootstrap.js");
    const result = await bootstrap({
      email: "alice@acme.com",
      agentName: "my-test-agent",
      apiKey: "ocv_test_key_headless",
      apiBase: "https://api.1claw.xyz",
      envPath,
    });

    expect(result.agentId).toBe("agent-abc-123");
    expect(result.vaultId).toBe("vault-def-456");
    expect(result.apiKey).toBe("ocv_test_key_headless");

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("ONECLAW_AGENT_API_KEY=ocv_test_key_headless");
    expect(content).toContain("ONECLAW_VAULT_ID=vault-def-456");
    expect(content).toContain("ONECLAW_API_BASE=https://api.1claw.xyz");
  });

  it("calls enrollment endpoint with correct payload", async () => {
    setupMocks();
    const envPath = path.join(tmpDir, ".env");

    const { bootstrap } = await import("../src/bootstrap.js");
    await bootstrap({
      email: "bob@corp.io",
      agentName: "corp-agent",
      apiKey: "ocv_corp_key",
      envPath,
    });

    const enrollCall = mockFetch.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes("/v1/agents/enroll"),
    );
    expect(enrollCall).toBeDefined();

    const body = JSON.parse((enrollCall![1] as RequestInit).body as string);
    expect(body.name).toBe("corp-agent");
    expect(body.human_email).toBe("bob@corp.io");
  });

  it("auto-discovers vault from token exchange response", async () => {
    setupMocks();
    const envPath = path.join(tmpDir, ".env");

    const { bootstrap } = await import("../src/bootstrap.js");
    const result = await bootstrap({
      email: "test@test.com",
      agentName: "discover-test",
      apiKey: "ocv_discover",
      envPath,
    });

    expect(result.vaultId).toBe("vault-def-456");
  });

  it("backs up existing .env in non-TTY mode", async () => {
    setupMocks();
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "OLD_KEY=old_value\n");

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      const { bootstrap } = await import("../src/bootstrap.js");
      await bootstrap({
        email: "test@test.com",
        agentName: "overwrite-test",
        apiKey: "ocv_overwrite",
        envPath,
      });

      const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith(".env.bak."));
      expect(backups.length).toBe(1);

      const backupContent = fs.readFileSync(path.join(tmpDir, backups[0]), "utf-8");
      expect(backupContent).toContain("OLD_KEY=old_value");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });

  it("handles enrollment failure gracefully", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: "Rate limited" }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { bootstrap } = await import("../src/bootstrap.js");
    await expect(
      bootstrap({
        email: "test@test.com",
        agentName: "fail-test",
        apiKey: "ocv_fail",
        envPath: path.join(tmpDir, ".env"),
      }),
    ).rejects.toThrow("Rate limited");
  });
});
