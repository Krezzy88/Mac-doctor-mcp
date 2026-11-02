import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  analyzeCaches,
  analyzeCachesArguments,
  diagnoseDiskPressure,
  diagnoseDiskPressureArguments,
  findLargeFiles,
  findLargeFilesArguments,
  MAX_FILE_RESULTS,
  type DiskTriageReport,
  type LargeFile,
} from "./tools.js";

type ToolHandlers = {
  analyzeCaches: () => Promise<string>;
  diagnoseDiskPressure: () => Promise<DiskTriageReport>;
  findLargeFiles: (
    args: ReturnType<typeof findLargeFilesArguments.parse>,
  ) => Promise<LargeFile[]>;
};

const defaultToolHandlers: ToolHandlers = {
  analyzeCaches,
  diagnoseDiskPressure,
  findLargeFiles,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatPath(path: string): string {
  return `\`${path.replaceAll("`", "\\`")}\``;
}

function formatDiskTriageReport(report: DiskTriageReport): string {
  const pressureLabels = {
    critical: "🔴 Rất thấp",
    high: "🟠 Thấp",
    moderate: "🟡 Cần theo dõi",
    healthy: "🟢 Ổn",
  } as const;
  const riskLabels = {
    low: "Thấp",
    review: "Cần xem xét",
    high: "Cao — không xóa chỉ dựa vào dung lượng",
  } as const;

  const lines = [
    "## Báo cáo dung lượng Mac",
    "",
    `**Tình trạng:** ${pressureLabels[report.volume.pressure]} — còn ${formatBytes(report.volume.availableBytes)} (${report.volume.availablePercent}%) trên tổng ${formatBytes(report.volume.totalBytes)}.`,
    "",
    "### Các khu vực đã kiểm tra",
  ];

  for (const area of report.areas) {
    lines.push("", `#### ${area.name}`);

    if (area.status === "measured" && area.sizeBytes !== null && area.path) {
      lines.push(
        `- **Đang dùng:** ${formatBytes(area.sizeBytes)}`,
        `- **Vị trí:** ${formatPath(area.path)}`,
      );
    } else if (area.status === "missing") {
      lines.push("- Không tìm thấy trên máy này.");
    } else {
      lines.push(`- Chưa đo được${area.error ? `: ${area.error}` : "."}`);
      if (area.path) lines.push(`- **Vị trí:** ${formatPath(area.path)}`);
    }

    lines.push(
      `- **Mức cần thận trọng:** ${riskLabels[area.cleanupRisk]}`,
      `- **Gợi ý:** ${area.recommendation}`,
    );
  }

  lines.push(
    "",
    "_Báo cáo chỉ đọc: không có tệp nào bị xóa hoặc thay đổi._",
  );
  return lines.join("\n");
}

function formatLargeFiles(files: readonly LargeFile[]): string {
  if (files.length === 0) {
    return "## Tệp dung lượng lớn\n\nKhông tìm thấy tệp nào đạt ngưỡng đã chọn.";
  }

  const lines = [
    "## Tệp dung lượng lớn",
    "",
    ...files.map(
      (file, index) =>
        `${index + 1}. **${formatBytes(file.size)}** — ${formatPath(file.path)}`,
    ),
    "",
    "_Danh sách chỉ để tham khảo; không có tệp nào bị xóa hoặc thay đổi._",
  ];
  return lines.join("\n");
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
      {
        name: "diagnose_disk_pressure",
        description:
          "Creates a read-only macOS disk triage report with available space, measured developer-data/cache sizes, risk labels, and evidence-based next steps. It never deletes or modifies files.",
        inputSchema: {
          type: "object",
          properties: {},
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

      if (request.params.name === "diagnose_disk_pressure") {
        diagnoseDiskPressureArguments.parse(request.params.arguments ?? {});
        const report = await toolHandlers.diagnoseDiskPressure();
        return {
          content: [{ type: "text", text: formatDiskTriageReport(report) }],
          structuredContent: { ...report },
        };
      }

      if (request.params.name === "find_large_files") {
        const args = findLargeFilesArguments.parse(request.params.arguments);
        const files = await toolHandlers.findLargeFiles(args);
        return {
          content: [{ type: "text", text: formatLargeFiles(files) }],
          structuredContent: { files },
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
