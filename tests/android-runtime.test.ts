import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import type {
  MobileCommand,
  MobileSnapshot,
} from "../packages/mobile-contracts/index.ts";
import {
  MOBILE_CHARACTER_IDS,
  MOBILE_PROVIDER_KINDS,
} from "../packages/mobile-contracts/index.ts";
import { isMobileSnapshot } from "../packages/mobile-bridge/index.ts";

test("Android 装配复用真实插件：凭据边界、流式回复、取消、历史与重启", async () => {
  await mkdir(".artifacts", { recursive: true });
  const directory = await mkdtemp(resolve(".artifacts/familiar-android-core-"));
  const keys: Record<string, string> = {};
  const nativeCalls: string[] = [];
  let slow = false;
  let authenticated = false;
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ data: [{ id: "fixture", context_window: 32768 }] }),
      );
      return;
    }
    authenticated = req.headers.authorization === "Bearer isolated-test-key";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "设备" } }] })}\n\n`,
    );
    const timer = setTimeout(
      () => {
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "核心已连接" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      },
      slow ? 10000 : 40,
    );
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const native: AndroidNative = {
    async call<T>(method: string, params = {}): Promise<T> {
      nativeCalls.push(method);
      const p = params as Record<string, unknown>;
      const result =
        method === "secrets.readAll"
          ? { ...keys }
          : method === "secrets.write"
            ? (p.value
                ? (keys[p.name as string] = p.value as string)
                : delete keys[p.name as string],
              null)
            : method === "capabilities.status"
              ? []
              : method === "runtime.status"
                ? {
                    running: false,
                    overlayVisible: false,
                    engine: "ready",
                    detail: "测试原生边界",
                  }
                : null;
      return result as T;
    },
  };
  let kernel = await bootstrapAndroid(directory, resolve("."), native).catch(
    async (error) => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      throw error;
    },
  );
  let api = mobileApi(kernel, native);
  let seq = 0;
  const call = async (method: MobileCommand, params?: unknown) => {
    const response = await api({
      protocolVersion: 1,
      id: String(++seq),
      method,
      params,
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  const snapshot = async () => (await call("snapshot.get")) as MobileSnapshot;
  try {
    const initial = await snapshot();
    assert(isMobileSnapshot(initial));
    assert.deepEqual(
      initial.characters.map((c) => c.id).sort(),
      [...MOBILE_CHARACTER_IDS].sort(),
    );
    assert.deepEqual(
      initial.providers!.map((p) => p.id).sort(),
      [...MOBILE_PROVIDER_KINDS].sort(),
    );
    await call("provider.save", {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "fixture",
      apiKey: "isolated-test-key",
    });
    assert.equal((await snapshot()).provider.keyConfigured, true);
    assert(!JSON.stringify(await snapshot()).includes("isolated-test-key"));
    // 同一 URL 的不同协议类型也不能继承旧凭据；切回类型恢复该类型的档案。
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await call("provider.save", {
      kind: "openai",
      baseUrl,
      model: "response-fixture",
    });
    assert.equal((await snapshot()).provider.keyConfigured, false);
    assert.equal(
      (await snapshot()).providers!.find((p) => p.id === "compatible")!.profile
        .model,
      "fixture",
    );
    await call("provider.save", {
      kind: "compatible",
      baseUrl,
      model: "fixture",
    });
    assert.equal((await snapshot()).provider.keyConfigured, true);
    await call("provider.save", {
      kind: "compatible",
      baseUrl: baseUrl + "/other",
      model: "fixture",
    });
    assert.equal((await snapshot()).provider.keyConfigured, false);
    await call("provider.save", {
      kind: "compatible",
      baseUrl,
      model: "fixture",
    });
    for (const bad of [
      { kind: "invented", baseUrl, model: "x" },
      { kind: "gemini", baseUrl, model: "bad\nmodel", apiKey: "must-not-save" },
    ]) {
      assert.equal(
        (
          await api({
            protocolVersion: 1,
            id: "invalid-provider",
            method: "provider.save",
            params: bad,
          })
        ).error?.code,
        "INVALID_INPUT",
      );
    }
    assert(!Object.values(keys).includes("must-not-save"));
    const tools = kernel.resolve("agent.tools");
    assert(
      !tools
        .list()
        .some((t) => t.name === "shell_run" || t.name === "mcp_install" || t.name === "desktop_snapshot"),
    );
    assert(tools.list().some((t) => t.name === "memory_diary"));
    assert(tools.list().some((t) => t.name === "mcp_list"));
    const run = (name: string, args: unknown) =>
      tools.run(
        { id: "portable", name, arguments: JSON.stringify(args) },
        new AbortController().signal,
      );
    await run("files_write", {
      path: "notes/安卓测试.md",
      text: "手机上的私有笔记",
    });
    assert.match(
      await run("files_read", { path: "notes/安卓测试.md" }),
      /手机上的私有笔记/,
    );
    await assert.rejects(
      run("files_read", { path: "../skills/companion-memory/SKILL.md" }),
      /工作目录/,
    );
    const outside = join(directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.txt"), "outside");
    await symlink(
      outside,
      join(directory, "home", "workspace", "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      run("files_read", { path: "link/private.txt" }),
      /工作目录/,
    );
    await assert.rejects(
      run("files_write", { path: "link/new.txt", text: "no" }),
      /工作目录/,
    );
    await run("memory_diary", { text: "Android 测试留下了一份工作笔记。" });
    assert.match(await run("memory_search", { query: "工作笔记" }), /工作笔记/);
    assert.match(
      await run("skill_read", { id: "companion-memory" }),
      /memory_diary/,
    );
    assert(
      !(await kernel.resolve("skills.catalog").list()).some(
        (s) => s.id === "shell-tasks" && s.enabled,
      ),
    );
    const denied = run("android_calendar_list", {});
    const deniedAssertion = assert.rejects(denied, /拒绝/);
    for (
      let i = 0;
      i < 100 && !kernel.resolve("agent.approvals").list().length;
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    const calendarTask = (await snapshot()).tasks[0];
    assert.equal(calendarTask.kind, "calendar");
    assert(!nativeCalls.includes("calendar.list"));
    await call("task.respond", { id: calendarTask.id, action: "stop" });
    await deniedAssertion;
    assert(!nativeCalls.includes("calendar.list"));
    const permitted = run("android_calendar_list", {});
    for (
      let i = 0;
      i < 100 && !kernel.resolve("agent.approvals").list().length;
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    await call("task.respond", {
      id: (await snapshot()).tasks[0].id,
      action: "approve",
    });
    await permitted;
    assert.equal(
      nativeCalls.filter((name) => name === "calendar.list").length,
      1,
    );
    await call("companion.save", {
      characterId: "youzi",
      nickname: "柚子测试",
      persona: "简洁回答",
    });
    await call("message.send", { text: "测试消息", conversationId: null });
    for (let i = 0; i < 100 && kernel.resolve("conversation").state().busy; i++)
      await new Promise((r) => setTimeout(r, 20));
    const first = await snapshot();
    assert.equal(first.activeReply, null);
    const current = first.conversations.find(
      (c) => c.id === first.activeConversationId,
    )!;
    assert.equal(current.messages.at(-1)?.text, "设备核心已连接");
    assert.equal(current.messages.at(-1)?.status, "complete");
    assert(authenticated);
    slow = true;
    await call("message.send", {
      text: "取消测试",
      conversationId: current.id,
    });
    assert.equal(
      (
        await api({
          protocolVersion: 1,
          id: "busy-provider",
          method: "provider.save",
          params: { baseUrl, model: "other" },
        })
      ).error?.code,
      "BUSY",
    );
    for (
      let i = 0;
      i < 100 && !kernel.resolve("conversation").state().messages.at(-1)?.text;
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    let checkpoint;
    for (let i = 0; i < 100; i++) {
      checkpoint = JSON.parse(
        await readFile(join(directory, "data", "conversation.json"), "utf8"),
      );
      if (checkpoint.messages.at(-1)?.text === "设备") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(checkpoint.messages.at(-1)?.text, "设备");
    assert.equal(checkpoint.messages.at(-1)?.status, "streaming");
    await call("reply.cancel");
    const cancelled = (await snapshot()).conversations.find(
      (c) => c.id === current.id,
    )!;
    assert.equal(cancelled.messages.at(-1)?.status, "stopped");
    await kernel.dispose();
    kernel = await bootstrapAndroid(directory, resolve("."), native);
    api = mobileApi(kernel, native);
    const restored = await snapshot();
    assert.equal(restored.companion.nickname, "柚子测试");
    assert.equal(restored.activeReply, null);
    assert.equal(
      restored.conversations.find((c) => c.id === current.id)?.messages.at(-1)
        ?.status,
      "stopped",
    );
    const rejected = await api({
      protocolVersion: 1,
      id: "invalid",
      method: "message.send",
      params: { text: "", conversationId: null },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "INVALID_INPUT");
  } finally {
    await kernel.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
