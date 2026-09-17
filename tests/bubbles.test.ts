import test from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../packages/kernel/index.ts";
import { commands } from "../plugins/commands/index.ts";
import { bubbleChat } from "../plugins/bubble-chat/index.ts";
import {
  defaults,
  type ChatState,
  type Surface,
} from "../packages/contracts/index.ts";

test("气泡 UI 不创建聊天页面；输入收起，回复冒泡，关闭后不会被迟到分片重新弹出", async () => {
  const k = new Kernel(),
    created: string[] = [],
    visible = new Map<string, boolean>(),
    sent: unknown[] = [];
  let chat: ChatState = { messages: [], busy: false };
  const surface = {
    async create(kind: string) {
      created.push(kind);
    },
    show(kind: string, value: boolean) {
      visible.set(kind, value);
    },
    close(kind: string) {
      visible.delete(kind);
    },
    send(_kind: string, channel: string, value: unknown) {
      if (channel === "familiar:speech") sent.push(value);
    },
    resizeSpeech() {},
  } as unknown as Surface;
  k.install(commands);
  k.install({
    manifest: {
      manifestVersion: 1,
      id: "test.bubble-deps",
      version: "1",
      provides: ["platform.surface", "conversation", "settings"],
      requires: [],
    },
    start(ctx) {
      ctx.provide("platform.surface", surface);
      ctx.provide("settings", {
        get: () => structuredClone(defaults),
        apply: async (s) => s,
      });
      ctx.provide("conversation", {
        state: () => chat,
        async send(text) {
          chat = {
            busy: true,
            messages: [
              {
                id: "answer-1",
                role: "assistant",
                text: "你好",
                status: "streaming",
                time: 1,
              },
            ],
          };
          ctx.emit("conversation.changed", chat);
        },
        async cancel() {
          chat.busy = false;
          ctx.emit("conversation.changed", chat);
        },
        async clear() {
          chat = { busy: false, messages: [] };
          ctx.emit("conversation.changed", chat);
        },
      });
    },
  });
  k.install(bubbleChat);
  await k.startAll();
  assert.deepEqual(created, ["speech", "composer"]);
  const routes = k.resolve("commands");
  await routes.call("chat.open");
  assert.equal(visible.get("composer"), true);
  await routes.call("chat.send", "你好");
  assert.equal(visible.get("composer"), false);
  assert.equal(visible.get("speech"), true);
  await routes.call("speech.close");
  chat.messages[0].text += "，又一段";
  k.emit("conversation.changed", chat);
  assert.equal(visible.get("speech"), false);
  await routes.call("speech.recall");
  assert.equal(visible.get("speech"), true);
  await routes.call("chat.clear");
  assert.equal(visible.get("speech"), false);
  assert.ok(sent.length > 0);
  await k.dispose();
});
