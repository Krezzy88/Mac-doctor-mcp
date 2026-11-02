import { execFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
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

const execFileAsync = promisify(execFile);

export const findLargeFilesArguments = z
  .object({
    directoryPath: z.string().min(1),
    minSizeMB: z.number().int().min(1).max(1_000_000),
    limit: z.number().int().min(1).max(MAX_FILE_RESULTS),
  })
  .strict();

export const analyzeCachesArguments = z.object({}).strict();

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

const defaultExecFileRunner: ExecFileRunner = async (file, args, options) => {
  const result = await execFileAsync(file, args, options);
  return { stdout: result.stdout };
};

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
