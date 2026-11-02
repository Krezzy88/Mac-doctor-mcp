import { execFile } from "node:child_process";
import { lstat, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { SecurityGuard } from "./security.js";

const EXEC_TIMEOUT_MS = 10_000;
const MAX_FIND_OUTPUT_BYTES = 8 * 1024 * 1024;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const home = homedir();

export const MAX_FILE_RESULTS = 100;

export type CacheDefinition = {
  name: string;
  paths: readonly string[];
};

export type DiagnosticAreaDefinition = CacheDefinition & {
  id: string;
  category: "cache" | "developer-data" | "user-files";
  cleanupRisk: "low" | "review" | "high";
  recommendation: string;
};

export type DiagnosticAreaResult = {
  id: string;
  name: string;
  category: DiagnosticAreaDefinition["category"];
  path: string | null;
  sizeBytes: number | null;
  status: "measured" | "missing" | "error";
  cleanupRisk: DiagnosticAreaDefinition["cleanupRisk"];
  recommendation: string;
  error?: string;
};

export type DiskTriageReport = {
  generatedAt: string;
  readOnly: true;
  volume: {
    path: string;
    totalBytes: number;
    availableBytes: number;
    availablePercent: number;
    pressure: "critical" | "high" | "moderate" | "healthy";
  };
  areas: DiagnosticAreaResult[];
};

const CACHE_PATHS: readonly CacheDefinition[] = [
  {
    name: "Homebrew",
    paths: [
      join(home, "Library/Caches/Homebrew"),
      "/opt/homebrew/var/cache",
      "/usr/local/var/cache",
    ],
  },
  { name: "npm", paths: [join(home, ".npm")] },
  {
    name: "Docker",
    paths: [
      join(
        home,
        "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw",
      ),
    ],
  },
] as const;

const DIAGNOSTIC_AREAS: readonly DiagnosticAreaDefinition[] = [
  {
    id: "docker",
    name: "Docker VM data",
    category: "developer-data",
    paths: [
      join(
        home,
        "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw",
      ),
    ],
    cleanupRisk: "high",
    recommendation:
      "Review Docker disk usage in Docker Desktop; do not remove VM data files manually.",
  },
  {
    id: "projects",
    name: "Projects",
    category: "developer-data",
    paths: [join(home, "Projects")],
    cleanupRisk: "high",
    recommendation:
      "Inspect large project build outputs and dependencies individually; preserve source and uncommitted work.",
  },
  {
    id: "npm-cache",
    name: "npm cache",
    category: "cache",
    paths: [join(home, ".npm")],
    cleanupRisk: "review",
    recommendation:
      "Check npm cache health and package-manager needs before considering cache maintenance.",
  },
  {
    id: "homebrew-cache",
    name: "Homebrew cache",
    category: "cache",
    paths: [
      join(home, "Library/Caches/Homebrew"),
      "/opt/homebrew/var/cache",
      "/usr/local/var/cache",
    ],
    cleanupRisk: "review",
    recommendation:
      "Review cached downloads and Homebrew's own cleanup guidance; no files were changed.",
  },
  {
    id: "downloads",
    name: "Downloads",
    category: "user-files",
    paths: [join(home, "Downloads")],
    cleanupRisk: "high",
    recommendation:
      "Review files by name and purpose; move or remove only items you recognize and no longer need.",
  },
  {
    id: "documents",
    name: "Documents",
    category: "user-files",
    paths: [join(home, "Documents")],
    cleanupRisk: "high",
    recommendation:
      "Review files by name and purpose; do not treat document size alone as evidence that a file is disposable.",
  },
];

const execFileAsync = promisify(execFile);

export const findLargeFilesArguments = z
  .object({
    directoryPath: z.string().min(1),
    minSizeMB: z.number().int().min(1).max(1_000_000),
    limit: z.number().int().min(1).max(MAX_FILE_RESULTS),
  })
  .strict();

export const analyzeCachesArguments = z.object({}).strict();
export const diagnoseDiskPressureArguments = z.object({}).strict();

export type LargeFile = {
  path: string;
  size: number;
};

export type ExecFileRunner = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    maxBuffer?: number;
    shell: false;
    timeout: number;
  },
) => Promise<{ stdout: string }>;

type VolumeStats = {
  bsize: number;
  blocks: number;
  bavail: number;
};

export type DiskTriageDependencies = {
  securityGuard: SecurityGuard;
  runExecFile: ExecFileRunner;
  areas: readonly DiagnosticAreaDefinition[];
  readVolumeStats: () => Promise<VolumeStats>;
  now: () => Date;
};

const defaultExecFileRunner: ExecFileRunner = async (file, args, options) => {
  const result = await execFileAsync(file, args, options);
  return { stdout: result.stdout };
};

const defaultDiskTriageDependencies: DiskTriageDependencies = {
  securityGuard: new SecurityGuard(),
  runExecFile: defaultExecFileRunner,
  areas: DIAGNOSTIC_AREAS,
  readVolumeStats: () => statfs(home),
  now: () => new Date(),
};

export async function diagnoseDiskPressure(
  dependencies: Partial<DiskTriageDependencies> = {},
): Promise<DiskTriageReport> {
  const { securityGuard, runExecFile, areas, readVolumeStats, now } = {
    ...defaultDiskTriageDependencies,
    ...dependencies,
  };
  const volumeStats = await readVolumeStats();
  const totalBytes = volumeStats.bsize * volumeStats.blocks;
  const availableBytes = volumeStats.bsize * volumeStats.bavail;

  if (
    !Number.isSafeInteger(volumeStats.bsize) ||
    volumeStats.bsize <= 0 ||
    !Number.isSafeInteger(volumeStats.blocks) ||
    volumeStats.blocks <= 0 ||
    !Number.isSafeInteger(volumeStats.bavail) ||
    volumeStats.bavail < 0 ||
    volumeStats.bavail > volumeStats.blocks ||
    !Number.isSafeInteger(totalBytes) ||
    !Number.isSafeInteger(availableBytes) ||
    availableBytes > totalBytes
  ) {
    throw new Error("Could not read valid disk capacity information");
  }

  const availablePercent = Number(
    ((availableBytes / totalBytes) * 100).toFixed(1),
  );
  const pressure = getDiskPressure(availablePercent);
  const areaResults = await Promise.all(
    areas.map((area) => measureDiagnosticArea(area, securityGuard, runExecFile)),
  );

  areaResults.sort((left, right) => {
    if (left.sizeBytes === null) return 1;
    if (right.sizeBytes === null) return -1;
    return right.sizeBytes - left.sizeBytes;
  });

  return {
    generatedAt: now().toISOString(),
    readOnly: true,
    volume: {
      path: home,
      totalBytes,
      availableBytes,
      availablePercent,
      pressure,
    },
    areas: areaResults,
  };
}

async function measureDiagnosticArea(
  area: DiagnosticAreaDefinition,
  securityGuard: SecurityGuard,
  runExecFile: ExecFileRunner,
): Promise<DiagnosticAreaResult> {
  let measuredPath: string | null = null;

  try {
    const existingPath = await firstExistingCachePath(area.paths);
    if (!existingPath) {
      return {
        id: area.id,
        name: area.name,
        category: area.category,
        path: null,
        sizeBytes: null,
        status: "missing",
        cleanupRisk: area.cleanupRisk,
        recommendation: area.recommendation,
      };
    }

    const allowedPath = await securityGuard.resolveAllowedPath(existingPath);
    measuredPath = allowedPath;
    const { stdout } = await runExecFile(
      "/usr/bin/du",
      ["-sk", allowedPath],
      {
        encoding: "utf8",
        shell: false,
        timeout: EXEC_TIMEOUT_MS,
      },
    );
    const match = /^(\d+)\s+/u.exec(stdout);
    const sizeInKiB = match?.[1] ? Number(match[1]) : Number.NaN;

    if (!Number.isSafeInteger(sizeInKiB) || sizeInKiB < 0) {
      throw new Error(`Could not parse disk usage for ${area.name}`);
    }

    return {
      id: area.id,
      name: area.name,
      category: area.category,
      path: allowedPath,
      sizeBytes: sizeInKiB * 1024,
      status: "measured",
      cleanupRisk: area.cleanupRisk,
      recommendation: area.recommendation,
    };
  } catch (error: unknown) {
    return {
      id: area.id,
      name: area.name,
      category: area.category,
      path: measuredPath,
      sizeBytes: null,
      status: "error",
      cleanupRisk: area.cleanupRisk,
      recommendation: area.recommendation,
      error: getErrorMessage(error),
    };
  }
}

function getDiskPressure(
  availablePercent: number,
): DiskTriageReport["volume"]["pressure"] {
  if (availablePercent <= 5) return "critical";
  if (availablePercent <= 10) return "high";
  if (availablePercent <= 20) return "moderate";
  return "healthy";
}

export async function analyzeCaches(
  securityGuard = new SecurityGuard(),
  runExecFile: ExecFileRunner = defaultExecFileRunner,
  cachePaths: readonly CacheDefinition[] = CACHE_PATHS,
): Promise<string> {
  const results: string[] = [];

  for (const cache of cachePaths) {
    const existingPath = await firstExistingCachePath(cache.paths);
    if (!existingPath) {
      results.push(`${cache.name}: unavailable (not found)`);
      continue;
    }

    const allowedPath = await securityGuard.resolveAllowedPath(existingPath);
    const { stdout } = await runExecFile(
      "/usr/bin/du",
      ["-sh", allowedPath],
      {
        encoding: "utf8",
        shell: false,
        timeout: EXEC_TIMEOUT_MS,
      },
    );
    const size = stdout.trim().split(/\s+/u)[0];

    if (!size) {
      throw new Error(`Could not read the size of ${cache.name} cache`);
    }

    results.push(`${cache.name}: ${size}`);
  }

  return `Cache sizes (read-only):\n${results.join("\n")}`;
}

async function firstExistingCachePath(
  paths: readonly string[],
): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await lstat(path);
      return path;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return undefined;
}

export async function findLargeFiles(
  args: z.infer<typeof findLargeFilesArguments>,
  securityGuard = new SecurityGuard(),
  runExecFile: ExecFileRunner = defaultExecFileRunner,
): Promise<LargeFile[]> {
  const directoryPath = await securityGuard.resolveAllowedPath(
    args.directoryPath,
  );
  const directoryStats = await stat(directoryPath);
  if (!directoryStats.isDirectory()) {
    throw new Error("directoryPath must be a directory");
  }

  const { stdout } = await runExecFile(
    "/usr/bin/find",
    [
      directoryPath,
      "-type",
      "f",
      "-size",
      `+${args.minSizeMB - 1}M`,
      "-print0",
    ],
    {
      encoding: "utf8",
      maxBuffer: MAX_FIND_OUTPUT_BYTES,
      shell: false,
      timeout: EXEC_TIMEOUT_MS,
    },
  );

  const candidates = stdout.split("\0").filter(Boolean);
  const matches: LargeFile[] = [];
  for (const path of candidates) {
    if (!isWithinDirectory(path, directoryPath)) {
      throw new Error("find returned a path outside the scanned directory");
    }

    const fileStats = await lstat(path);
    if (
      fileStats.isFile() &&
      fileStats.size >= args.minSizeMB * BYTES_PER_MEGABYTE
    ) {
      matches.push({ path, size: fileStats.size });
      if (matches.length === args.limit) {
        break;
      }
    }
  }

  return matches;
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return (
    pathFromDirectory !== "" &&
    pathFromDirectory !== ".." &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromDirectory)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
