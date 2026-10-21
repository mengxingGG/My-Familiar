import test from "node:test";
import assert from "node:assert/strict";
import {
  createMobileBridge,
  isMobileSnapshot,
  type MobileTransport,
  type MobileResponse,
  type MobileRequest,
} from "../packages/mobile-bridge/index.ts";
import { createPreviewBridge } from "../apps/tauri/preview/fixture.ts";
import type { MobileSnapshot } from "../packages/mobile-contracts/index.ts";

test("移动附件桥只返回元数据，拒绝外部预览 URL 和错误附件关联", async () => {
  const attachment = { id: crypto.randomUUID(), name: "photo.png", kind: "image", mimeType: "image/png", bytes: 100 };
  let result: unknown = [{ ...attachment, privatePath: "/private/secret", data: "should-not-pass" }];
  const bridge = createMobileBridge({ listen: () => () => {}, async invoke(request) { return { protocolVersion: 1, id: request.id, ok: true, result }; } });
  try {
    assert.deepEqual(await bridge.request("media.choose", undefined), [attachment]);
    assert.deepEqual(await bridge.request("media.paste", undefined), [attachment]);
    result = [{ ...attachment, bytes: -1 }];
    await assert.rejects(bridge.request("media.paste", undefined));
    result = { attachment, dataUrl: "https://external.invalid/tracking.png" };
    await assert.rejects(bridge.request("media.preview", { id: attachment.id }));
    result = { attachment: { ...attachment, id: crypto.randomUUID() }, text: "wrong attachment" };
    await assert.rejects(bridge.request("media.preview", { id: attachment.id }));
    result = { attachment, dataUrl: "data:image/png;base64,iVBORw0KGgo=", privatePath: "/private/secret" };
    assert.deepEqual(await bridge.request("media.preview", { id: attachment.id }), { attachment, dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
  } finally { bridge.dispose(); }
});

test("系统听写桥只接受有界纯文本或取消，不暴露接收应用附加字段", async () => {
  let result: unknown = { text: "<script>普通文字</script>", privatePath: "/private/ignored" };
  const bridge = createMobileBridge({ listen: () => () => {}, async invoke(request) { return { protocolVersion: 1, id: request.id, ok: true, result }; } });
  try {
    assert.deepEqual(await bridge.request("voice.system.input", { conversationId: null }), { text: "<script>普通文字</script>" });
    result = { text: null }; assert.deepEqual(await bridge.request("voice.system.input", { conversationId: null }), { text: null });
    for (const invalid of [{}, { text: 42 }, { text: "字".repeat(8001) }]) { result = invalid; await assert.rejects(bridge.request("voice.system.input", { conversationId: null })); }
    const snapshot = await seed();
    if (snapshot.voice) { snapshot.voice.systemInput = true; assert(isMobileSnapshot(snapshot)); }
  } finally { bridge.dispose(); }
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function seed() {
  const preview = createPreviewBridge();
  const snapshot = await preview.request("snapshot.get", undefined);
  preview.dispose();
  return snapshot;
}
test("移动桥优先保留新事件，迟到快照不能覆盖；监听者只能修改自己的副本", async () => {
  const old = await seed();
  let emit!: (value: unknown) => void;
  const response = deferred<MobileResponse>();
  let request!: MobileRequest;
  const bridge = createMobileBridge({
    listen(listener) {
      emit = listener;
      return () => {};
    },
    invoke(r) {
      request = r;
      return response.promise;
    },
  });
  const revisions: number[] = [];
  bridge.subscribe((value) => {
    value.provider.model = "changed-by-listener";
  });
  bridge.subscribe((value) => {
    revisions.push(value.revision);
    assert.notEqual(value.provider.model, "changed-by-listener");
  });
  const pending = bridge.request("snapshot.get", undefined);
  await Promise.resolve();
  emit({ ...old, revision: 2, internalCredential: "SECRET-HOST" });
  emit({ ...old, revision: 1 });
  response.resolve({
    protocolVersion: 1,
    id: request.id,
    ok: true,
    result: old,
  });
  const current = await pending;
  assert.equal(current.revision, 2);
  assert.doesNotMatch(JSON.stringify(current), /SECRET-HOST/);
  assert.deepEqual(revisions, [2]);
  bridge.dispose();
});

test("移动桥错误脱敏、响应关联和超时不重试写操作", async () => {
  for (const scenario of [
    "native-error",
    "wrong-id",
    "timeout",
    "error-response",
  ]) {
    let calls = 0;
    const transport: MobileTransport = {
      listen() {
        return () => {};
      },
      async invoke(request) {
        calls++;
        if (scenario === "native-error")
          throw new Error("api_key=SECRET-NATIVE");
        if (scenario === "timeout") return new Promise(() => {});
        if (scenario === "wrong-id")
          return { protocolVersion: 1, id: "other", ok: true };
        return {
          protocolVersion: 1,
          id: request.id,
          ok: false,
          error: { code: "SECRET-NATIVE" },
        };
      },
    };
    const bridge = createMobileBridge(transport, { timeoutMs: 10 });
    await assert.rejects(
      bridge.request("message.send", {
        text: "test",
        conversationId: "welcome",
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /SECRET|api_key/);
        return true;
      },
    );
    assert.equal(calls, 1);
    bridge.dispose();
  }
});

test("移动桥释放取消待处理请求、注销事件，不再派发新调用", async () => {
  let unlistened = 0,
    calls = 0;
  const bridge = createMobileBridge({
    listen() {
      return () => {
        unlistened++;
      };
    },
    invoke() {
      calls++;
      return new Promise(() => {});
    },
  });
  const pending = bridge.request("snapshot.get", undefined);
  const rejected = assert.rejects(pending, /连接已经关闭/);
  bridge.dispose();
  bridge.dispose();
  await rejected;
  await assert.rejects(
    bridge.request("snapshot.get", undefined),
    /连接已经关闭/,
  );
  assert.equal(unlistened, 1);
  assert.equal(calls, 0);
});

test("移动桥拒绝凭据回填和坏会话引用", async () => {
  const snapshot = await seed();
  assert.ok(isMobileSnapshot(snapshot));
  assert.equal(
    isMobileSnapshot({
      ...snapshot,
      provider: { ...snapshot.provider, apiKey: "secret" },
    }),
    false,
  );
  assert.equal(
    isMobileSnapshot({ ...snapshot, activeConversationId: "missing" }),
    false,
  );
  assert.equal(
    isMobileSnapshot({
      ...snapshot,
      activeReply: { conversationId: "welcome", messageId: "missing" },
    }),
    false,
  );
});

test("预览取消后迟到分片不能污染下一轮或已删除会话", async () => {
  const preview = createPreviewBridge({ intervalMs: 2 });
  await preview.request("message.send", {
    text: "第一条",
    conversationId: "welcome",
  });
  await preview.request("reply.cancel", undefined);
  const stopped = await preview.request("snapshot.get", undefined);
  const firstReply = stopped.conversations[0].messages.at(-1)!;
  assert.equal(firstReply.status, "stopped");
  await preview.request("message.send", {
    text: "第二条",
    conversationId: "welcome",
  });
  await preview.request("conversation.delete", { id: "welcome" });
  await new Promise((r) => setTimeout(r, 20));
  const final = await preview.request("snapshot.get", undefined);
  assert.equal(final.activeReply, null);
  assert.equal(
    final.conversations.some((c) => c.id === "welcome"),
    false,
  );
  preview.dispose();
});

test("预览保持密钥不回填，非法保存不覆盖原设置", async () => {
  const preview = createPreviewBridge();
  await preview.request("provider.save", {
    baseUrl: "https://example.com/v1",
    model: "model",
    apiKey: "SECRET-TEST",
  });
  const saved = await preview.request("snapshot.get", undefined);
  assert.equal(saved.provider.keyConfigured, true);
  assert.doesNotMatch(JSON.stringify(saved), /SECRET-TEST/);
  await assert.rejects(
    preview.request("provider.save", {
      baseUrl: "https://user:SECRET@example.com",
      model: "bad",
    }),
  );
  assert.deepEqual(
    (await preview.request("snapshot.get", undefined)).provider,
    saved.provider,
  );
  await preview.request("provider.save", {
    baseUrl: "https://example.com/v1",
    model: "model",
    clearApiKey: true,
  });
  assert.equal(
    (await preview.request("snapshot.get", undefined)).provider.keyConfigured,
    false,
  );
  preview.dispose();
});

test("移动桥供应商目录不泄露凭据，预览按类型和地址隔离密钥状态", async () => {
  const preview = createPreviewBridge();
  try {
    await preview.request("provider.save", {
      kind: "compatible",
      baseUrl: "https://example.com/v1",
      model: "test",
      apiKey: "SECRET-FIXTURE",
    });
    const first = await preview.request("snapshot.get", undefined);
    assert(isMobileSnapshot(first));
    assert(
      !isMobileSnapshot({
        ...first,
        provider: { ...first.provider, kind: "unknown" },
      }),
    );
    const leak = structuredClone(first);
    (leak.providers![0].profile as any).apiKey = "secret";
    assert(!isMobileSnapshot(leak));
    await preview.request("provider.save", {
      kind: "gemini",
      baseUrl: "https://example.com/v1",
      model: "test",
    });
    assert.equal(
      (await preview.request("snapshot.get", undefined)).provider.keyConfigured,
      false,
    );
    await preview.request("provider.save", {
      kind: "compatible",
      baseUrl: "https://example.com/v2",
      model: "test",
    });
    assert.equal(
      (await preview.request("snapshot.get", undefined)).provider.keyConfigured,
      false,
    );
    await preview.request("provider.save", {
      kind: "compatible",
      baseUrl: "https://example.com/v1",
      model: "test",
    });
    assert.equal(
      (await preview.request("snapshot.get", undefined)).provider.keyConfigured,
      true,
    );
    assert(
      !JSON.stringify(
        await preview.request("snapshot.get", undefined),
      ).includes("SECRET-FIXTURE"),
    );
  } finally {
    preview.dispose();
  }
});

test("发送绑定原会话，当前选中项改变不重定向；空目标原子新建", async () => {
  const preview = createPreviewBridge({ intervalMs: 10 });
  await preview.request("conversation.select", { id: "yesterday" });
  await preview.request("message.send", {
    conversationId: "welcome",
    text: "只属于原会话",
  });
  let state = await preview.request("snapshot.get", undefined);
  assert.equal(state.activeConversationId, "yesterday");
  assert.ok(
    state.conversations
      .find((c) => c.id === "welcome")
      ?.messages.some((m) => m.text === "只属于原会话"),
  );
  assert.equal(
    state.conversations.find((c) => c.id === "yesterday")?.messages.length,
    1,
  );
  await preview.request("reply.cancel", undefined);
  await preview.request("message.send", {
    conversationId: null,
    text: "新的一页",
  });
  state = await preview.request("snapshot.get", undefined);
  assert.notEqual(state.activeConversationId, "yesterday");
  assert.equal(
    state.conversations.find((c) => c.id === state.activeConversationId)
      ?.messages[0].text,
    "新的一页",
  );
  preview.dispose();
});

test("系统表单交接保持待用户完成；停止不会被迟到回调改成成功", async () => {
  const preview = createPreviewBridge({ intervalMs: 1 });
  const complete = new Promise<MobileSnapshot>((resolve) => {
    const off = preview.subscribe((s) => {
      if (s.tasks.length) {
        off();
        resolve(s);
      }
    });
  });
  await preview.request("message.send", {
    text: "请放进日历",
    conversationId: "welcome",
  });
  const snapshot = await complete;
  const id = snapshot.tasks[0].id;
  await preview.request("task.respond", { id, action: "approve" });
  await preview.request("task.respond", { id, action: "stop" });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(
    (await preview.request("snapshot.get", undefined)).tasks[0].status,
    "stopped",
  );
  preview.dispose();
});
