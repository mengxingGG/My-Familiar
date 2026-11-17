import test from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../packages/kernel/index.ts";
import { definePlugin, type LifeCommand } from "../packages/contracts/index.ts";
import { commands } from "../plugins/commands/index.ts";
import { createPetLife } from "../plugins/pet-life/index.ts";
import {
  projectLife,
  projectAnimation,
  validLife,
} from "../packages/mobile-bridge/life.ts";
import {
  advanceLife,
  applyLifeCommand,
  awardChat,
  createLifeStore,
  growth,
  HOUR,
  lifeSnapshot,
  validateLifeStore,
  type LifeStore,
} from "../plugins/pet-life/state.ts";

const START = Date.parse("2026-11-02T00:00:00Z");
function fixture(at = START) {
  let sequence = 0;
  const id = () => `fixture-${++sequence}`;
  const state = createLifeStore(at, id, "Asia/Taipei");
  const act = (
    command: Omit<LifeCommand, "requestId"> | Record<string, unknown>,
    now = state.lastAt,
    requestId = id(),
  ) => applyLifeCommand(state, { ...command, requestId }, now, id);
  const tick = (duration: number, online = true) => {
    const target = state.lastAt + duration;
    while (state.lastAt < target)
      advanceLife(state, Math.min(target, state.lastAt + 30_000), online, id);
  };
  return { state, id, act, tick };
}

test("签到和购买按请求去重，错误请求不扣钱，重复 ID 不可改变用途", () => {
  const { state, act } = fixture();
  act({ kind: "checkin" }, START, "checkin-0001");
  assert.equal(state.stones, 90);
  assert.equal(state.totalXp, 10);
  assert.equal(act({ kind: "checkin" }, START, "checkin-0001"), false);
  assert.throws(() => act({ kind: "checkin" }), /已经签到/);
  act(
    { kind: "buy", itemId: "food-basic", quantity: 2 },
    START,
    "purchase-0001",
  );
  assert.equal(state.stones, 82);
  assert.equal(state.inventory.food[0].quantity, 10);
  assert.equal(
    act(
      { kind: "buy", itemId: "food-basic", quantity: 2 },
      START,
      "purchase-0001",
    ),
    false,
  );
  assert.throws(
    () =>
      act(
        { kind: "buy", itemId: "food-basic", quantity: 3 },
        START,
        "purchase-0001",
      ),
    /其他请求/,
  );
  for (const quantity of [-1, 0, NaN, Infinity, 1.5, 100])
    assert.throws(() => act({ kind: "buy", itemId: "food-basic", quantity }));
  assert.throws(
    () => act({ kind: "buy", itemId: "wood-bed", quantity: 1 }),
    /灵石不够/,
  );
  assert.throws(
    () => act({ kind: "buy", itemId: "forest-chair", quantity: 1 }),
    /5 级/,
  );
  assert.equal(state.stones, 82);
  validateLifeStore(state);
});

test("在线每日封顶，锁屏和离线不发挂机收益，睡眠和照料经验独立封顶", () => {
  const { state, tick, id } = fixture();
  tick(8 * HOUR);
  assert.equal(state.daily.onlineStones, 48);
  assert.equal(state.daily.onlineXp, 30);
  assert.equal(state.daily.onlineMinutes, 480);
  assert.equal(state.stones, 128);
  tick(HOUR, false);
  assert.equal(state.daily.onlineMinutes, 480);
  const xp = state.totalXp;
  advanceLife(state, state.lastAt + 2 * HOUR, false, id);
  assert.equal(state.totalXp, xp);
  assert.equal(state.daily.onlineStones, 48);
  assert.equal(state.lastAt, START + 11 * HOUR);
  validateLifeStore(state);
});

test("午夜只开启一次新签到日，回拨不重结算，长时跳跃最多补算 72 小时", () => {
  const { state, act, id } = fixture(Date.parse("2026-11-02T15:59:45Z"));
  act({ kind: "checkin" });
  advanceLife(state, state.lastAt + 30_000, true, id);
  assert.equal(state.daily.day, "2026-11-03");
  assert.equal(state.daily.checkedIn, false);
  assert.equal(state.daily.onlineMinutes, 0.25);
  act({ kind: "checkin" });
  const snapshot = structuredClone(state);
  advanceLife(state, state.lastAt - HOUR, true, id);
  assert.deepEqual(state, snapshot);
  assert.throws(
    () => act({ kind: "checkin" }, state.lastAt - HOUR),
    /已经签到/,
  );
  const other = fixture();
  other.state.inventory.food[0].quantity = 0;
  advanceLife(other.state, START + 200 * HOUR, true, other.id);
  assert.equal(other.state.daily.onlineStones, 0);
  assert.equal(other.state.totalXp, 0);
  assert.ok(
    other.state.needs.hungerHours > 51 && other.state.needs.hungerHours < 53,
  );
  assert.equal(other.state.lastAt, START + 200 * HOUR);
  validateLifeStore(other.state);
});

test("离线按顺序吃基础口粮，关闭自动吃的特殊食物保留，缺粮只改变外观", () => {
  const { state, id, act } = fixture();
  state.inventory.food[0].quantity = 2;
  state.inventory.food.push({
    itemId: "food-dessert",
    quantity: 1,
    autoFeed: false,
  });
  advanceLife(state, START + 72 * HOUR, false, id);
  assert.equal(state.inventory.food[0].quantity, 0);
  assert.equal(state.inventory.food[1].quantity, 1);
  assert.equal(state.totalXp, 0);
  assert.equal(state.stones, 80);
  assert.equal(state.needs.weakness, 1);
  advanceLife(state, state.lastAt + 24 * HOUR, false, id);
  assert.equal(state.needs.weakness, 2);
  advanceLife(state, state.lastAt + 24 * HOUR, false, id);
  assert.equal(state.needs.weakness, 3);
  state.needs.sleeping = false;
  assert.equal(lifeSnapshot(state).presentation.action, "dejected");
  act({ kind: "feed", itemId: "food-dessert" });
  assert.equal(state.needs.weakness, 2);
  assert.equal(lifeSnapshot(state).presentation.action, "eat");
  assert.equal(
    lifeSnapshot(state, state.lastAt + 6500).presentation.action,
    "full",
  );
  assert.equal(
    lifeSnapshot(state, state.lastAt + 8500).presentation.action,
    "weak",
  );
  advanceLife(state, state.lastAt + 6 * HOUR, false, id);
  assert.ok(state.needs.hungerHours < 30);
  assert.equal(state.totalXp, 10);
  validateLifeStore(state);
});

test("自动进食动画有完整播放窗口，照料经验不会随手动连点反复领取", () => {
  const { state, id, act, tick } = fixture();
  state.needs.fullness = 40;
  advanceLife(state, START + 30_000, true, id);
  assert.equal(state.inventory.food[0].quantity, 7);
  assert.equal(state.totalXp, 10);
  assert.equal(lifeSnapshot(state).presentation.until, START + 36_000);
  act({ kind: "feed", itemId: "food-basic" });
  assert.equal(state.totalXp, 10);
  act({ kind: "play" });
  act({ kind: "play" });
  assert.equal(state.totalXp, 20);
  act({ kind: "sleep", sleeping: true });
  tick(30 * 60_000, false);
  assert.ok(state.daily.completed.includes("sleep"));
  assert.equal(state.totalXp, 30);
});

test("聊天只对独立完成轮次发奖，有间隔、重复文本去重和每日上限", () => {
  const { state, id } = fixture();
  assert.equal(
    awardChat(state, { id: "turn-1", text: "你好", at: START }, id),
    true,
  );
  assert.equal(
    awardChat(state, { id: "turn-1", text: "修改", at: START + 60_000 }, id),
    false,
  );
  assert.equal(
    awardChat(state, { id: "turn-2", text: "你好", at: START + 60_000 }, id),
    false,
  );
  assert.equal(
    awardChat(state, { id: "turn-3", text: "不同", at: START + 30_000 }, id),
    false,
  );
  for (let i = 0; i < 20; i++)
    awardChat(
      state,
      {
        id: `next-${i}`,
        text: `今天的第 ${i} 件事`,
        at: START + (i + 2) * 60_000,
      },
      id,
    );
  assert.equal(state.daily.chatRewards, 10);
  assert.equal(state.stones, 100);
  assert.equal(state.totalXp, 20);
  assert.ok(!JSON.stringify(state).includes("今天的第"));
  validateLifeStore(state);
});

test("成长奖励只发一次，里程碑物品不重领，解锁等级统一受核心校验", () => {
  const { state, act, id } = fixture();
  for (let day = 0; day < 20; day++) {
    advanceLife(state, START + day * 24 * HOUR, false, id);
    act({ kind: "checkin" });
    state.needs.fullness = 50;
    state.inventory.food[0].quantity = 8;
    act({ kind: "feed", itemId: "food-basic" });
    act({ kind: "play" });
    for (let i = 0; i < 10; i++)
      awardChat(
        state,
        {
          id: `day-${day}-turn-${i}`,
          text: `日常 ${day} ${i}`,
          at: state.lastAt + i * 60_000,
        },
        id,
      );
  }
  const level = growth(state.totalXp).level;
  assert.ok(level >= 8);
  assert.equal(state.rewardedLevel, level);
  assert.equal(
    state.inventory.items.filter((x) => x.itemId === "forest-chair").length,
    1,
  );
  assert.equal(
    state.inventory.items.filter((x) => x.itemId === "ocean-rug").length,
    1,
  );
  const items = state.inventory.items.length;
  advanceLife(state, state.lastAt + 30_000, false, id);
  assert.equal(state.inventory.items.length, items);
  state.stones = 1000;
  act({ kind: "buy", itemId: "forest-chair", quantity: 1 });
  validateLifeStore(state);
});

test("房间保存校验实例归属、占地、边界和版本，收回不丢失已购实例", () => {
  const { state, act } = fixture();
  state.stones = 1000;
  act({ kind: "buy", itemId: "wood-bed", quantity: 2 });
  const beds = state.inventory.items.filter((x) => x.itemId === "wood-bed");
  const placement = {
    instanceId: beds[0].instanceId,
    x: 300,
    y: 400,
    rotation: 0,
  };
  act({ kind: "room.save", placements: [placement], expectedRoomRevision: 0 });
  const room = structuredClone(state.room);
  for (const placements of [
    [placement, placement],
    [{ ...placement, instanceId: "missing" }],
    [{ ...placement, x: -1 }],
    [{ ...placement, rotation: 90 }],
    [placement, { ...placement, instanceId: beds[1].instanceId }],
  ]) {
    assert.throws(() =>
      act({ kind: "room.save", placements, expectedRoomRevision: 1 }),
    );
    assert.deepEqual(state.room, room);
  }
  assert.throws(
    () => act({ kind: "room.save", placements: [], expectedRoomRevision: 0 }),
    /另一处改变/,
  );
  act({ kind: "room.save", placements: [], expectedRoomRevision: 1 });
  assert.equal(state.room.placements.length, 0);
  assert.equal(state.inventory.items.length, 4);
  validateLifeStore(state);
});

async function pluginFixture(saved?: unknown) {
  const kernel = new Kernel();
  let stored: unknown = saved;
  let fail = false;
  let time = START;
  let sequence = 0;
  kernel.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "test.life-storage",
        version: "1",
        provides: ["storage.local"],
        requires: [],
      },
      start(ctx) {
        ctx.provide("storage.local", {
          read: async <T>(_key: string, fallback: T): Promise<T> =>
            structuredClone(stored === undefined ? fallback : stored) as T,
          write: async (_key, value) => {
            if (fail) throw Error("磁盘不可写");
            stored = structuredClone(value);
          },
        });
      },
    }),
  );
  kernel.install(commands);
  kernel.install(
    createPetLife({
      now: () => time,
      id: () => `instance-${++sequence}`,
      timezone: "Asia/Taipei",
      isOnline: () => true,
      intervalMs: 1_000_000,
    }),
  );
  await kernel.startAll();
  return {
    kernel,
    life: kernel.resolve("pet.life"),
    saved: () => structuredClone(stored),
    fail: (value: boolean) => {
      fail = value;
    },
    time: (value: number) => {
      time = value;
    },
  };
}

test("并发消费和签到串行提交，写盘失败回滚全部变化，重启去重仍有效", async () => {
  const f = await pluginFixture();
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        f.life.act({ requestId: `checkin-${i}`, kind: "checkin" }),
      ),
    );
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(f.life.snapshot().wallet.stones, 90);
    const before = f.life.snapshot();
    f.fail(true);
    await assert.rejects(
      f.life.act({
        requestId: "buy-retry-1",
        kind: "buy",
        itemId: "toy-ball",
        quantity: 1,
      }),
      /磁盘不可写/,
    );
    assert.deepEqual(f.life.snapshot(), before);
    f.fail(false);
    await Promise.all([
      f.life.act({
        requestId: "buy-retry-1",
        kind: "buy",
        itemId: "toy-ball",
        quantity: 1,
      }),
      f.life.act({
        requestId: "buy-retry-1",
        kind: "buy",
        itemId: "toy-ball",
        quantity: 1,
      }),
    ]);
    assert.equal(f.life.snapshot().wallet.stones, 60);
    assert.equal(f.life.snapshot().inventory.items.length, 3);
    const saved = f.saved();
    await f.kernel.dispose();
    const restarted = await pluginFixture(saved);
    try {
      await restarted.life.act({
        requestId: "buy-retry-1",
        kind: "buy",
        itemId: "toy-ball",
        quantity: 1,
      });
      assert.equal(restarted.life.snapshot().wallet.stones, 60);
    } finally {
      await restarted.kernel.dispose();
    }
  } finally {
    await f.kernel.dispose();
  }
});

test("损坏的养成存档不会被覆盖，也不使核心其他能力启动失败", async () => {
  const bad = { schemaVersion: 99, stones: 123 };
  const f = await pluginFixture(bad);
  try {
    assert.throws(() => f.life.snapshot(), /原存档已保留/);
    await assert.rejects(
      f.life.act({ requestId: "bad-00001", kind: "checkin" }),
      /原存档已保留/,
    );
    assert.deepEqual(f.saved(), bad);
    assert.ok(f.kernel.resolve("commands"));
  } finally {
    await f.kernel.dispose();
  }
  const invalid = fixture().state;
  (invalid as LifeStore).ledger[0].stones = NaN;
  assert.throws(() => validateLifeStore(invalid));
});

test("移动养成投影仅保留公开字段，拒绝非有限数和外部动画地址", () => {
  const { state } = fixture();
  const snapshot = { ...lifeSnapshot(state), privateToken: "internal-secret" };
  Object.assign(snapshot.daily, { privateKey: "internal-secret" });
  assert.ok(validLife(snapshot));
  assert.ok(!JSON.stringify(projectLife(snapshot)).includes("internal-secret"));
  assert.equal(
    validLife({ ...snapshot, wallet: { ...snapshot.wallet, stones: NaN } }),
    false,
  );
  const animation = {
    fps: 6,
    frames: { idle: ["./characters/deepseek/idle-0.webp"] },
    timings: { idle: [400] },
    loops: { idle: true },
    privateKey: "internal-secret",
  };
  assert.equal(
    projectAnimation(animation, "deepseek").frames.idle[0],
    "./characters/deepseek/idle-0.webp",
  );
  assert.ok(
    !JSON.stringify(projectAnimation(animation, "deepseek")).includes(
      "internal-secret",
    ),
  );
  assert.throws(() =>
    projectAnimation(
      { ...animation, frames: { idle: ["https://external.invalid/pet.webp"] } },
      "deepseek",
    ),
  );
  assert.throws(() =>
    projectAnimation(
      { ...animation, timings: { idle: [400, 500] } },
      "deepseek",
    ),
  );
});
