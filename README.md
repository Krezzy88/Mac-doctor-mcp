# mac-doctor-mcp

A read-only macOS diagnostic MCP server for checking common developer cache sizes and finding large files in selected directories. It does not delete, move, or modify files.

## Requirements

- macOS
- Node.js 20 or newer
- npm

## Install and run

```sh
npm ci
npm run check
npm start
```

`npm start` builds the TypeScript sources and starts the MCP server over stdio. For local development with TypeScript execution, use `npm run dev`.

## MCP client configuration

Build the project first, then configure an MCP client to launch the built server. For example, a client that accepts JSON MCP server configuration can use:

```json
{
  "mcpServers": {
    "mac-doctor-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-mac-doctor/dist/index.js"]
    }
  }
}
```

Replace the example path with the absolute path to this project's `dist/index.js`. The server communicates using stdio; stdout is reserved for MCP messages.

## Tools

### `analyze_caches`

Reports `du -sh` sizes for available Homebrew, npm, and Docker cache paths. Missing caches are reported as unavailable. It never removes or changes cache data.

### `find_large_files`

Scans an allowed directory and returns a JSON array of records:

```json
[
  {
    "path": "/Users/example/Projects/archive.zip",
    "size": 2097152
  }
]
```

Arguments:

| Name | Type | Constraints |
| --- | --- | --- |
| `directoryPath` | string | Must resolve inside one of the allowlisted directories |
| `minSizeMB` | integer | 1–1,000,000 MiB |
| `limit` | integer | 1–100 results |

Paths are checked against canonical paths, including symlink resolution. The `find` invocation is passed as an argument array to `execFile`, with a 10-second timeout, an 8 MiB output cap, and no shell. File records include byte sizes. The server validates returned paths again before reading file metadata.

## Access boundaries

The path allowlist is built from the current user's home directory and includes:

- `~/Downloads`
- `~/Documents`
- `~/Projects`
- `~/.npm`
- `~/Library/Caches/Homebrew`
- `~/Library/Containers/com.docker.docker/Data/vms/0/data`
- `/opt/homebrew/var/cache`
- `/usr/local/var/cache`

Only paths within these locations can be scanned. Cache analysis also checks each existing cache path against this allowlist. Filesystem permission errors and child-process failures are returned as tool errors rather than hidden.

This is a local diagnostic utility, not a sandbox. Keep the allowlist narrow and review changes to it before exposing the server to an assistant. Path validation uses canonical paths, but—as with ordinary path-based filesystem operations—cannot make a mutable filesystem immune to every time-of-check/time-of-use race. Run the server as an unprivileged user and do not grant it elevated permissions.

## Development

```sh
npm run dev
npm run typecheck
npm test
npm run test:coverage
npm run build
```

The security-guard suite enforces 100% statement, branch, function, and line coverage. Tests use temporary directories and mocked child-process calls where appropriate. GitHub Actions runs the checks on macOS with Node.js 20, 22, and 24.

## License

ISC. See [LICENSE](./LICENSE).
