import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecurityGuard } from "./security.js";

describe("SecurityGuard", () => {
  let temporaryDirectory!: string;
  let allowedDirectory!: string;
  let outsideDirectory!: string;
  let guard!: SecurityGuard;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "mac-doctor-security-"));
    allowedDirectory = join(temporaryDirectory, "allowed");
    outsideDirectory = join(temporaryDirectory, "outside");
    await Promise.all([
      mkdir(allowedDirectory),
      mkdir(outsideDirectory),
    ]);
    guard = new SecurityGuard([allowedDirectory]);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("allows the exact allowlisted directory and descendants", async () => {
    const childDirectory = join(allowedDirectory, "nested");
    await mkdir(childDirectory);
    const canonicalAllowedDirectory = await realpath(allowedDirectory);
    const canonicalChildDirectory = await realpath(childDirectory);

    await expect(
      guard.resolveAllowedPath(allowedDirectory),
    ).resolves.toBe(canonicalAllowedDirectory);
    await expect(
      guard.resolveAllowedPath(childDirectory),
    ).resolves.toBe(canonicalChildDirectory);
  });

  it.each([
    {
      description: "parent traversal",
      getPath: (allowed: string) => join(allowed, ".."),
    },
    {
      description: "nested traversal",
      getPath: (allowed: string) => join(allowed, "../outside"),
    },
    {
      description: "relative traversal",
      getPath: () => "../../etc/shadow",
    },
    {
      description: "absolute sensitive path",
      getPath: () => "/etc/shadow",
    },
    {
      description: "sibling with matching prefix",
      getPath: (allowed: string) => `${allowed}-private`,
    },
  ])("blocks $description", async ({ getPath }) => {
    await expect(
      guard.resolveAllowedPath(getPath(allowedDirectory)),
    ).rejects.toThrow(
      "Path Access Denied",
    );
  });

  it("blocks a symlink that resolves outside the allowlist", async () => {
    const escapingLink = join(allowedDirectory, "escape");
    await symlink(outsideDirectory, escapingLink);

    await expect(guard.resolveAllowedPath(escapingLink)).rejects.toThrow(
      "Path Access Denied",
    );
  });

  it("blocks candidates when no directory is allowlisted", async () => {
    const emptyGuard = new SecurityGuard([]);

    await expect(
      emptyGuard.resolveAllowedPath(allowedDirectory),
    ).rejects.toThrow("Path Access Denied");
  });

  it("does not convert filesystem resolution errors into access denials", async () => {
    await expect(
      guard.resolveAllowedPath(join(allowedDirectory, "does-not-exist")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves relative allowlist entries before validating candidates", async () => {
    const relativeDirectory = relative(process.cwd(), allowedDirectory);
    const relativeGuard = new SecurityGuard([relativeDirectory]);

    await expect(
      relativeGuard.resolveAllowedPath(allowedDirectory),
    ).resolves.toBe(await realpath(allowedDirectory));
  });
});
