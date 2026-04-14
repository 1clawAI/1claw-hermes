import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveDotEnvPath } from "../src/dotenv-path.js";

describe("resolveDotEnvPath", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-path-"));
  });

  it("uses explicit path when provided", () => {
    const p = path.join(tmp, "custom.env");
    fs.writeFileSync(p, "X=1\n");
    expect(resolveDotEnvPath({ explicit: p })).toBe(path.resolve(p));
  });

  it("finds .env when startDir is a directory containing .env", () => {
    const envFile = path.join(tmp, ".env");
    fs.writeFileSync(envFile, "ONECLAW_AGENT_API_KEY=ocv_x\n");
    expect(resolveDotEnvPath({ startDir: tmp })).toBe(envFile);
  });

  it("walks up from startDir to parent .env", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "ONECLAW_AGENT_API_KEY=ocv_x\n");
    const sub = path.join(tmp, "a", "b", "c");
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveDotEnvPath({ startDir: sub })).toBe(path.join(tmp, ".env"));
  });
});
