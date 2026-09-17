import test from "node:test";
import assert from "node:assert/strict";
import { Kernel, type Context, type Plugin } from "../packages/kernel/index.ts";
declare module "../packages/kernel/index.ts" {
  interface Services {
    "test.clock": { read(): number };
    "test.consumer": { read(): number };
  }
}
const manifest = (id: string, provides: any[] = [], requires: any[] = []) => ({
  manifestVersion: 1 as const,
  id,
  version: "1.0.0",
  provides,
  requires,
});
const clock: Plugin = {
  manifest: manifest("test.clock", ["test.clock"]),
  start(ctx) {
    ctx.provide("test.clock", { read: () => 42 });
  },
};
test("插件按能力拓扑启动，停止时先释放消费者，旧服务引用失效", async () => {
  const k = new Kernel(),
    order: string[] = [];
  k.install({
    manifest: manifest("test.consumer", ["test.consumer"], ["test.clock"]),
    start(ctx) {
      const clock = ctx.use("test.clock");
      ctx.provide("test.consumer", { read: () => clock.read() });
      ctx.effect(() => {
        assert.equal(clock.read(), 42);
        order.push("consumer");
      });
    },
  });
  k.install({
    ...clock,
    start(ctx) {
      clock.start(ctx);
      ctx.effect(() => {
        order.push("clock");
      });
    },
  });
  await k.startAll();
  const reference = k.resolve("test.consumer");
  assert.equal(reference.read(), 42);
  await assert.rejects(k.stop("test.clock"), /先停止/);
  await k.dispose();
  assert.deepEqual(order, ["consumer", "clock"]);
  assert.throws(() => reference.read(), /释放/);
});
test("停止清理订阅和计时器；停止后仍能重新加载", async () => {
  const k = new Kernel();
  let calls = 0;
  k.install({
    manifest: manifest("test.events"),
    start(ctx) {
      ctx.on("test.ping", () => {
        calls++;
      });
      ctx.timeout(() => {
        calls += 100;
      }, 30);
    },
  });
  await k.startAll();
  k.emit("test.ping", null);
  assert.equal(calls, 1);
  await k.stop("test.events");
  k.emit("test.ping", null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
  await k.start("test.events");
  k.emit("test.ping", null);
  assert.equal(calls, 2);
  await k.uninstall("test.events");
  assert.deepEqual(k.snapshot(), []);
});
test("失败的插件回滚已注册能力与副作用，不影响其他插件", async () => {
  const k = new Kernel();
  let cleanup = false;
  k.install(clock);
  await k.start("test.clock");
  k.install({
    manifest: manifest("test.bad", ["test.consumer"]),
    start(ctx) {
      ctx.provide("test.consumer", { read: () => 1 });
      ctx.effect(() => {
        cleanup = true;
      });
      throw new Error("预期失败");
    },
  });
  await assert.rejects(k.start("test.bad"), /预期失败/);
  assert.equal(cleanup, true);
  assert.throws(() => k.resolve("test.consumer"));
  assert.equal(k.resolve("test.clock").read(), 42);
  await k.dispose();
});
test("权限需要同时声明与宿主授予", async () => {
  const k = new Kernel();
  k.install({
    manifest: { ...manifest("test.permission"), permissions: ["screen.read"] },
    start(ctx) {
      ctx.require("screen.read");
    },
  });
  await assert.rejects(k.start("test.permission"), /权限被拒绝/);
});
test("未声明能力依赖不能隐式读取服务", async () => {
  const k = new Kernel();
  k.install(clock);
  await k.startAll();
  k.install({
    manifest: manifest("test.undeclared"),
    start(ctx) {
      ctx.use("test.clock");
    },
  });
  await assert.rejects(k.start("test.undeclared"), /未声明/);
  await k.dispose();
});
test("多个能力提供者必须由 Profile 明确选择", async () => {
  const k = new Kernel({ select: { "test.clock": "test.other" } });
  k.install(clock);
  k.install({
    manifest: manifest("test.other", ["test.clock"]),
    start(ctx) {
      ctx.provide("test.clock", { read: () => 7 });
    },
  });
  await k.startAll();
  assert.equal(k.resolve("test.clock").read(), 7);
  await k.dispose();
});
test("循环或缺失依赖给出明确错误", async () => {
  const k = new Kernel();
  k.install({
    manifest: manifest("test.cycle", ["test.consumer"], ["test.clock"]),
    start() {},
  });
  await assert.rejects(k.startAll(), /循环依赖/);
});
test("异步事件错误可诊断，其他订阅者继续处理", async () => {
  const k = new Kernel();
  let handled = false;
  k.install({
    manifest: manifest("test.listener"),
    start(ctx) {
      ctx.on("test.event", async () => {
        throw new Error("listener failed");
      });
      ctx.on("test.event", () => {
        handled = true;
      });
    },
  });
  await k.startAll();
  k.emit("test.event", {});
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(handled);
  assert.equal(k.diagnostics[0].plugin, "test.listener");
  await k.dispose();
});
