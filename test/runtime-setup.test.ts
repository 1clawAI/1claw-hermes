import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@1claw/sdk", () => ({
  createClient: vi.fn(() => ({})),
}));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setupHermesRuntime, runtimeCredentialsReady } from "../src/runtime/setup.js";

describe("setupHermesRuntime", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "1claw-hermes-rt-"));
    process.env.HERMES_CONFIG_DIR = tmpDir;
    process.env.ONECLAW_AGENT_TOKEN = "eyJ.test.token";
    process.env.ONECLAW_VAULT_ID = "550e8400-e29b-41d4-a716-446655440000";
    process.env.ONECLAW_SHROUD_ENABLED = "1";
    process.env.LLM_PROVIDER = "google";
    process.env.LLM_MODEL = "gemini-2.5-flash";
  });

  afterEach(() => {
    delete process.env.HERMES_CONFIG_DIR;
    delete process.env.ONECLAW_AGENT_TOKEN;
    delete process.env.ONECLAW_VAULT_ID;
    delete process.env.ONECLAW_SHROUD_ENABLED;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_MODEL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("patches Hermes config with JWT MCP and sidecar model URL", async () => {
    const result = await setupHermesRuntime();
    expect(result.sidecarBaseUrl).toBe("http://127.0.0.1:8082/v1");

    const yaml = fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf8");
    expect(yaml).toContain("mcp_servers:");
    expect(yaml).toContain("oneclaw:");
    expect(yaml).toContain("Authorization");
    expect(yaml).toContain("provider: custom");
    expect(yaml).toContain("http://127.0.0.1:8082/v1");
    expect(yaml).toContain("google/gemini-2.5-flash");
  });

  it("runtimeCredentialsReady accepts JWT without ocv_ key", () => {
    expect(runtimeCredentialsReady()).toBe(true);
  });
});
