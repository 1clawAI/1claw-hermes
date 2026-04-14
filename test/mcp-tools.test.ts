import { describe, it, expect, vi, beforeEach } from "vitest";

const secretsSet = vi.fn();
const secretsGet = vi.fn();
const secretsList = vi.fn();

vi.mock("@1claw/sdk", () => ({
  createClient: vi.fn(() => ({
    secrets: {
      get: secretsGet,
      set: secretsSet,
      list: secretsList,
    },
  })),
}));

vi.mock("../src/config.js", () => ({
  config: {
    oneClawApiBase: "https://api.1claw.xyz",
    oneClawVaultId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    oneClawAgentApiKey: "ocv_test_key_123",
  },
  requireVaultId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  requireApiKey: () => "ocv_test_key_123",
}));

import { setSecret, putSecret } from "../src/mcp/tools.js";
import { VaultError } from "../src/errors.js";
import { getClient } from "../src/client.js";

describe("setSecret / putSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClient();
    secretsSet.mockResolvedValue({
      data: { path: "x", version: 1 },
      error: null,
      meta: { status: 200 },
    });
  });

  it("forwards SDK secret type to match MCP put_secret behaviour", async () => {
    await setSecret("passwords/random-generated", "secret-value", {
      type: "api_key",
    });

    expect(secretsSet).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "passwords/random-generated",
      "secret-value",
      { type: "api_key" },
    );
  });

  it("putSecret is an alias of setSecret", () => {
    expect(putSecret).toBe(setSecret);
  });

  it("throws VaultError with HTTP status and detail in the message", async () => {
    secretsSet.mockResolvedValue({
      data: null,
      error: {
        type: "auth_error",
        message: "Forbidden",
        detail: "No matching policy for write",
      },
      meta: { status: 403 },
    });

    await expect(
      setSecret("forbidden/path", "x"),
    ).rejects.toThrow(VaultError);

    await expect(setSecret("forbidden/path", "x")).rejects.toMatchObject({
      code: "SECRET_WRITE_FAILED",
    });

    try {
      await setSecret("forbidden/path", "x");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("HTTP 403");
      expect(msg).toContain("No matching policy for write");
    }
  });
});
