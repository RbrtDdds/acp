// Type stubs for @modelcontextprotocol/sdk
// These will be replaced by actual types after pnpm install

declare module '@modelcontextprotocol/sdk/server/mcp.js' {
  import { ZodType } from 'zod';

  interface McpServerOptions {
    name: string;
    version: string;
  }

  interface ToolResult {
    content: Array<{ type: string; text: string }>;
  }

  export class McpServer {
    constructor(options: McpServerOptions);
    tool(
      name: string,
      description: string,
      schema: Record<string, ZodType>,
      handler: (params: any) => Promise<ToolResult>
    ): void;
    connect(transport: any): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {
    constructor();
  }
}
