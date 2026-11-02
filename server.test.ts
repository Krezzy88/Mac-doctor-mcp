import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMacDoctorServer } from "./server.js";
import type { DiskTriageReport, LargeFile } from "./tools.js";

describe("MCP server", () => {
  let client: Client;
  let server: ReturnType<typeof createMacDoctorServer>;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  const sampleDiskReport: DiskTriageReport = {
    generatedAt: "2026-11-02T00:00:00.000Z",
    readOnly: true,
    volume: {
      path: "/Users/example",
      totalBytes: 1_000_000_000,
      availableBytes: 40_000_000,
      availablePercent: 4,
      pressure: "critical",
    },
    areas: [],
  };

  beforeEach(async () => {
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createMacDoctorServer({
      analyzeCaches: async () => "Cache sizes (read-only):\nnpm: 10M",
      diagnoseDiskPressure: async () => sampleDiskReport,
      findLargeFiles: async () => [
        { path: "/Users/example/Projects/archive.zip", size: 2_097_152 },
      ],
    });
    client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  it("advertises exactly the supported tools", async () => {
    const result = await client.listTools();

    expect(result.tools.map(({ name }) => name)).toEqual([
      "analyze_caches",
      "find_large_files",
      "diagnose_disk_pressure",
    ]);
  });

  it("returns a readable report and preserves structured triage data", async () => {
    const result = await client.callTool({
      name: "diagnose_disk_pressure",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(textContent(result)).toContain("## Báo cáo dung lượng Mac");
    expect(textContent(result)).toContain("🔴 Rất thấp");
    expect(textContent(result)).toContain("38.1 MB");
    expect(result.structuredContent).toEqual(sampleDiskReport);
  });

  it("rejects unexpected arguments for the disk triage tool", async () => {
    const result = await client.callTool({
      name: "diagnose_disk_pressure",
      arguments: { deleteFiles: true },
    });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("Unrecognized key");
  });

  it("returns readable large-file results and preserves structured data", async () => {
    const expected: LargeFile[] = [
      { path: "/Users/example/Projects/archive.zip", size: 2_097_152 },
    ];
    const result = await client.callTool({
      name: "find_large_files",
      arguments: {
        directoryPath: "/Users/example/Projects",
        minSizeMB: 1,
        limit: 5,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(textContent(result)).toContain("## Tệp dung lượng lớn");
    expect(textContent(result)).toContain("2.0 MB");
    expect(textContent(result)).toContain("archive.zip");
    expect(result.structuredContent).toEqual({ files: expected });
  });

  it("explains an empty large-file result in plain language", async () => {
    const emptyServer = createMacDoctorServer({
      analyzeCaches: async () => "Cache sizes (read-only):\nnpm: 10M",
      diagnoseDiskPressure: async () => sampleDiskReport,
      findLargeFiles: async () => [],
    });
    const [emptyClientTransport, emptyServerTransport] =
      InMemoryTransport.createLinkedPair();
    const emptyClient = new Client({
      name: "test-client-empty",
      version: "1.0.0",
    });

    await emptyServer.connect(emptyServerTransport);
    await emptyClient.connect(emptyClientTransport);
    try {
      const result = await emptyClient.callTool({
        name: "find_large_files",
        arguments: {
          directoryPath: "/Users/example/Projects",
          minSizeMB: 1,
          limit: 5,
        },
      });

      expect(textContent(result)).toContain(
        "Không tìm thấy tệp nào đạt ngưỡng đã chọn.",
      );
      expect(result.structuredContent).toEqual({ files: [] });
    } finally {
      await Promise.all([emptyClient.close(), emptyServer.close()]);
    }
  });

  it("returns validation failures as tool errors", async () => {
    const result = await client.callTool({
      name: "find_large_files",
      arguments: {
        directoryPath: "/Users/example/Projects",
        minSizeMB: 0,
        limit: 5,
      },
    });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("min");
  });

  it("returns cache-analysis text", async () => {
    const result = await client.callTool({
      name: "analyze_caches",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(textContent(result)).toContain("npm: 10M");
  });
});

function textContent(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  const parsedResult = CallToolResultSchema.parse(result);
  const content = parsedResult.content[0];
  if (!content || content.type !== "text") {
    throw new Error("Expected text content from tool result");
  }
  return content.text;
}
