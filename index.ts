import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMacDoctorServer } from "./server.js";

async function main(): Promise<void> {
  const server = createMacDoctorServer();
  await server.connect(new StdioServerTransport());
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed to start mac-doctor-mcp: ${getErrorMessage(error)}\n`,
  );
  process.exitCode = 1;
});
