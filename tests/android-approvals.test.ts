import test from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../packages/kernel/index.ts";
import { definePlugin } from "../packages/contracts/index.ts";
import { agentTools } from "../plugins/agent-tools/index.ts";
import { androidApprovals } from "../plugins/platform-android/approvals.ts";
import type { MobileApprovalSnapshot } from "../packages/mobile-contracts/index.ts";

test("Android 悬浮审批复用共享所有者，推送批准/取消结果且无会话配置泄露", async () => {
  const snapshots: MobileApprovalSnapshot[] = [];
  const kernel = new Kernel();
  kernel.install(definePlugin({
    manifest: { manifestVersion: 1, id: "test.storage", version: "1", provides: ["storage.local"], requires: [] },
    start(ctx) { ctx.provide("storage.local", { async read(_key, fallback) { return fallback; }, async write() {} }); },
  }));
  kernel.install(agentTools);
  kernel.install(androidApprovals({ async call<T>(method: string, params?: Record<string, unknown>) {
    assert.equal(method, "approvals.update"); snapshots.push(structuredClone(params) as unknown as MobileApprovalSnapshot); return undefined as T;
  } }));
  await kernel.startAll();
  try {
    const owner = kernel.resolve("agent.approvals");
    const cancel = new AbortController();
    let settled = false;
    const pending = owner.request("执行一步", '{"tool": "android_action", "nodeId": "4"}', cancel.signal).then(() => { settled = true; });
    const first = snapshots.at(-1)!;
    assert.equal(first.tasks.length, 1);
    assert.equal(first.tasks[0].kind, "accessibility");
    assert.deepEqual(Object.keys(first).sort(), ["protocolVersion", "revision", "tasks"]);
    assert.equal(settled, false);
    await owner.decide(first.tasks[0].id, true, "once"); await pending;
    assert.equal(snapshots.at(-1)!.tasks.length, 0);
    assert(snapshots.at(-1)!.revision > first.revision);
    await assert.rejects(owner.decide(first.tasks[0].id, true, "once"));
    const aborted = assert.rejects(owner.request("不能重放", "目标", cancel.signal));
    cancel.abort(); await aborted;
    assert.equal(snapshots.at(-1)!.tasks.length, 0);
  } finally { await kernel.dispose(); }
});
