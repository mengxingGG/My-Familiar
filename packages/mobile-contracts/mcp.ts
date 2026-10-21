export interface MobileMcpConfig {
  id: string;
  name: string;
  transport: "http";
  url: string;
  enabled: boolean;
  auth?: { kind: "header" | "query"; name: string; prefix?: string };
}
export interface MobileMcpServer extends MobileMcpConfig {
  revision: string;
  connected: boolean;
  hasKey: boolean;
  tools: number;
  toolNames: string[];
  error?: string;
}
export interface MobileMcpCommands {
  "mcp.github.save": {
    params: { enabled: boolean; readOnly: boolean; revision: string | null; apiKey?: string; clearApiKey?: boolean };
    result: MobileMcpServer;
  };
  "mcp.list": { params: undefined; result: MobileMcpServer[] };
  "mcp.save": {
    params: {
      config: MobileMcpConfig;
      revision: string | null;
      apiKey?: string;
      clearApiKey?: boolean;
    };
    result: MobileMcpServer;
  };
  "mcp.connect": {
    params: { id: string; revision: string; operationId: string };
    result: { tools: string[] };
  };
  "mcp.connect.cancel": { params: { operationId: string }; result: void };
  "mcp.disconnect": { params: { id: string }; result: void };
  "mcp.remove": { params: { id: string; revision: string }; result: void };
}
