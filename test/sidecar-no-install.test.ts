/**
 * The sidecar binary is resolved, never installed.
 *
 * Hermes used to fetch `install.sh` from the sidecar repo's `main` branch and
 * pipe it to `sh` when the binary was missing. The script was sound in itself —
 * release artifacts, sha256 verification, version pinning — but the arrangement
 * was not: its checksum step warned and continued when `checksums.txt` could
 * not be fetched, we fetched the script from `main` rather than a tag, and it
 * resolved the *latest* release at install time, so two installs a week apart
 * produced different binaries.
 *
 * The binary now arrives as a platform-specific optional dependency, so npm
 * pins the version through the lockfile and verifies the tarball, and nothing
 * is downloaded or executed here. These tests hold that: no shell string, no
 * install script, and a resolution order that ends in instructions rather than
 * a download.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "shroud", "sidecar.ts"),
  "utf8",
);

/** Source with comments removed — the fix explains itself by quoting what it
 *  replaced, and without this the assertions match that prose. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("the sidecar is never installed at runtime", () => {
  it("does not fetch or execute an install script", () => {
    expect(CODE).not.toMatch(/install\.sh/);
    expect(CODE).not.toMatch(/raw\.githubusercontent\.com/);
    // `sh <script>` and `curl … | sh` are both gone.
    expect(CODE).not.toMatch(/execFileSync\(\s*["']sh["']/);
    expect(CODE).not.toMatch(/execFileSync\(\s*["']curl["']/);
  });

  it("uses no shell string anywhere", () => {
    // execSync runs a shell; execFileSync does not. Aikido found the same
    // pattern in the CLI, where an interpolated value did execute.
    expect(CODE).not.toMatch(/\bexecSync\s*\(/);
    expect(CODE).not.toMatch(/\bexec\s*\(/);
  });

  it("declares both platform packages as optional dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    );
    const opt = pkg.optionalDependencies ?? {};
    expect(Object.keys(opt)).toContain("@1claw/shroud-sidecar-linux-x64");
    expect(Object.keys(opt)).toContain("@1claw/shroud-sidecar-darwin-arm64");
    // Optional, not required: an unsupported platform must still install.
    for (const name of Object.keys(opt)) {
      expect(pkg.dependencies ?? {}).not.toHaveProperty(name);
    }
  });

  it("tries the platform package before PATH", () => {
    const fn = CODE.slice(CODE.indexOf("function resolveSidecarBinary"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const pkgAt = body.indexOf("binaryFromPackage");
    const pathAt = body.indexOf("findBinary");
    expect(pkgAt).toBeGreaterThan(-1);
    expect(pathAt).toBeGreaterThan(-1);
    expect(
      pkgAt < pathAt,
      "the pinned, integrity-checked copy should win over whatever is on PATH",
    ).toBe(true);
  });

  it("names a way forward when nothing is found", () => {
    const fn = CODE.slice(CODE.indexOf("function resolveSidecarBinary"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // An error that only says "not found" leaves the reader stuck; the usual
    // cause is an install that skipped optional packages.
    expect(body).toMatch(/npm install/);
    expect(body).toMatch(/go build/);
  });

  it("still honours a binary left by the old installer", () => {
    // Machines that ran the old curl-to-sh path have one in ~/.local/bin, and
    // removing this would break them for no benefit.
    const fn = CODE.slice(CODE.indexOf("function resolveSidecarBinary"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/localBin\(\)/);
  });
});
