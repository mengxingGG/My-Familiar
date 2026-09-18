const readline = require("node:readline");
// 测试服务：只提供回声，验证 stdio、环境鉴权及客户端生命周期。
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  let result;
  if (req.method === "initialize")
    result = {
      protocolVersion: req.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    };
  else if (req.method === "tools/list")
    result = {
      tools: [
        {
          name: "echo",
          description: "Echo fixture",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ],
    };
  else if (req.method === "tools/call")
    result = {
      content: [
        {
          type: "text",
          text:
            "echo:" +
            req.params.arguments.text +
            ":auth=" +
            Boolean(process.env.FIXTURE_KEY),
        },
      ],
    };
  else if (req.method === "ping") result = {};
  else
    return process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "Unknown" },
      }) + "\n",
    );
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n",
  );
});
