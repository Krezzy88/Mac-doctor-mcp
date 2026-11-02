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
  diagnoseDiskPressure,
  type CacheDefinition,
  type DiagnosticAreaDefinition,
  findLargeFiles,
  findLargeFilesArguments,
  type ExecFileRunner,
} from "./tools.js";

const MEBIBYTE = 1024 * 1024;

describe("tool operations", () => {
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

  describe("diagnose_disk_pressure", () => {
    let temporaryDirectory!: string;
    let allowedDirectory!: string;

    beforeEach(async () => {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "mac-doctor-triage-"));
      const target = join(temporaryDirectory, "Projects");
      await mkdir(target);
      allowedDirectory = await realpath(target);
    });

    afterEach(async () => {
      await rm(temporaryDirectory, { recursive: true, force: true });
    });

    it("reports measured areas, missing locations, risk, and disk pressure", async () => {
      const largeAreaPath = join(allowedDirectory, "docker-data");
      const smallAreaPath = join(allowedDirectory, "npm-cache");
      await Promise.all([mkdir(largeAreaPath), mkdir(smallAreaPath)]);
      const areas: DiagnosticAreaDefinition[] = [
        {
          id: "npm",
          name: "npm cache",
          category: "cache",
          paths: [smallAreaPath],
          cleanupRisk: "review",
          recommendation: "Review package-manager needs.",
        },
        {
          id: "docker",
          name: "Docker data",
          category: "developer-data",
          paths: [largeAreaPath],
          cleanupRisk: "high",
          recommendation: "Use Docker Desktop to review disk usage.",
        },
        {
          id: "missing",
          name: "Missing area",
          category: "user-files",
          paths: [join(allowedDirectory, "not-created")],
          cleanupRisk: "high",
          recommendation: "Review manually.",
        },
      ];
      const runExecFile = vi.fn<ExecFileRunner>(async (_file, args) => ({
        stdout: `${args[1] === await realpath(largeAreaPath) ? 4096 : 512}\t${args[1]}\n`,
      }));

      const report = await diagnoseDiskPressure({
        securityGuard: new SecurityGuard([allowedDirectory]),
        runExecFile,
        areas,
        readVolumeStats: async () => ({
          bsize: 1024,
          blocks: 1_000_000,
          bavail: 40_000,
        }),
        now: () => new Date("2026-11-02T00:00:00.000Z"),
      });

      expect(report).toEqual({
        generatedAt: "2026-11-02T00:00:00.000Z",
        readOnly: true,
        volume: {
          path: expect.any(String),
          totalBytes: 1_024_000_000,
          availableBytes: 40_960_000,
          availablePercent: 4,
          pressure: "critical",
        },
        areas: [
          {
            id: "docker",
            name: "Docker data",
            category: "developer-data",
            path: largeAreaPath,
            sizeBytes: 4_194_304,
            status: "measured",
            cleanupRisk: "high",
            recommendation: "Use Docker Desktop to review disk usage.",
          },
          {
            id: "npm",
            name: "npm cache",
            category: "cache",
            path: smallAreaPath,
            sizeBytes: 524_288,
            status: "measured",
            cleanupRisk: "review",
            recommendation: "Review package-manager needs.",
          },
          {
            id: "missing",
            name: "Missing area",
            category: "user-files",
            path: null,
            sizeBytes: null,
            status: "missing",
            cleanupRisk: "high",
            recommendation: "Review manually.",
          },
        ],
      });
    });

    it.each([
      [5, "critical"],
      [5.1, "high"],
      [10, "high"],
      [10.1, "moderate"],
      [20, "moderate"],
      [20.1, "healthy"],
    ] as const)(
      "classifies %.1f%% available disk space as %s",
      async (availablePercent, pressure) => {
        const report = await diagnoseDiskPressure({
          areas: [],
          readVolumeStats: async () => ({
            bsize: 1,
            blocks: 10_000,
            bavail: Math.round(availablePercent * 100),
          }),
        });

        expect(report.volume.pressure).toBe(pressure);
        expect(report.volume.availablePercent).toBe(availablePercent);
      },
    );

    it("surfaces measurement and path-access failures in individual area results", async () => {
      const outsidePath = join(temporaryDirectory, "outside");
      await mkdir(outsidePath);
      const report = await diagnoseDiskPressure({
        securityGuard: new SecurityGuard([allowedDirectory]),
        areas: [
          {
            id: "outside",
            name: "Outside area",
            category: "user-files",
            paths: [outsidePath],
            cleanupRisk: "high",
            recommendation: "Review manually.",
          },
        ],
        readVolumeStats: async () => ({
          bsize: 1,
          blocks: 100,
          bavail: 50,
        }),
      });

      expect(report.areas[0]).toMatchObject({
        id: "outside",
        status: "error",
        sizeBytes: null,
        error: "Path Access Denied",
      });
    });

    it("fails explicitly when volume statistics are invalid", async () => {
      await expect(
        diagnoseDiskPressure({
          areas: [],
          readVolumeStats: async () => ({
            bsize: 1,
            blocks: Number.MAX_SAFE_INTEGER + 1,
            bavail: 10,
          }),
        }),
      ).rejects.toThrow("Could not read valid disk capacity information");
    });

    it("preserves du failures and reports invalid output", async () => {
      const areaPath = join(allowedDirectory, "unreadable");
      await mkdir(areaPath);
      const area: DiagnosticAreaDefinition = {
        id: "unreadable",
        name: "Unreadable area",
        category: "cache",
        paths: [areaPath],
        cleanupRisk: "review",
        recommendation: "Retry after checking permissions.",
      };

      const failedReport = await diagnoseDiskPressure({
        securityGuard: new SecurityGuard([allowedDirectory]),
        runExecFile: vi.fn<ExecFileRunner>(async () => {
          throw new Error("du timed out");
        }),
        areas: [area],
        readVolumeStats: async () => ({ bsize: 1, blocks: 100, bavail: 50 }),
      });
      expect(failedReport.areas[0]).toMatchObject({
        status: "error",
        error: "du timed out",
      });

      const malformedReport = await diagnoseDiskPressure({
        securityGuard: new SecurityGuard([allowedDirectory]),
        runExecFile: vi.fn<ExecFileRunner>(async () => ({ stdout: "unknown\n" })),
        areas: [area],
        readVolumeStats: async () => ({ bsize: 1, blocks: 100, bavail: 50 }),
      });
      expect(malformedReport.areas[0]).toMatchObject({
        status: "error",
        error: "Could not parse disk usage for Unreadable area",
      });
    });
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
