import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SecurityGuard } from "./security.js";
import {
  analyzeCaches,
  type CacheDefinition,
  findLargeFiles,
  findLargeFilesArguments,
  type ExecFileRunner,
} from "./tools.js";

const MEBIBYTE = 1024 * 1024;

describe("find_large_files", () => {
  let temporaryDirectory!: string;
  let allowedDirectory!: string;
  let largeFile!: string;
  let secondLargeFile!: string;
  let smallFile!: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "mac-doctor-tools-"));
    const temporaryAllowedDirectory = join(temporaryDirectory, "Projects");
    await mkdir(temporaryAllowedDirectory);
    allowedDirectory = await realpath(temporaryAllowedDirectory);

    largeFile = join(allowedDirectory, "large file.bin");
    secondLargeFile = join(allowedDirectory, "another-large.bin");
    smallFile = join(allowedDirectory, "small.bin");
    await Promise.all([
      writeFile(largeFile, Buffer.alloc(2 * MEBIBYTE)),
      writeFile(secondLargeFile, Buffer.alloc(3 * MEBIBYTE)),
      writeFile(smallFile, Buffer.alloc(MEBIBYTE - 1)),
    ]);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("parses NUL-delimited find output into file records", async () => {
    const runExecFile = vi.fn<ExecFileRunner>(async () => ({
      stdout: `${largeFile}\0${smallFile}\0${secondLargeFile}\0`,
    }));

    const files = await findLargeFiles(
      {
        directoryPath: allowedDirectory,
        minSizeMB: 1,
        limit: 10,
      },
      new SecurityGuard([allowedDirectory]),
      runExecFile,
    );
    expect(files).toEqual([
      { path: largeFile, size: 2 * MEBIBYTE },
      { path: secondLargeFile, size: 3 * MEBIBYTE },
    ]);
    expect(runExecFile).toHaveBeenCalledWith(
      "/usr/bin/find",
      [
        allowedDirectory,
        "-type",
        "f",
        "-size",
        "+0M",
        "-print0",
      ],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        shell: false,
        timeout: 10_000,
      },
    );
  });

  it("respects the result limit", async () => {
    const runExecFile = vi.fn<ExecFileRunner>(async () => ({
      stdout: `${largeFile}\0${secondLargeFile}\0`,
    }));

    const files = await findLargeFiles(
      {
        directoryPath: allowedDirectory,
        minSizeMB: 1,
        limit: 1,
      },
      new SecurityGuard([allowedDirectory]),
      runExecFile,
    );

    expect(files).toEqual([{ path: largeFile, size: 2 * MEBIBYTE }]);
  });

  it("rejects malformed tool arguments", () => {
    expect(() =>
      findLargeFilesArguments.parse({
        directoryPath: allowedDirectory,
        minSizeMB: 0,
        limit: 101,
      }),
    ).toThrow();
  });

  it("rejects paths returned outside the scanned directory", async () => {
    const runExecFile = vi.fn<ExecFileRunner>(async () => ({
      stdout: `${temporaryDirectory}\0`,
    }));

    await expect(
      findLargeFiles(
        {
          directoryPath: allowedDirectory,
          minSizeMB: 1,
          limit: 10,
        },
        new SecurityGuard([allowedDirectory]),
        runExecFile,
      ),
    ).rejects.toThrow("find returned a path outside the scanned directory");
  });

  it("denies a shell-injection-shaped path before starting a process", async () => {
    const runExecFile = vi.fn<ExecFileRunner>();
    const injectedPath = `${allowedDirectory}; touch /tmp/mac-doctor-injected`;

    await expect(
      findLargeFiles(
        {
          directoryPath: injectedPath,
          minSizeMB: 1,
          limit: 10,
        },
        new SecurityGuard([allowedDirectory]),
        runExecFile,
      ),
    ).rejects.toThrow("Path Access Denied");
    expect(runExecFile).not.toHaveBeenCalled();
  });

  it("reports cache sizes using du without a shell", async () => {
    const cachePath = join(allowedDirectory, "cache");
    await mkdir(cachePath);
    const caches: CacheDefinition[] = [
      { name: "Test cache", paths: [cachePath] },
    ];
    const runExecFile = vi.fn<ExecFileRunner>(async () => ({
      stdout: "42M\tcache\n",
    }));

    await expect(
      analyzeCaches(
        new SecurityGuard([allowedDirectory]),
        runExecFile,
        caches,
      ),
    ).resolves.toBe("Cache sizes (read-only):\nTest cache: 42M");
    expect(runExecFile).toHaveBeenCalledWith(
      "/usr/bin/du",
      ["-sh", await realpath(cachePath)],
      { encoding: "utf8", shell: false, timeout: 10_000 },
    );
  });

  it("reports missing caches and does not invoke du", async () => {
    const runExecFile = vi.fn<ExecFileRunner>();
    const caches: CacheDefinition[] = [
      { name: "Missing cache", paths: [join(allowedDirectory, "missing")] },
    ];

    await expect(
      analyzeCaches(
        new SecurityGuard([allowedDirectory]),
        runExecFile,
        caches,
      ),
    ).resolves.toBe(
      "Cache sizes (read-only):\nMissing cache: unavailable (not found)",
    );
    expect(runExecFile).not.toHaveBeenCalled();
  });

  it("surfaces child-process failures", async () => {
    const cachePath = join(allowedDirectory, "failing-cache");
    await mkdir(cachePath);
    const runExecFile = vi.fn<ExecFileRunner>(async () => {
      throw new Error("du timed out");
    });

    await expect(
      analyzeCaches(
        new SecurityGuard([allowedDirectory]),
        runExecFile,
        [{ name: "Cache", paths: [cachePath] }],
      ),
    ).rejects.toThrow("du timed out");
  });
});
