import { describe, it, expect, vi } from "vitest";

vi.mock("@1claw/sdk", () => ({
  createClient: vi.fn(() => ({})),
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
}));

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      baseURL: string;
      apiKey: string;
      defaultHeaders: Record<string, string>;
      constructor(opts: { baseURL: string; apiKey: string; defaultHeaders?: Record<string, string> }) {
        this.baseURL = opts.baseURL;
        this.apiKey = opts.apiKey;
        this.defaultHeaders = opts.defaultHeaders ?? {};
      }
    },
  };
});

import { createShroudClient } from "../src/shroud/index.js";
import { logShroudResponse } from "../src/shroud/middleware.js";

describe("createShroudClient", () => {
  it("sets the baseURL to the Shroud endpoint", () => {
    const client = createShroudClient() as unknown as {
      baseURL: string;
      apiKey: string;
      defaultHeaders: Record<string, string>;
    };
    expect(client.baseURL).toBe("https://shroud.1claw.xyz/v1");
  });

  it("sets the apiKey to the Shroud token", () => {
    const client = createShroudClient() as unknown as {
      apiKey: string;
    };
    expect(client.apiKey).toBe("shroud-tok");
  });

  it("includes the X-Shroud-Provider header", () => {
    const client = createShroudClient() as unknown as {
      defaultHeaders: Record<string, string>;
    };
    expect(client.defaultHeaders["X-Shroud-Provider"]).toBe("anthropic");
  });
});

describe("logShroudResponse", () => {
  it("parses redacted count from headers", () => {
    const headers = new Headers({
      "x-shroud-redacted-count": "3",
    });
    const result = logShroudResponse(headers, vi.fn());
    expect(result.redactedCount).toBe(3);
    expect(result.injectionScore).toBeNull();
  });

  it("parses injection score from headers", () => {
    const headers = new Headers({
      "x-shroud-injection-score": "0.42",
    });
    const result = logShroudResponse(headers, vi.fn());
    expect(result.injectionScore).toBeCloseTo(0.42);
    expect(result.redactedCount).toBeNull();
  });

  it("returns nulls when headers are absent", () => {
    const headers = new Headers();
    const result = logShroudResponse(headers, vi.fn());
    expect(result.redactedCount).toBeNull();
    expect(result.injectionScore).toBeNull();
  });

  it("logs a warning when injection score is high", () => {
    const headers = new Headers({
      "x-shroud-injection-score": "0.85",
    });
    const log = vi.fn();
    logShroudResponse(headers, log);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "High injection score detected by Shroud",
      expect.objectContaining({ injectionScore: 0.85 }),
    );
  });

  it("logs info when values are present but injection is low", () => {
    const headers = new Headers({
      "x-shroud-redacted-count": "1",
      "x-shroud-injection-score": "0.1",
    });
    const log = vi.fn();
    logShroudResponse(headers, log);
    expect(log).toHaveBeenCalledWith(
      "info",
      "Shroud inspection completed",
      expect.objectContaining({ redactedCount: 1, injectionScore: 0.1 }),
    );
  });
});
