# mac-doctor-mcp

A read-only macOS diagnostic MCP server for checking common developer cache sizes and finding large files in selected directories. It does not delete, move, or modify files.

Tool results are shown as readable Markdown summaries in clients that display text. The disk triage and large-file tools also return structured data separately for AI clients and integrations.

## Requirements

- macOS
- Node.js 20 or newer
- npm

## Install and run

```sh
npm ci
npm run check
npm run build
```

`npm start` builds the TypeScript sources and starts the MCP server over stdio. The server waits for an MCP client and normally prints no startup message. For local development with TypeScript execution, use `npm run dev`.

## Test against real files

Create a disposable test directory under an allowed location and a sample file:

```sh
mkdir -p "$HOME/Projects/mac-doctor-demo"
mkfile -n 25m "$HOME/Projects/mac-doctor-demo/sample-25mb.bin"
du -h "$HOME/Projects/mac-doctor-demo/sample-25mb.bin"
```

Start MCP Inspector from the project directory:

```sh
npm run build
npx --yes @modelcontextprotocol/inspector node "$PWD/dist/index.js"
```

In the Inspector:

1. Connect to the server and verify it lists `diagnose_disk_pressure`, `analyze_caches`, and `find_large_files`.
2. Call `diagnose_disk_pressure` with `{}`. Verify it returns a readable report with disk pressure, measured areas and recommendations.
3. Call `analyze_caches` with `{}` and compare the reported sizes with the cache paths on this Mac.
4. Call `find_large_files` with:

   ```json
   {
     "directoryPath": "/Users/YOUR_USER/Projects/mac-doctor-demo",
     "minSizeMB": 20,
     "limit": 10
   }
   ```

   Replace `YOUR_USER` with the output of `whoami`. The result should include `sample-25mb.bin` with a size of at least 20 MiB.
5. Try `directoryPath: "/etc"` and verify the tool returns `Path Access Denied`.

The sample is sparse, so its logical size may differ from the physical disk space it consumes. The scan is read-only. When finished, remove only the sample created for this test:

```sh
rm "$HOME/Projects/mac-doctor-demo/sample-25mb.bin"
rmdir "$HOME/Projects/mac-doctor-demo"
```

MCP Inspector is a temporary test client; it does not add a dependency to this project. For repeatable automated checks, use `npm run check`.

## Use with AI clients

Build the project first:

```sh
npm run build
pwd
command -v node
```

Use the absolute project path printed by `pwd` and the Node executable path printed by `command -v node` in the configurations below. If an app cannot find `node`, using its absolute path avoids relying on the app's `PATH`.

### Gemini CLI

Gemini CLI supports local stdio MCP servers. Add this entry to `~/.gemini/settings.json`, preserving any existing settings:

```json
{
  "mcpServers": {
    "mac-doctor-mcp": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-mac-doctor/dist/index.js"]
    }
  }
}
```

Replace both placeholders with the paths from the previous commands, then restart Gemini CLI and inspect the available MCP tools (for example with `/mcp`). Gemini CLI is distinct from the Gemini web app; the web app does not launch a local stdio process from this configuration.

### VS Code

Create or update `.vscode/mcp.json` at the workspace root. VS Code uses a `servers` property:

```json
{
  "servers": {
    "mac-doctor-mcp": {
      "type": "stdio",
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-mac-doctor/dist/index.js"]
    }
  }
}
```

Open the file and use VS Code's MCP start control, then inspect and invoke the tools from the Chat view.

### Claude Desktop

In Claude Desktop, open **Settings → Developer → Edit Config**. On macOS, the config is usually `~/Library/Application Support/Claude/claude_desktop_config.json`. Merge this server entry into the existing top-level `mcpServers` object:

```json
{
  "mcpServers": {
    "mac-doctor-mcp": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-mac-doctor/dist/index.js"]
    }
  }
}
```

Save and fully restart Claude Desktop. Start a new conversation, open its MCP tools menu, and invoke `diagnose_disk_pressure`. Do not replace other entries in the config file.

### Other desktop AI apps

The server uses the standard local **stdio** transport. Other clients can connect if they support launching local MCP servers with a command and arguments. Use the same `node` command and `dist/index.js` argument, but follow that client's configuration format: some use `mcpServers`, while VS Code uses `servers`. A web-only AI chat cannot directly launch this local process; it would need an explicitly supported remote MCP integration and a separately hosted server.

Only enable this server in clients you trust. Once connected, the assistant can request these diagnostic tools; all three are intended to read data only.

Client configuration references:

- [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/)
- [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [MCP guide to connecting local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

## Tools

### `diagnose_disk_pressure`

Creates a readable report and structured data for one read-only disk triage, combining available space on the home volume with measured sizes for developer and user-data areas. Results are ordered by measured size and include:

- Volume capacity, available bytes, available percentage, and pressure band.
- The path, measured size, category, measurement status, and cleanup risk for each area.
- A cautious next step tied to the area. Recommendations do not execute actions.

Pressure bands are based on available space: `critical` at 5% or less, `high` at 10% or less, `moderate` at 20% or less, and `healthy` above 20%. `cleanupRisk` distinguishes rebuildable caches that still merit review from personal or active developer data that should not be removed based on size alone. Missing areas and measurement errors are represented explicitly in the report.

The report measures Docker VM data, Projects, npm and Homebrew caches, Downloads, and Documents when those locations exist and pass the path guard. It runs `du -sk` using `execFile`, with a 10-second timeout per process. No files are changed.

### `analyze_caches`

Reports `du -sh` sizes for available Homebrew, npm, and Docker cache paths. Missing caches are reported as unavailable. It never removes or changes cache data.

### `find_large_files`

Scans an allowed directory. The human-readable result lists each file and its size; structured clients also receive a JSON array of records:

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
