import { describe, it, expect } from "vitest";
import { validateIntent } from "../src/intents/guardrails.js";
import { GuardrailViolationError } from "../src/errors.js";
import type { AgentPolicy } from "../src/subagents/policy.js";

function makePolicy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    secretPaths: [],
    permissions: ["read"],
    expiresAfterSeconds: 300,
    maxValueEth: null,
    allowedChains: [],
    allowedAddresses: [],
    ...overrides,
  };
}

describe("validateIntent", () => {
  it("passes for a valid intent with no constraints", () => {
    const policy = makePolicy();
    expect(() =>
      validateIntent({ to: "0xabc", value: "1.0", chain: "base" }, policy),
    ).not.toThrow();
  });

  it("throws CHAIN_NOT_ALLOWED when chain is not in the allowed list", () => {
    const policy = makePolicy({ allowedChains: ["base", "ethereum"] });
    try {
      validateIntent({ to: "0xabc", value: "0.1", chain: "polygon" }, policy);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailViolationError);
      expect((err as GuardrailViolationError).code).toBe("CHAIN_NOT_ALLOWED");
    }
  });

  it("passes when chain is in the allowed list", () => {
    const policy = makePolicy({ allowedChains: ["base", "ethereum"] });
    expect(() =>
      validateIntent({ to: "0xabc", value: "0.1", chain: "base" }, policy),
    ).not.toThrow();
  });

  it("throws VALUE_EXCEEDS_CAP when value is over the limit", () => {
    const policy = makePolicy({ maxValueEth: "0.5" });
    try {
      validateIntent({ to: "0xabc", value: "1.0", chain: "base" }, policy);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailViolationError);
      expect((err as GuardrailViolationError).code).toBe("VALUE_EXCEEDS_CAP");
    }
  });

  it("passes when value equals the cap exactly", () => {
    const policy = makePolicy({ maxValueEth: "1.0" });
    expect(() =>
      validateIntent({ to: "0xabc", value: "1.0", chain: "base" }, policy),
    ).not.toThrow();
  });

  it("throws ADDRESS_NOT_ALLOWED when address is not in the list", () => {
    const policy = makePolicy({
      allowedAddresses: ["0xAllowed1", "0xAllowed2"],
    });
    try {
      validateIntent({ to: "0xNotInList", value: "0.01", chain: "base" }, policy);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailViolationError);
      expect((err as GuardrailViolationError).code).toBe("ADDRESS_NOT_ALLOWED");
    }
  });

  it("matches addresses case-insensitively", () => {
    const policy = makePolicy({
      allowedAddresses: ["0xAbCdEf"],
    });
    expect(() =>
      validateIntent({ to: "0xabcdef", value: "0.01", chain: "base" }, policy),
    ).not.toThrow();
  });

  it("skips address check when allowedAddresses is empty", () => {
    const policy = makePolicy({ allowedAddresses: [] });
    expect(() =>
      validateIntent({ to: "0xAnything", value: "0.01", chain: "base" }, policy),
    ).not.toThrow();
  });
});
