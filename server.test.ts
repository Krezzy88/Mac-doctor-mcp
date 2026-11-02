import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMacDoctorServer } from "./server.js";
import type { LargeFile } from "./tools.js";

describe("MCP server", () => {
  let client: Client;
  let server: ReturnType<typeof createMacDoctorServer>;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createMacDoctorServer({
      analyzeCaches: async () => "Cache sizes (read-only):\nnpm: 10M",
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
    ]);
  });

  it("returns large file records as parseable JSON", async () => {
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
    expect(JSON.parse(textContent(result))).toEqual(expected);
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
