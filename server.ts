import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  analyzeCaches,
  analyzeCachesArguments,
  findLargeFiles,
  findLargeFilesArguments,
  MAX_FILE_RESULTS,
  type LargeFile,
} from "./tools.js";

type ToolHandlers = {
  analyzeCaches: () => Promise<string>;
  findLargeFiles: (
    args: ReturnType<typeof findLargeFilesArguments.parse>,
  ) => Promise<LargeFile[]>;
};

const defaultToolHandlers: ToolHandlers = { analyzeCaches, findLargeFiles };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMacDoctorServer(
  toolHandlers: ToolHandlers = defaultToolHandlers,
): Server {
  const server = new Server(
    { name: "mac-doctor-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "analyze_caches",
        description:
          "Returns the size of common macOS development caches (Homebrew, npm, and Docker) without modifying them.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "find_large_files",
        description:
          "Finds large files in an allowed directory without modifying them.",
        inputSchema: {
          type: "object",
          properties: {
            directoryPath: {
              type: "string",
              description:
                "Directory to scan; must be inside Downloads, Documents, Projects, or an allowed cache directory.",
            },
            minSizeMB: {
              type: "integer",
              minimum: 1,
              maximum: 1_000_000,
              description: "Minimum file size in MiB.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_FILE_RESULTS,
              description: "Maximum number of matching files to return.",
            },
          },
          required: ["directoryPath", "minSizeMB", "limit"],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === "analyze_caches") {
        analyzeCachesArguments.parse(request.params.arguments ?? {});
        return {
          content: [{ type: "text", text: await toolHandlers.analyzeCaches() }],
        };
      }

      if (request.params.name === "find_large_files") {
        const args = findLargeFilesArguments.parse(request.params.arguments);
        const files = await toolHandlers.findLargeFiles(args);
        return {
          content: [{ type: "text", text: JSON.stringify(files) }],
        };
      }

      return {
        content: [
          { type: "text", text: `Unknown tool: ${request.params.name}` },
        ],
        isError: true,
      };
    } catch (error: unknown) {
      return {
        content: [{ type: "text", text: getErrorMessage(error) }],
        isError: true,
      };
    }
  });

  return server;
}
