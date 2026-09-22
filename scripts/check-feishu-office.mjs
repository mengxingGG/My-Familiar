// 使用当前连接做只读验证；工具策略和临时状态隔离，凭据仍由原 CLI 管理。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Kernel } from "../packages/kernel/index.ts";
import { definePlugin } from "../packages/contracts/index.ts";
import { rpc } from "../packages/protocol/index.ts";
import { storageLocal } from "../plugins/storage-local/index.ts";
import { agentTools } from "../plugins/agent-tools/index.ts";
import { feishuCli } from "../plugins/feishu-cli/index.ts";
import { startCli } from "../plugins/cli-dependencies/index.ts";

const directory =
  process.env.FAMILIAR_DATA_DIR || join(process.env.APPDATA, "Familiar");
const { feishu } = await rpc(directory, "integrations.status");
assert.ok(
  feishu.installed && feishu.config.officeEnabled,
  "请先安装依赖、登录并启用飞书办公工具",
);
const output = resolve(".artifacts/feishu-office-check-" + Date.now());
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "feishu-settings.json"),
  JSON.stringify({ ...feishu.config, channelEnabled: false }),
);
const kernel = new Kernel({
  grants: {
    "familiar.storage-local": ["storage.app"],
    "familiar.feishu": ["process.feishu", "network.dependencies"],
  },
});
kernel.install(storageLocal(output));
kernel.install(agentTools);
kernel.install(
  definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "verification.feishu",
      version: "1",
      provides: ["familiar.home", "channel.chat"],
      requires: [],
    },
    start(ctx) {
      ctx.provide("familiar.home", { root: dirname(dirname(feishu.root)) });
      ctx.provide("channel.chat", {
        reply: async () => {
          throw new Error("验证脚本不发送消息");
        },
        history: async () => [],
        clear: async () => {},
      });
    },
  }),
);
kernel.install(
  feishuCli(undefined, (exe, args, options) => {
    // 测试实例没有启动通道，不能在清理时停止真实应用的事件总线。
    if (args.join(" ") === "event stop")
      return {
        done: Promise.resolve({ code: 0, output: "", errors: "" }),
        stop() {},
      };
    assert.ok(
      args.includes("--help") ||
        (args[0] === "docs" && ["+search", "+fetch"].includes(args[1])) ||
        (args[0] === "calendar" && args[1] === "+agenda") ||
        (args[0] === "im" && args[1] === "+chat-list"),
      "验证脚本只允许预定的只读命令",
    );
    return startCli(exe, args, options);
  }),
);
const checks = [];
try {
  await kernel.startAll();
  const run = async (name, args) => {
    const text = await kernel.resolve("agent.tools").run(
      {
        id: name,
        name: "feishu_cli",
        arguments: JSON.stringify({ args }),
      },
      AbortSignal.timeout(45000),
      { silent: true },
    );
    let value;
    try {
      value = JSON.parse(text);
    } catch {}
    const result = { name, ok: value?.ok !== false, outputChars: text.length };
    if (value?.data?.total !== undefined) result.total = value.data.total;
    if (value?.access) result.access = value.access;
    if (value?.exitCode !== undefined) result.exitCode = value.exitCode;
    checks.push(result);
    console.log(JSON.stringify(result));
    return value ?? text;
  };
  const help = await run("root-help", ["--help"]);
  assert.match(help, /lark-cli/);
  if (feishu.config.identity === "user") {
    const found = await run("document-search", [
      "docs",
      "+search",
      "--query",
      "会议",
      "--page-size",
      "20",
    ]);
    const doc = found?.data?.results?.find((item) =>
      /\/docx\//.test(item.result_meta?.url),
    );
    if (doc)
      await run("document-outline", [
        "docs",
        "+fetch",
        "--api-version",
        "v2",
        "--doc",
        doc.result_meta.url,
        "--scope",
        "outline",
        "--max-depth",
        "1",
      ]);
    else
      checks.push({
        name: "document-outline",
        skipped: "本页未找到 docx 文档",
      });
  }
  await run("today-agenda", ["calendar", "+agenda"]);
  await run("chat-list", ["im", "+chat-list", "--page-size", "1"]);
  assert.equal(kernel.resolve("agent.approvals").list().length, 0);
  const report = {
    date: new Date().toISOString(),
    identity: feishu.config.identity,
    checks,
    accessIssues: (await kernel.resolve("feishu.cli").status()).accessIssues,
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log("OUTPUT: " + output);
} finally {
  await kernel.dispose();
}
