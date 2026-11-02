import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const home = homedir();

export const ALLOWED_DIRECTORIES = [
  join(home, "Downloads"),
  join(home, "Documents"),
  join(home, "Projects"),
  join(home, ".npm"),
  join(home, "Library/Caches/Homebrew"),
  join(home, "Library/Containers/com.docker.docker/Data/vms/0/data"),
  "/opt/homebrew/var/cache",
  "/usr/local/var/cache",
] as const;

function isWithinDirectory(candidate: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return (
    pathFromDirectory === "" ||
    (pathFromDirectory !== ".." &&
      !pathFromDirectory.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromDirectory))
  );
}

export class SecurityGuard {
  constructor(
    private readonly allowedDirectories: readonly string[] =
      ALLOWED_DIRECTORIES,
  ) {}

  async resolveAllowedPath(candidate: string): Promise<string> {
    const resolvedCandidate = resolve(candidate);
    const allowedDirectory = this.allowedDirectories
      .map((directory) => resolve(directory))
      .find((directory) => isWithinDirectory(resolvedCandidate, directory));

    if (!allowedDirectory) {
      throw new Error("Path Access Denied");
    }

    const [canonicalCandidate, canonicalAllowedDirectory] = await Promise.all([
      realpath(resolvedCandidate),
      realpath(allowedDirectory),
    ]);

    if (!isWithinDirectory(canonicalCandidate, canonicalAllowedDirectory)) {
      throw new Error("Path Access Denied");
    }

    return canonicalCandidate;
  }
}
