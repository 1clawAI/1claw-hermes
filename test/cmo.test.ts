import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/talents/cmo/draft-generator.js";

describe("cmo talent", () => {
  it("loads all four briefing docs into the system prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("=== PERSONA ===");
    expect(prompt).toContain("=== ACTIVE CAMPAIGN ===");
    expect(prompt).toContain("=== REFERENCE STYLE (gitlawb) ===");
    expect(prompt).toContain("=== PRODUCT CONTEXT ===");
  });

  it("carries the 30-day campaign strategic anchors", () => {
    const prompt = buildSystemPrompt();
    // Bankr backing is the most important single fact.
    expect(prompt).toMatch(/Bankr.*support.*1clawai/is);
    // 1CLAWAI contract address must be the literal in briefings.
    expect(prompt).toContain("0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3");
    // GITLAWB comp contract.
    expect(prompt).toContain("0x5F980Dcfc4c0fa3911554cf5ab288ed0eb13DBa3");
    // The 4-layer stack framing is the canonical positioning.
    expect(prompt).toMatch(/4-layer stack/i);
    // North star.
    expect(prompt).toMatch(/holders count \+ daily fee revenue/i);
    // Anti-pattern guards.
    expect(prompt).toMatch(/never lean into the .?claw.? meme/i);
    expect(prompt).toMatch(/No price talk in brand-voice posts/i);
  });

  it("carries the key brand phrases the generator must honor", () => {
    const prompt = buildSystemPrompt();
    // Persona phrases that anchor voice.
    expect(prompt).toMatch(/vault layer for the AI-native internet/i);
    expect(prompt).toMatch(/Just-in-time access to secrets/i);
    expect(prompt).toMatch(/Tool calls inspected/i);
    // Style-notes guarantees gitlawb's playbook is in the briefing.
    expect(prompt).toMatch(/quote-tweet hijack/i);
    expect(prompt).toMatch(/stats brag/i);
  });

  it("teaches the model every post format the CLI exposes", () => {
    const prompt = buildSystemPrompt();
    // Formats added from the Apr 2026 timeline capture.
    expect(prompt).toMatch(/milestone announcement/i);
    expect(prompt).toMatch(/release notes/i);
    expect(prompt).toMatch(/dogfooding/i);
    expect(prompt).toMatch(/community poll/i);
    expect(prompt).toMatch(/contributor shoutout/i);
    expect(prompt).toMatch(/big-issue qt/i);
    expect(prompt).toMatch(/external ugc repost/i);
  });

  it("includes the 280-char hard cap and the no-invented-stats rule", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("280 char hard cap");
    expect(prompt).toMatch(/Never invent stats/i);
  });
});
