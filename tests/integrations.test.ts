import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Kernel } from "../packages/kernel/index.ts";
import {
  defaults,
  definePlugin,
  type McpConfig,
  type PromptMessage,
} from "../packages/contracts/index.ts";
import {
  personaPrompt,
  personaSchema,
} from "../plugins/conversation/config.ts";
import {
  incomingMessage,
  validateOfficeArgs,
  validateFeishu,
  feishuDefaults,
} from "../plugins/feishu-cli/validation.ts";
import { feishuCli } from "../plugins/feishu-cli/index.ts";
import { missingAccess, accessHint } from "../plugins/feishu-cli/access.ts";
import {
  officeDomains,
  officeHelp,
  officeLoginArgs,
} from "../plugins/feishu-cli/policy.ts";
import {
  githubToolAccess,
  guardGithubBusinessArgs,
  githubBusinessSchema,
} from "../plugins/github-integration/policy.ts";
import { mcpClient } from "../plugins/mcp-client/index.ts";
import { githubIntegration } from "../plugins/github-integration/index.ts";
import { channelChat } from "../plugins/channel-chat/index.ts";
import { contextCompaction } from "../plugins/context-compaction/index.ts";
import { agentTools } from "../plugins/agent-tools/index.ts";
import { storageLocal } from "../plugins/storage-local/index.ts";
import { cliEnvironment, redact } from "../plugins/cli-dependencies/index.ts";
const temporary = async () => {
  await mkdir(".artifacts", { recursive: true });
  return mkdtemp(resolve(".artifacts/integrations-test-"));
};
const wait = async (fn: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 4000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("旧性格原文迁移；跟随角色读取推荐，固定性格不被角色改变", () => {
  const old = personaSchema.validate({
    name: "伙伴",
    instruction: "请保持原样",
  });
  assert.equal(old.style, "custom");
  assert.equal(old.instruction, "请保持原样");
  assert.match(personaPrompt(old, "enthusiastic"), /请保持原样/);
  assert.doesNotMatch(personaPrompt(old, "enthusiastic"), /轻快/);
  const fixed = { ...defaults.persona, style: "concise" };
  assert.equal(
    personaPrompt(fixed, "gentle"),
    personaPrompt(fixed, "enthusiastic"),
  );
  assert.match(
    personaPrompt({ ...fixed, style: "character" }, "enthusiastic"),
    /轻快/,
  );
  assert.throws(() => personaSchema.validate({ ...old, style: "unknown" }));
});
test("飞书事件字段按官方扁平结构识别，只接收用户私聊文字；管理操作不走办公工具", () => {
  const e = {
    type: "im.message.receive_v1",
    sender_type: "user",
    sender_id: "ou_owner",
    chat_type: "p2p",
    chat_id: "oc_chat",
    message_type: "text",
    message_id: "om_message",
    content: "已经是纯文本",
  };
  assert.equal(incomingMessage(e)?.text, "已经是纯文本");
  for (const patch of [
    { sender_type: "bot" },
    { chat_type: "group" },
    { message_type: "image" },
    { content: "" },
  ])
    assert.equal(incomingMessage({ ...e, ...patch }), undefined);
  assert.deepEqual(
    validateOfficeArgs(["docs", "+create", "--content", "含有 ; & 的普通文本"]),
    ["docs", "+create", "--content", "含有 ; & 的普通文本"],
  );
  for (const args of [
    ["config", "show"],
    ["auth", "token"],
    ["im", "+messages-send", "--access-token", "fixture"],
    ["docs", "+fetch", "--as=bot"],
  ])
    assert.throws(() => validateOfficeArgs(args));
  assert.throws(() =>
    validateFeishu({ ...feishuDefaults, allowedUsers: ["everyone"] }),
  );
  assert.deepEqual(validateOfficeArgs(["--help"]), ["--help"]);
  assert.deepEqual(validateOfficeArgs(["-h"]), ["--help"]);
  assert.throws(() => validateOfficeArgs(["--help", "--profile", "other"]));
  assert.throws(
    () => validateOfficeArgs(["docs", "+fetch", "--as", "user"]),
    /请移除 --as/,
  );
  assert.doesNotMatch(
    redact(
      '{"appSecret":"never-print","access_token":"private"} ghp_example123',
    ),
    /never-print|private|ghp_example/,
  );
  const old = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "not-inherited";
  try {
    assert.equal(
      cliEnvironment({ GH_CONFIG_DIR: "isolated" }).GH_TOKEN,
      undefined,
    );
  } finally {
    if (old === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = old;
  }
});

test("业务读写开放，CLI 入口不能管理账户；授权覆盖业务域且不申请管理域", () => {
  for (const args of [
    ["docs", "+create", "--content", "text"],
    ["docs", "+update", "--content", "text"],
    ["drive", "+delete", "--yes"],
    ["whiteboard", "+update"],
    ["mindnotes", "nodes", "create"],
    ["mail", "user_mailbox.drafts", "send"],
    ["contact", "+get-user"],
    ["mail", "user_mailboxes", "profile"],
    ["docs", "+media-download", "--output-dir", "assets"],
  ])
    assert.deepEqual(validateOfficeArgs(args), args);
  for (const args of [
    ["auth", "login"],
    ["config", "init"],
    ["application", "+scope"],
    ["api", "POST", "/open-apis/contact/v3/users"],
    ["contact", "users", "create"],
    ["contact", "users", "delete"],
    ["contact", "--json", "users", "delete"],
    ["mail", "user_mailbox.settings", "update"],
    ["mail", "user_mailboxes", "delete"],
    ["mail", "--json", "user_mailboxes", "delete"],
    ["mail", "+account-update"],
    ["docs", "+update", "--endpoint", "https://example.invalid"],
  ])
    assert.throws(() => validateOfficeArgs(args));
  assert.equal(officeHelp(["--help"]), true);
  assert.equal(officeHelp(["docs", "+update", "--help"]), true);
  assert.equal(officeHelp(["docs", "+update", "--content", "--help"]), false);
  assert.ok(officeDomains.includes("drive") && officeDomains.includes("im"));
  assert.ok(
    !officeDomains.some((d) => ["all", "application", "contact"].includes(d)),
  );
  assert.deepEqual(officeLoginArgs(), [
    "auth",
    "login",
    "--domain",
    officeDomains.join(","),
  ]);
});

test("GitHub 官方业务写工具可用，账户及未知管理工具不会暴露，只读模式仍可选", () => {
  const config: McpConfig = {
    id: "github",
    name: "GitHub",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    enabled: true,
  };
  for (const name of [
    "create_or_update_file",
    "push_files",
    "create_repository",
    "issue_write",
    "merge_pull_request",
    "delete_file",
    "delete_repository",
  ])
    assert.equal(githubToolAccess(config, name), "write");
  for (const name of ["get_me", "get_file_contents", "search_issues"])
    assert.equal(githubToolAccess(config, name), "read");
  for (const name of [
    "update_authenticated_user",
    "create_ssh_key",
    "delete_token",
    "update_org",
    "add_team_member",
    "arbitrary_api",
  ])
    assert.equal(githubToolAccess(config, name), false);
  for (const name of ["create_repository_ruleset", "custom_properties_write"]) {
    assert.equal(githubToolAccess(config, name), "write");
    assert.doesNotThrow(() =>
      guardGithubBusinessArgs(name, {
        level: "repository",
        owner: "owner",
        repo: "repo",
      }),
    );
    for (const args of [
      { level: "organization" },
      { level: "enterprise" },
      { level: "repository", org: "org" },
      { level: "repository", enterprise: "ent" },
    ])
      assert.throws(() => guardGithubBusinessArgs(name, args), /账户管理/);
    assert.deepEqual(
      (githubBusinessSchema(name, { type: "object" }).properties as any).level
        .const,
      "repository",
    );
  }
  assert.equal(
    githubToolAccess({ ...config, url: config.url + "readonly" }, "push_files"),
    false,
  );
  assert.equal(
    githubToolAccess(
      { ...config, url: "https://example.invalid/mcp" },
      "push_files",
    ),
    undefined,
  );
});

test("GitHub MCP 注册时过滤账户管理，业务写调用默认不弹窗，其他 MCP 不继承其授权", async () => {
  const root = await temporary();
  const k = new Kernel({
    grants: {
      "familiar.storage-local": ["storage.app"],
      "familiar.mcp-client": ["network.mcp", "process.mcp"],
    },
  });
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const rpc = JSON.parse(await request.text());
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const official = request.url === "https://api.githubcopilot.com/mcp/";
    if (official) assert.equal(request.headers.get("X-MCP-Toolsets"), "all");
    else assert.equal(request.headers.get("X-MCP-Toolsets"), null);
    let result;
    if (rpc.method === "initialize")
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    else if (rpc.method === "tools/list")
      result = {
        tools: (official
          ? [
              "get_me",
              "create_or_update_file",
              "update_authenticated_user",
              "create_ssh_key",
            ]
          : Array.from({ length: 105 }, (_, i) => "tool_" + i)
        ).map((name) => ({
          name,
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: name === "get_me" },
        })),
      };
    else if (rpc.method === "tools/call") {
      calls.push(rpc.params.name);
      result = { content: [{ type: "text", text: "fixture success" }] };
    } else result = {};
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  k.install(storageLocal(root));
  k.install(agentTools);
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "fixture.mcp-access",
        version: "1",
        provides: ["familiar.home", "secrets.local"],
        requires: [],
      },
      start(ctx) {
        ctx.provide("familiar.home", { root });
        ctx.provide("secrets.local", {
          has: (key) => secrets.has(key),
          get: (key) => secrets.get(key) ?? "",
          set: async (key, value) => {
            secrets.set(key, value);
          },
        });
      },
    }),
  );
  k.install(mcpClient);
  try {
    await k.startAll();
    const manager = k.resolve("mcp.manager"),
      tools = k.resolve("agent.tools");
    await manager.save({
      id: "github",
      name: "GitHub",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      enabled: true,
    });
    assert.deepEqual((await manager.connect("github")).tools, [
      "get_me",
      "create_or_update_file",
    ]);
    const write = tools
      .list()
      .find((t) => t.description.includes("create_or_update_file"))!;
    assert.match(
      await tools.run(
        { id: "write", name: write.name, arguments: "{}" },
        AbortSignal.timeout(2000),
      ),
      /fixture success/,
    );
    assert.deepEqual(calls, ["create_or_update_file"]);
    assert.equal(k.resolve("agent.approvals").list().length, 0);
    assert.ok(
      !tools
        .list()
        .some((t) =>
          /update_authenticated_user|create_ssh_key/.test(t.description),
        ),
    );
    await manager.save({
      id: "other",
      name: "Other",
      transport: "http",
      url: "https://example.invalid/mcp",
      enabled: true,
    });
    assert.equal(
      (await manager.connect("other")).tools.length,
      105,
      "工具列表不截断在 100 个",
    );
    const other = tools.list().find((t) => t.description.startsWith("Other"))!;
    const pending = tools.run(
      { id: "other", name: other.name, arguments: "{}" },
      AbortSignal.timeout(2000),
    );
    const denied = assert.rejects(pending, /拒绝/);
    await wait(() => k.resolve("agent.approvals").list().length === 1);
    await k
      .resolve("agent.approvals")
      .decide(k.resolve("agent.approvals").list()[0].id, false);
    await denied;
  } finally {
    await k.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("飞书授权提示只采信明确的 missing_scopes，区分用户与机器人，不合并任选权限", () => {
  const error = {
    type: "authorization",
    subtype: "missing_scope",
    missing_scopes: ["im:chat:read", "im:chat:read"],
  };
  const issue = missingAccess(
    JSON.stringify({ error }),
    "im +chat-list",
    "user",
  )!;
  assert.deepEqual(issue.scopes, ["im:chat:read"]);
  assert.match(accessHint(issue), /待补充的授权/);
  assert.match(
    accessHint({ ...issue, identity: "bot" }),
    /机器人不使用用户 OAuth/,
  );
  for (const text of [
    "not json",
    "null",
    JSON.stringify({ error: { ...error, missing_scopes: ["--evil scope"] } }),
    JSON.stringify({
      error: {
        type: "api",
        permission_violations: [
          { subject: "im:chat:read" },
          { subject: "im:chat" },
        ],
      },
    }),
  ])
    assert.equal(missingAccess(text, "im +chat-list", "user"), undefined);
});
test("GitHub Token 加密范围符合契约；读写模式切换保留 Token，停用撤销 MCP", async () => {
  const root = await temporary(),
    k = new Kernel({
      grants: {
        "familiar.storage-local": ["storage.app"],
        "familiar.github": ["process.github", "network.dependencies"],
      },
    });
  const secrets = new Map<string, string>();
  let entry: McpConfig | undefined,
    token = "";
  k.install(storageLocal(root));
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "fixture.github",
        version: "1",
        provides: ["familiar.home", "secrets.local", "mcp.manager"],
        requires: [],
      },
      start(ctx) {
        ctx.provide("familiar.home", { root });
        ctx.provide("secrets.local", {
          has: (key) => secrets.has(key),
          get: (key) => secrets.get(key) ?? "",
          set: async (key, value) => {
            assert.match(key, /^[a-f0-9]{64}$/);
            if (value) secrets.set(key, value);
            else secrets.delete(key);
          },
        });
        ctx.provide("mcp.manager", {
          list: async () =>
            entry
              ? [{ ...entry, hasKey: !!token, connected: false, tools: 0 }]
              : [],
          save: async (c) => {
            entry = c;
          },
          setKey: async (_id, key) => {
            token = key;
          },
          connect: async () => ({ tools: ["get_me"] }),
          callReadOnly: async () => ({}),
          remove: async () => {},
          installPackage: async () => {},
        });
      },
    }),
  );
  k.install(githubIntegration());
  await k.startAll();
  try {
    const service = k.resolve("github.integration");
    await service.save({
      enabled: true,
      readOnly: true,
      authMode: "token",
      token: "secret_fixture",
    });
    assert.equal(entry?.url, "https://api.githubcopilot.com/mcp/readonly");
    assert.equal(token, "secret_fixture");
    assert.doesNotMatch(
      JSON.stringify(await service.status()),
      /secret_fixture/,
    );
    await service.save({ enabled: true, readOnly: false, authMode: "token" });
    assert.equal(entry?.url, "https://api.githubcopilot.com/mcp/");
    assert.equal(token, "secret_fixture");
    await service.save({ enabled: false, readOnly: false, authMode: "token" });
    assert.equal(entry?.enabled, false);
    entry!.url = "https://example.invalid/mcp";
    await assert.rejects(service.connect(), /未向该地址发送/);
  } finally {
    await k.dispose();
  }
});
test("飞书私聊配对、消息去重、停止监听与 stdin 凭据传递", async () => {
  const root = await temporary();
  await mkdir(join(root, "plugins/feishu/bin"), { recursive: true });
  await writeFile(
    join(root, "plugins/feishu/bin/lark-cli.exe"),
    "fixture only",
  );
  const k = new Kernel({
    grants: {
      "familiar.storage-local": ["storage.app"],
      "familiar.feishu": ["process.feishu", "network.dependencies"],
    },
  });
  const received: string[] = [],
    commands: { args: string[]; stdin?: string }[] = [];
  let eventOutput: ((chunk: string) => void) | undefined;
  let missingOfficeScope = false;
  const launch: any = (_exe: string, args: string[], options: any) => {
    commands.push({ args, stdin: options.stdin });
    if (args[0] === "auth" && args[1] === "status")
      return {
        done: Promise.resolve({
          code: 0,
          output: '{"appId":"cli_existing"}',
          errors: "",
        }),
        stop() {},
      };
    if (args.includes("--help") || args.includes("-h"))
      return {
        done: Promise.resolve({
          code: 0,
          output:
            args[0] === "calendar" ? "Risk: read" : "Risk: high-risk-write",
          errors: "",
        }),
        stop() {},
      };
    if (missingOfficeScope && ["calendar", "im"].includes(args[0]))
      return {
        done: Promise.resolve({
          code: 3,
          output: "",
          errors: JSON.stringify({
            ok: false,
            error: {
              type: "authorization",
              subtype: "missing_scope",
              missing_scopes: [
                args[0] === "calendar"
                  ? "calendar:calendar.event:read"
                  : "im:chat:read",
              ],
            },
          }),
        }),
        stop() {},
      };
    if (args[0] === "drive" && !args.includes("--yes"))
      return {
        done: Promise.resolve({
          code: 10,
          output: "",
          errors: '{"error":{"type":"confirmation_required"}}',
        }),
        stop() {},
      };
    if (args[0] === "event" && args[1] === "consume") {
      assert.equal(options.keepStdin, true);
      eventOutput = options.onStdout;
      let close: (value: any) => void;
      const done = new Promise((r) => {
        close = r;
      });
      const stop = () => close({ code: 0, output: "", errors: "" });
      options.signal.addEventListener("abort", stop, { once: true });
      queueMicrotask(() =>
        options.onStderr("[event] ready event_key=im.message.receive_v1\n"),
      );
      return { done, stop };
    }
    return {
      done: Promise.resolve({ code: 0, output: "{}", errors: "" }),
      stop() {},
    };
  };
  k.install(storageLocal(root));
  k.install(agentTools);
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "fixture.feishu",
        version: "1",
        provides: ["familiar.home", "channel.chat"],
        requires: [],
      },
      start(ctx) {
        ctx.provide("familiar.home", { root });
        ctx.provide("channel.chat", {
          reply: async (_channel, text) => {
            received.push(text);
            return "回复：" + text;
          },
          clear: async () => {},
          history: async () => [],
        });
      },
    }),
  );
  k.install(feishuCli(undefined, launch));
  await k.startAll();
  try {
    const f = k.resolve("feishu.cli");
    await f.configure("cli_test", "fixture-private");
    await wait(async () => !(await f.status()).job?.running);
    const command = commands.find((c) => c.args[0] === "config")!;
    assert.equal(command.stdin, "fixture-private\n");
    assert.ok(!command.args.includes("fixture-private"));
    assert.doesNotMatch(JSON.stringify(await f.status()), /fixture-private/);
    await f.createApp();
    await wait(async () => !(await f.status()).job?.running);
    assert.ok(
      !commands.some((c) => c.args.includes("--new")),
      "已有应用登录不能重新创建机器人",
    );
    assert.deepEqual(commands.at(-1)?.args, officeLoginArgs());
    await f.authorizeOffice();
    await wait(async () => !(await f.status()).job?.running);
    assert.deepEqual(commands.at(-1)?.args, officeLoginArgs());
    await f.save({ ...feishuDefaults, channelEnabled: true });
    f.pair();
    const pairing = (await f.status()).pairing!;
    const base = {
      type: "im.message.receive_v1",
      sender_type: "user",
      sender_id: "ou_owner",
      chat_type: "p2p",
      chat_id: "oc_chat",
      message_type: "text",
    };
    const emit = (id: string, text: string, patch = {}) =>
      eventOutput!(
        JSON.stringify({ ...base, message_id: id, content: text, ...patch }) +
          "\n",
      );
    emit("om_stranger", "陌生消息");
    emit("om_pair", "/pair " + pairing.code);
    await wait(async () =>
      (await f.status()).config.allowedUsers.includes("ou_owner"),
    );
    emit("om_hello", "你好");
    emit("om_hello", "你好");
    emit("om_group", "群消息", { chat_type: "group" });
    await wait(
      () =>
        commands.filter((c) => c.args.includes("+messages-reply")).length === 2,
    );
    assert.deepEqual(received, ["你好"]);
    await f.save({ ...(await f.status()).config, channelEnabled: false });
    assert.equal((await f.status()).channel, "未启用");
    assert.ok(commands.some((c) => c.args.join(" ") === "event stop"));
    assert.ok(
      commands
        .filter((c) => c.args.includes("+messages-reply"))
        .every((c) => c.args.includes("--idempotency-key")),
    );
    await f.save({ ...(await f.status()).config, officeEnabled: true });
    const tools = k.resolve("agent.tools"),
      approvals = k.resolve("agent.approvals"),
      signal = new AbortController().signal;
    const run = (args: string[]) =>
      tools.run(
        {
          id: "office",
          name: "feishu_cli",
          arguments: JSON.stringify({ args }),
        },
        signal,
      );
    await run(["calendar", "+agenda"]);
    assert.equal(approvals.list().length, 0);
    await run(["--help"]);
    assert.deepEqual(commands.at(-1)?.args, ["--help"]);
    await run(["calendar", "-h"]);
    assert.deepEqual(commands.at(-1)?.args, ["calendar", "-h"]);
    assert.equal(approvals.list().length, 0);
    const policy = k.resolve("agent.policy");
    await policy.set({ ...policy.get(), mode: "auto" });
    missingOfficeScope = true;
    const failure = JSON.parse(await run(["calendar", "+agenda"]));
    assert.equal(failure.ok, false);
    assert.deepEqual(failure.access.scopes, ["calendar:calendar.event:read"]);
    assert.match(failure.hint, /待补充的授权/);
    await run(["im", "+chat-list"]);
    await run(["calendar", "+agenda", "--help"]);
    assert.equal(
      (await f.status()).accessIssues.length,
      2,
      "看帮助不能假装业务权限已恢复",
    );
    await f.authorize("calendar:calendar.event:read");
    await wait(async () => !(await f.status()).job?.running);
    assert.deepEqual(commands.at(-1)?.args, [
      "auth",
      "login",
      "--scope",
      "calendar:calendar.event:read",
    ]);
    assert.equal(
      (await f.status()).accessIssues.length,
      2,
      "登录完成仍需业务查询确认",
    );
    missingOfficeScope = false;
    await run(["calendar", "+agenda"]);
    assert.deepEqual(
      (await f.status()).accessIssues.map((i) => i.command),
      ["im +chat-list"],
    );
    await f.save({ ...(await f.status()).config, identity: "bot" });
    missingOfficeScope = true;
    const botFailure = JSON.parse(await run(["calendar", "+agenda"]));
    assert.equal(botFailure.access.identity, "bot");
    assert.match(botFailure.hint, /机器人不使用用户 OAuth/);
    await assert.rejects(f.authorizeOffice(), /机器人/);
    missingOfficeScope = false;
    await policy.set({ ...policy.get(), mode: "custom" });
    // 默认 write=allow：包含 CLI 高风险确认的业务操作也不重复弹窗。
    await run(["drive", "+delete", "--file-token", "fixture"]);
    assert.equal(approvals.list().length, 0);
    assert.equal(commands.filter((c) => c.args.includes("--yes")).length, 1);
    const beforeBlocked = commands.length;
    await assert.rejects(
      run(["contact", "users", "delete", "--user-id", "fixture"]),
      /账户/,
    );
    assert.equal(commands.length, beforeBlocked);
    // 用户主动收紧通用写入策略时仍生效；不会把 --content 的文本当作帮助绕过。
    await policy.set({
      ...policy.get(),
      defaults: { ...policy.get().defaults, write: "deny" },
    });
    await assert.rejects(
      run(["docs", "+update", "--content", "--help"]),
      /禁止/,
    );
    await policy.set({
      ...policy.get(),
      defaults: { ...policy.get().defaults, write: "ask" },
    });
    const denied = assert.rejects(
      run(["drive", "+delete", "--file-token", "fixture"]),
      /拒绝/,
    );
    await wait(() => approvals.list().length > 0);
    assert.equal(commands.filter((c) => c.args.includes("--yes")).length, 1);
    await approvals.decide(approvals.list()[0].id, false);
    await denied;
    const allowed = run(["drive", "+delete", "--file-token", "fixture"]);
    await wait(() => approvals.list().length > 0);
    await approvals.decide(approvals.list()[0].id, true);
    await allowed;
    assert.equal(commands.filter((c) => c.args.includes("--yes")).length, 2);
    assert.equal(approvals.list().length, 0);
  } finally {
    await k.dispose();
  }
});
test("通道会话按用户隔离，缓存前缀稳定，换性格重建缓存，桌面不显示活动", async () => {
  const root = await temporary(),
    k = new Kernel({ grants: { "familiar.storage-local": ["storage.app"] } });
  const calls: any[] = [];
  let config = structuredClone(defaults);
  k.install(storageLocal(root));
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "fixture.channel",
        version: "1",
        provides: [
          "settings",
          "persona.catalog",
          "llm.management",
          "agent.chat",
          "llm.chat",
          "agent.tools",
          "memory.files",
          "skills.catalog",
        ],
        requires: [],
      },
      start(ctx) {
        ctx.provide("settings", {
          get: () => structuredClone(config),
          apply: async (c) => (config = c),
          patchPet: async (p) => {
            Object.assign(config.pet, p);
            return config;
          },
        });
        ctx.provide("persona.catalog", {
          list: () => [],
          prompt: (c) => personaPrompt(c.persona),
        });
        ctx.provide("llm.management", {
          validate: (c) => c,
          models: async () => [],
          inspect: () => ({ options: {} as any, hasKey: true }),
          plan: async () => ({
            inputBudget: 10000,
            contextWindow: 12000,
            source: "model",
          }),
          count: async (i) => ({ tokens: i.messages.length * 20, exact: true }),
        });
        ctx.provide("agent.chat", {
          async *stream(input) {
            calls.push(
              structuredClone({
                ...input,
                signal: undefined,
                onTrace: undefined,
              }),
            );
            input.onTrace?.([{ role: "assistant", content: "hello" }]);
            yield "hello";
          },
        });
        ctx.provide("llm.chat", {
          test: async () => "ok",
          async *stream() {
            throw new Error("此夹具不应触发压缩");
            yield "";
          },
        });
        ctx.provide("agent.tools", {
          list: () => [],
          register: () => () => {},
          run: async () => "",
        });
        ctx.provide("memory.files", {
          context: async () => "",
          diary: async () => "",
        } as any);
        ctx.provide("skills.catalog", { prompt: async () => "" } as any);
      },
    }),
  );
  k.install(channelChat);
  k.install(contextCompaction);
  await k.startAll();
  try {
    const c = k.resolve("channel.chat"),
      signal = new AbortController().signal;
    await c.reply("feishu:alice", "first", signal);
    await c.reply("feishu:alice", "second", signal);
    assert.equal(calls[0].sessionKey, calls[1].sessionKey);
    assert.equal(calls[1].messages[1].content, "first");
    assert.equal(calls[0].silent, true);
    await c.reply("feishu:bob", "other", signal);
    assert.equal(calls[2].messages.length, 2);
    assert.notEqual(calls[1].permissionSession, calls[2].permissionSession);
    config.persona.style = "concise";
    await c.reply("feishu:alice", "third", signal);
    assert.notEqual(calls[3].sessionKey, calls[1].sessionKey);
    assert.match(calls[3].messages[0].content, /一到三句/);
    assert.equal((await c.history("feishu:alice")).length, 6);
    await c.clear("feishu:alice");
    await c.reply("feishu:alice", "new", signal);
    assert.notEqual(calls.at(-1).permissionSession, calls[0].permissionSession);
    assert.equal((await c.history("feishu:alice")).length, 2);
  } finally {
    await k.dispose();
  }
});
