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

import {
  buildMcpEntry,
  patchHermesConfig,
  patchHermesModel,
  unpatchHermesModel,
} from "../src/mcp/index.js";

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

  it("defaults to stdio @1claw/mcp with env-based api key (no JWT in config)", async () => {
    await patchHermesConfig(tmpDir);

    const configPath = path.join(tmpDir, "config.yaml");
    expect(fs.existsSync(configPath)).toBe(true);

    const parsed = parseYaml(
      fs.readFileSync(configPath, "utf-8"),
    ) as Record<string, unknown>;
    const oneclaw = (parsed.mcp_servers as Record<string, unknown>).oneclaw as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(oneclaw.command).toBe("npx");
    expect(oneclaw.args).toEqual(["-y", "@1claw/mcp"]);
    expect(oneclaw.env.ONECLAW_AGENT_API_KEY).toBe("ocv_test_key_123");
    expect(oneclaw.env.ONECLAW_VAULT_ID).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(oneclaw.env.ONECLAW_BASE_URL).toBe("https://api.1claw.xyz");
  });

  it("http transport writes remote MCP URL with Bearer JWT", async () => {
    await patchHermesConfig(tmpDir, { transport: "http" });

    const configPath = path.join(tmpDir, "config.yaml");
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
    const servers = parsed.mcp_servers as Record<string, { url?: string }>;
    expect(servers.other.url).toBe("http://other.test");
    expect(servers.oneclaw).toBeDefined();
  });

  it("uses config.json when yaml is absent (legacy)", async () => {
    const jsonPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(jsonPath, JSON.stringify({ theme: "light" }));

    await patchHermesConfig(tmpDir);

    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(parsed.theme).toBe("light");
    const oneclaw = parsed.mcpServers.oneclaw;
    expect(oneclaw.command).toBe("npx");
    expect(oneclaw.env.ONECLAW_AGENT_API_KEY).toBe("ocv_test_key_123");
  });
});

describe("patchHermesModel", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-model-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets model.provider=custom and model.base_url to sidecar", async () => {
    await patchHermesModel(tmpDir);

    const parsed = parseYaml(
      fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    const model = parsed.model as Record<string, string>;
    expect(model.provider).toBe("custom");
    expect(model.base_url).toBe("http://127.0.0.1:8080/v1");
  });

  it("accepts custom sidecar base URL and model name", async () => {
    await patchHermesModel(tmpDir, {
      sidecarBaseUrl: "http://10.0.0.5:9090/v1",
      model: "google/gemini-2.5-flash",
    });

    const parsed = parseYaml(
      fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    const model = parsed.model as Record<string, string>;
    expect(model.provider).toBe("custom");
    expect(model.base_url).toBe("http://10.0.0.5:9090/v1");
    expect(model.name).toBe("google/gemini-2.5-flash");
  });

  it("preserves existing yaml keys", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "theme: dark\nmodel:\n  temperature: 0.7\n  name: gpt-4o\n",
    );

    await patchHermesModel(tmpDir);

    const parsed = parseYaml(
      fs.readFileSync(configPath, "utf-8"),
    ) as Record<string, unknown>;
    expect(parsed.theme).toBe("dark");
    const model = parsed.model as Record<string, unknown>;
    expect(model.temperature).toBe(0.7);
    expect(model.provider).toBe("custom");
    expect(model.base_url).toBe("http://127.0.0.1:8080/v1");
    expect(model.name).toBe("gpt-4o");
  });

  it("creates a backup before overwriting", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, "model:\n  provider: openai\n");

    await patchHermesModel(tmpDir);

    const backups = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("config.yaml.bak."));
    expect(backups.length).toBe(1);
  });
});

describe("unpatchHermesModel", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-unpatch-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes custom provider and localhost base_url", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      'model:\n  provider: custom\n  base_url: "http://127.0.0.1:8080/v1"\n  name: gpt-4o\n',
    );

    await unpatchHermesModel(tmpDir);

    const parsed = parseYaml(
      fs.readFileSync(configPath, "utf-8"),
    ) as Record<string, unknown>;
    const model = parsed.model as Record<string, unknown>;
    expect(model.provider).toBeUndefined();
    expect(model.base_url).toBeUndefined();
    expect(model.name).toBe("gpt-4o");
  });

  it("no-ops when no config.yaml exists", async () => {
    await unpatchHermesModel(tmpDir);
    expect(fs.readdirSync(tmpDir).length).toBe(0);
  });
});
