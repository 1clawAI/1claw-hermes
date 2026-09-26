import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@1claw/sdk", () => ({
  createClient: vi.fn(() => ({})),
}));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  setupHermesRuntime,
  runtimeCredentialsReady,
  baseUrlMayHold1ClawCredential,
} from "../src/runtime/setup.js";

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
    // The custom (Shroud) provider must carry the injected agent JWT, or Shroud
    // rejects the request with 401 (no usable agent key).
    expect(yaml).toContain("api_key: eyJ.test.token");
    // ...and X-Shroud-Provider (from LLM_PROVIDER=google), or Shroud rejects the
    // request with "HTTP 400: missing X-Shroud-Provider header".
    expect(yaml).toContain("X-Shroud-Provider: google");
  });

  it("runtimeCredentialsReady accepts JWT without ocv_ key", () => {
    expect(runtimeCredentialsReady()).toBe(true);
  });

  // HERMESCRED-M1, at the call site. The check above proves the predicate is
  // correct; this proves it is actually consulted before the credential is
  // written. Without it the predicate could be perfect and unused.
  it("never writes the agent credential for a non-1Claw base URL", async () => {
    process.env.ONECLAW_SHROUD_ENABLED = "0";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_API_KEY = "sk-tenants-own-key";

    const result = await setupHermesRuntime();
    expect(result.sidecarBaseUrl).toBe("https://openrouter.ai/api/v1");

    const yaml = fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf8");

    // Scoped to the `model:` block on purpose. The JWT legitimately stays in
    // `mcp_servers:`, whose URL is mcp.1claw.co — that Authorization header
    // goes to us. It is only the model provider that now talks to OpenRouter,
    // and that is the one that must not carry a vault credential.
    const modelBlock = yaml.slice(yaml.indexOf("model:"));
    expect(modelBlock).not.toContain("eyJ.test.token");
    expect(modelBlock).toContain("api_key: sk-tenants-own-key");

    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });
});

/**
 * HERMESCRED-M1. The Hermes custom provider sends its `api_key` as a Bearer
 * token to whatever `OPENAI_BASE_URL` resolves to. That key used to be the
 * agent's vault credential unconditionally, so a tenant who pointed the base
 * URL at any third party — by mistake or on purpose — handed that host a token
 * carrying the agent's scopes for its whole TTL.
 */
describe("baseUrlMayHold1ClawCredential", () => {
  it("trusts the in-container sidecar and 1Claw's own hosts", () => {
    for (const url of [
      "http://127.0.0.1:8082/v1",
      "http://[::1]:8082/v1",
      "https://shroud.1claw.co/v1",
      "https://shroud.1claw.xyz/v1",
      "https://1claw.co/v1",
    ]) {
      expect(baseUrlMayHold1ClawCredential(url), url).toBe(true);
    }
  });

  it("refuses every host that is not ours", () => {
    for (const url of [
      // The benign misconfiguration from the finding.
      "https://openrouter.ai/api/v1",
      "https://evil.example/v1",
      // Suffix-match traps: both contain "1claw.co" as a substring.
      "https://shroud.1claw.co.evil.example/v1",
      "https://not1claw.co/v1",
      // Plaintext to a remote host: a pinned host over http is still readable
      // by anything on the path.
      "http://shroud.1claw.co/v1",
      // Loopback-adjacent but not loopback. `localhost` is /etc/hosts-settable
      // inside the container, and 10.x is somebody else's machine.
      "http://localhost:8082/v1",
      "http://10.0.0.5:8082/v1",
      // Unparseable input must fail closed, not throw.
      "",
      "not a url",
    ]) {
      expect(baseUrlMayHold1ClawCredential(url), url).toBe(false);
    }
  });
});
