import type {
  LifeAction,
  LifeCommand,
  LifePlacement,
  LifeSnapshot,
} from "../../packages/contracts/life.ts";
import { LIFE_CATALOG, lifeProduct, MILESTONE_ITEMS } from "./catalog.ts";

export const HOUR = 3_600_000;
const MINUTE = 60_000;
const MAX_OFFLINE = 72 * HOUR;
const MAX_STONES = 1_000_000_000;
type Needs = LifeSnapshot["needs"];
export interface LifeStore {
  schemaVersion: 1;
  revision: number;
  profileId: string;
  timezone: string;
  lastAt: number;
  stones: number;
  totalXp: number;
  rewardedLevel: number;
  needs: Needs;
  inventory: LifeSnapshot["inventory"];
  room: LifeSnapshot["room"];
  daily: LifeSnapshot["daily"] & { onlineXp: number; sleepMinutes: number };
  ledger: LifeSnapshot["wallet"]["ledger"];
  receipts: Record<string, string>;
  rewardedTurns: string[];
  lastChatAt: number;
  recentChat: { hash: string; at: number }[];
  lastPlayAt: number;
  lastAutoPlayAt: number;
  presentation: LifeSnapshot["presentation"];
  summary?: string;
}
export type IdFactory = () => string;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export const dayKey = (at: number, timezone: string) => {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timezone, formatter);
  }
  return formatter.format(at);
};
const freshDay = (day: string): LifeStore["daily"] => ({
  day,
  checkedIn: false,
  onlineMinutes: 0,
  onlineStones: 0,
  onlineXp: 0,
  chatRewards: 0,
  xp: 0,
  completed: [],
  sleepMinutes: 0,
});
const clamp = (n: number) => Math.max(0, Math.min(100, n));
export function growth(totalXp: number): LifeSnapshot["growth"] {
  let level = 1,
    rest = totalXp;
  while (level < 20 && rest >= 60 + 20 * (level - 1)) {
    rest -= 60 + 20 * (level - 1);
    level++;
  }
  return {
    level,
    totalXp,
    levelXp: rest,
    nextLevelXp: level === 20 ? 0 : 60 + 20 * (level - 1),
    maxLevel: 20,
  };
}
export function createLifeStore(
  now: number,
  id: IdFactory,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): LifeStore {
  const mat = id(),
    bowl = id();
  return {
    schemaVersion: 1,
    revision: 0,
    profileId: id(),
    timezone,
    lastAt: now,
    stones: 80,
    totalXp: 0,
    rewardedLevel: 1,
    needs: {
      fullness: 80,
      energy: 80,
      joy: 80,
      hungerHours: 0,
      weakness: 0,
      sleeping: false,
    },
    inventory: {
      food: [{ itemId: "food-basic", quantity: 8, autoFeed: true }],
      items: [
        { instanceId: mat, itemId: "starter-mat" },
        { instanceId: bowl, itemId: "starter-bowl" },
      ],
    },
    room: {
      revision: 0,
      width: 1000,
      height: 700,
      placements: [
        { instanceId: mat, x: 650, y: 510, rotation: 0 },
        { instanceId: bowl, x: 330, y: 550, rotation: 0 },
      ],
    },
    daily: freshDay(dayKey(now, timezone)),
    ledger: [
      { id: id(), at: now, label: "初次见面的小礼物", stones: 80, xp: 0 },
    ],
    receipts: {},
    rewardedTurns: [],
    lastChatAt: 0,
    recentChat: [],
    lastPlayAt: 0,
    lastAutoPlayAt: now,
    presentation: { action: "idle", until: 0 },
  };
}
function ensureDay(s: LifeStore, at: number) {
  const day = dayKey(at, s.timezone);
  // 回拨时不重新开启一个已经结算过的自然日。
  if (day > s.daily.day) s.daily = freshDay(day);
}
function record(
  s: LifeStore,
  id: IdFactory,
  at: number,
  label: string,
  stones = 0,
  xp = 0,
) {
  s.ledger.push({ id: id(), at, label, stones, xp });
  if (s.ledger.length > 80) s.ledger.splice(0, s.ledger.length - 80);
}
function addItem(s: LifeStore, itemId: string, count: number, id: IdFactory) {
  const product = lifeProduct(itemId);
  if (!product) throw new Error("物品不存在");
  if (product.kind === "food") {
    let stack = s.inventory.food.find((x) => x.itemId === itemId);
    if (!stack) {
      stack = { itemId, quantity: 0, autoFeed: !!product.defaultAutoFeed };
      s.inventory.food.push(stack);
    }
    stack.quantity += count;
  } else
    for (let i = 0; i < count; i++)
      s.inventory.items.push({ instanceId: id(), itemId });
}
function addXp(
  s: LifeStore,
  amount: number,
  at: number,
  id: IdFactory,
  label: string,
) {
  amount = Math.min(amount, Math.max(0, 90 - s.daily.xp));
  if (amount <= 0) return;
  s.daily.xp += amount;
  s.totalXp += amount;
  record(s, id, at, label, 0, amount);
  const level = growth(s.totalXp).level;
  while (s.rewardedLevel < level) {
    s.rewardedLevel++;
    s.stones = Math.min(MAX_STONES, s.stones + 10);
    addItem(s, "food-basic", 1, id);
    const reward = MILESTONE_ITEMS[s.rewardedLevel];
    if (reward) addItem(s, reward, 1, id);
    record(
      s,
      id,
      at,
      `升到 ${s.rewardedLevel} 级：口粮${reward ? "与" + lifeProduct(reward)!.name : ""}`,
      10,
      0,
    );
  }
}
function dailyCare(
  s: LifeStore,
  key: string,
  at: number,
  id: IdFactory,
  eligible: boolean,
) {
  if (!eligible || s.daily.completed.includes(key)) return;
  s.daily.completed.push(key);
  addXp(
    s,
    10,
    at,
    id,
    (
      { feed: "好好吃饭", sleep: "充分休息", play: "开心玩耍" } as Record<
        string,
        string
      >
    )[key] ?? key,
  );
}
function updateWeakness(s: LifeStore) {
  const h = s.needs.hungerHours;
  s.needs.weakness = h >= 72 ? 3 : h >= 36 ? 2 : h >= 12 ? 1 : 0;
}
function eat(
  s: LifeStore,
  itemId: string,
  at: number,
  id: IdFactory,
  eligible: boolean,
  visible: boolean,
) {
  const food = lifeProduct(itemId),
    stack = s.inventory.food.find((x) => x.itemId === itemId);
  input(
    food && food.kind === "food" && stack && stack.quantity >= 1,
    "背包里没有这份食物",
  );
  input(s.needs.fullness < 100, "已经吃饱了，留到下次吧");
  stack.quantity--;
  s.needs.fullness = clamp(s.needs.fullness + (food.nutrition ?? 0));
  s.needs.hungerHours = Math.max(0, s.needs.hungerHours - 12);
  updateWeakness(s);
  dailyCare(s, "feed", at, id, eligible);
  if (visible) s.presentation = { action: "eat", until: at + 6000 };
}
function autoFood(s: LifeStore) {
  return s.inventory.food.find(
    (x) =>
      x.quantity > 0 &&
      x.autoFeed &&
      (lifeProduct(x.itemId)?.nutrition ?? 0) > 0,
  );
}
const hasPlacedToy = (s: LifeStore) =>
  s.room.placements.some((p) =>
    s.inventory.items.some(
      (item) =>
        item.instanceId === p.instanceId &&
        lifeProduct(item.itemId)?.kind === "toy",
    ),
  );
/** 事件边界与分钟步进共同限制工作量；离线状态按历史顺序消费库存。 */
export function advanceLife(
  s: LifeStore,
  now: number,
  online: boolean,
  id: IdFactory,
) {
  if (!Number.isFinite(now) || now <= s.lastAt) return;
  const elapsed = now - s.lastAt,
    live = elapsed <= 90_000;
  const duration = Math.min(elapsed, MAX_OFFLINE);
  const previousPresentation = s.presentation;
  let t = s.lastAt,
    remaining = duration,
    meals = 0;
  while (remaining > 0.001) {
    ensureDay(s, t);
    const n = s.needs;
    while (n.fullness <= 40 && autoFood(s)) {
      eat(s, autoFood(s)!.itemId, t, id, live, live);
      meals++;
    }
    if (n.energy <= 30) n.sleeping = true;
    if (n.sleeping && n.energy >= 90) n.sleeping = false;
    if (hasPlacedToy(s) && t - s.lastAutoPlayAt >= 6 * HOUR && !n.sleeping) {
      n.joy = clamp(n.joy + 15);
      s.lastAutoPlayAt = t;
      dailyCare(s, "play", t, id, live);
      if (live) s.presentation = { action: "play", until: t + 5000 };
    }
    let step = Math.min(MINUTE, remaining);
    for (const threshold of [40, 20, 0])
      if (n.fullness > threshold)
        step = Math.min(step, ((n.fullness - threshold) / 3) * HOUR);
    const energyTarget = n.sleeping ? 90 : 30;
    const toEnergy = n.sleeping
      ? ((energyTarget - n.energy) / 12) * HOUR
      : ((n.energy - energyTarget) / 4) * HOUR;
    if (toEnergy > 0.001) step = Math.min(step, toEnergy);
    // 跨午夜的收益准确归属各自自然日，包括具有夏令时的固定档案时区。
    if (dayKey(t + step, s.timezone) !== s.daily.day) {
      let lo = Math.floor(t),
        hi = Math.ceil(t + step);
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (dayKey(mid, s.timezone) === s.daily.day) lo = mid;
        else hi = mid;
      }
      step = Math.min(step, Math.max(1, hi - t));
    }
    step = Math.max(0.001, Math.min(step, remaining));
    const hours = step / HOUR;
    const hungry = n.fullness <= 20 && !autoFood(s);
    if (hungry) n.hungerHours = Math.min(72, n.hungerHours + hours);
    else if (n.fullness >= 50)
      n.hungerHours = Math.max(0, n.hungerHours - 6 * hours);
    n.fullness = clamp(n.fullness - 3 * hours);
    n.energy = clamp(n.energy + (n.sleeping ? 12 : -4) * hours);
    n.joy = clamp(n.joy - hours);
    if (live && n.sleeping) {
      s.daily.sleepMinutes += step / MINUTE;
      if (s.daily.sleepMinutes >= 30) dailyCare(s, "sleep", t + step, id, true);
    }
    if (live && online) {
      s.daily.onlineMinutes += step / MINUTE;
      const stones = Math.min(
        48,
        Math.floor((s.daily.onlineMinutes + 1e-7) / 15) * 2,
      );
      if (stones > s.daily.onlineStones) {
        const delta = stones - s.daily.onlineStones;
        s.stones = Math.min(MAX_STONES, s.stones + delta);
        s.daily.onlineStones = stones;
        record(s, id, t + step, "在线陪伴", delta);
      }
      const xp = Math.min(
        30,
        Math.floor((s.daily.onlineMinutes + 1e-7) / 30) * 5,
      );
      if (xp > s.daily.onlineXp) {
        addXp(s, xp - s.daily.onlineXp, t + step, id, "陪伴成长");
        s.daily.onlineXp = xp;
      }
    }
    t += step;
    remaining -= step;
  }
  s.lastAt = now;
  ensureDay(s, now);
  updateWeakness(s);
  if (live && s.presentation !== previousPresentation)
    s.presentation.until =
      now + (s.presentation.action === "eat" ? 6000 : 5000);
  if (!live && elapsed > 5 * MINUTE)
    s.summary = `离开期间${meals ? `吃了 ${meals} 份食物` : "安静休息"}${elapsed > MAX_OFFLINE ? "，超过三天的时间已进入休养期" : ""}。`;
}
export function lifeAction(s: LifeStore, now = s.lastAt): LifeAction {
  if (s.presentation.until > now) return s.presentation.action;
  if (s.presentation.action === "eat" && s.presentation.until + 2000 > now)
    return "full";
  if (s.needs.sleeping) return "sleep";
  if (s.needs.weakness === 3) return "dejected";
  if (s.needs.weakness >= 1) return "weak";
  if (s.needs.fullness < 20) return "hungry";
  if (s.needs.energy < 40) return "drowsy";
  return "idle";
}
export function lifeSnapshot(s: LifeStore, at = s.lastAt): LifeSnapshot {
  const action = lifeAction(s, at);
  return structuredClone({
    schemaVersion: 1,
    revision: s.revision,
    profileId: s.profileId,
    needs: s.needs,
    presentation: {
      action,
      until:
        action === "full"
          ? s.presentation.until + 2000
          : s.presentation.until > at
            ? s.presentation.until
            : 0,
    },
    wallet: { stones: s.stones, ledger: s.ledger },
    growth: growth(s.totalXp),
    daily: s.daily,
    inventory: s.inventory,
    room: s.room,
    catalog: LIFE_CATALOG,
    ...(s.summary ? { summary: s.summary } : {}),
  });
}
function validNumber(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}
function validInteger(n: unknown, min: number, max: number): n is number {
  return validNumber(n, min, max) && Number.isInteger(n);
}
function input(
  condition: unknown,
  message = "操作参数无效",
  code = "INVALID_INPUT",
): asserts condition {
  if (!condition) throw Object.assign(new Error(message), { code });
}
export function validatePlacements(
  s: LifeStore,
  value: unknown,
): asserts value is LifePlacement[] {
  input(Array.isArray(value) && value.length <= 200, "房间最多放置 200 件物品");
  const seen = new Set<string>();
  const solid: { x: number; y: number; w: number; h: number }[] = [];
  for (const p of value) {
    input(
      p &&
        typeof p === "object" &&
        typeof p.instanceId === "string" &&
        !seen.has(p.instanceId),
      "物品位置重复或无效",
    );
    seen.add(p.instanceId);
    const item = s.inventory.items.find((i) => i.instanceId === p.instanceId),
      product = item && lifeProduct(item.itemId),
      shape = product?.placement;
    input(shape, "只能摆放已拥有的物品");
    const visual = product?.visual,
      half = Math.max(shape.width / 2, (visual?.width ?? 0) / 2),
      top = Math.max(
        250,
        shape.height,
        (visual?.height ?? 0) * (visual?.anchor.y ?? 1),
      );
    input(
      validNumber(p.x, half, 1000 - half) && validNumber(p.y, top, 700),
      "物品超出了房间边界",
    );
    input(shape.rotations.includes(p.rotation), "该物品不支持这个朝向");
    if (shape.layer === "floor") {
      const box = { x: p.x, y: p.y, w: shape.width, h: shape.height };
      input(
        !solid.some(
          (other) =>
            Math.abs(other.x - box.x) < (other.w + box.w) / 2 - 1 &&
            Math.min(other.y, box.y) >
              Math.max(other.y - other.h, box.y - box.h) + 1,
        ),
        "家具占地重叠了，请挪开一些",
      );
      solid.push(box);
    }
  }
}
/** 纯状态变更，调用者负责串行化、落盘成功后提交和发布。 */
export function applyLifeCommand(
  s: LifeStore,
  value: unknown,
  now: number,
  id: IdFactory,
): boolean {
  input(value && typeof value === "object");
  const c = value as LifeCommand;
  input(
    typeof c.requestId === "string" &&
      /^[A-Za-z0-9-]{8,100}$/.test(c.requestId),
    "缺少有效的操作编号",
  );
  const fingerprint = JSON.stringify(c);
  if (Object.hasOwn(s.receipts, c.requestId)) {
    input(s.receipts[c.requestId] === fingerprint, "操作编号已被其他请求使用");
    return false;
  }
  ensureDay(s, Math.max(now, s.lastAt));
  switch (c.kind) {
    case "checkin":
      input(!s.daily.checkedIn, "今天已经签到过了");
      s.daily.checkedIn = true;
      s.stones = Math.min(MAX_STONES, s.stones + 10);
      record(s, id, now, "每日签到", 10);
      addXp(s, 10, now, id, "签到成长");
      break;
    case "buy": {
      const p = lifeProduct(c.itemId);
      input(p?.purchasable, "这件物品不能购买");
      input(
        growth(s.totalXp).level >= p.unlockLevel,
        `达到 ${p.unlockLevel} 级后解锁`,
      );
      input(
        validInteger(c.quantity, 1, p.kind === "food" ? 99 : 20),
        "购买数量无效",
      );
      input(s.stones >= p.price * c.quantity, "灵石不够，再陪伴一会儿吧");
      input(
        p.kind === "food"
          ? (s.inventory.food.find((x) => x.itemId === p.id)?.quantity ?? 0) +
              c.quantity <=
              9999
          : s.inventory.items.length + c.quantity <= 2000,
        "背包中的同类物品太多了",
      );
      s.stones -= p.price * c.quantity;
      addItem(s, p.id, c.quantity, id);
      record(
        s,
        id,
        now,
        `购买 ${p.name} × ${c.quantity}`,
        -p.price * c.quantity,
      );
      break;
    }
    case "feed":
      eat(s, c.itemId, now, id, true, true);
      record(s, id, now, `喂食 ${lifeProduct(c.itemId)!.name}`);
      break;
    case "autofeed": {
      input(typeof c.enabled === "boolean");
      const stack = s.inventory.food.find((x) => x.itemId === c.itemId);
      input(stack, "背包中没有这种食物");
      stack.autoFeed = c.enabled;
      break;
    }
    case "play": {
      if (c.instanceId !== undefined)
        input(
          s.inventory.items.some(
            (x) =>
              x.instanceId === c.instanceId &&
              lifeProduct(x.itemId)?.kind === "toy",
          ),
          "没有这件玩具",
        );
      s.presentation = { action: "play", until: now + 5500 };
      if (!s.lastPlayAt || now - s.lastPlayAt >= 30 * MINUTE) {
        s.needs.joy = clamp(s.needs.joy + 20);
        s.lastPlayAt = now;
        dailyCare(s, "play", now, id, true);
      }
      break;
    }
    case "sleep":
      input(typeof c.sleeping === "boolean");
      s.needs.sleeping = c.sleeping;
      s.presentation = {
        action: c.sleeping ? "sleep" : "recover",
        until: now + 2500,
      };
      break;
    case "room.save":
      input(
        validInteger(c.expectedRoomRevision, 0, Number.MAX_SAFE_INTEGER) &&
          c.expectedRoomRevision === s.room.revision,
        "房间已在另一处改变，请重新载入后布置",
        "CONFLICT",
      );
      validatePlacements(s, c.placements);
      s.room.placements = structuredClone(c.placements);
      s.room.revision++;
      break;
    default:
      input(false, "未知的养成操作");
  }
  delete s.summary;
  s.receipts[c.requestId] = fingerprint;
  updateWeakness(s);
  return true;
}
export function awardChat(
  s: LifeStore,
  event: { id: string; text: string; at: number },
  id: IdFactory,
): boolean {
  if (!event.id || !event.text.trim() || s.rewardedTurns.includes(event.id))
    return false;
  // 只保存短指纹用于短期重复判断，不把聊天原文复制到养成存档。
  let h = 2166136261;
  for (const char of event.text.trim().replace(/\s+/g, " ")) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const hash = (h >>> 0).toString(16);
  s.rewardedTurns.push(event.id); // 已处理事件永久去重，包括未达到计奖间隔的轮次。
  s.recentChat = s.recentChat.filter((x) => event.at - x.at < 10 * MINUTE);
  if (
    s.daily.chatRewards >= 10 ||
    (s.lastChatAt && event.at - s.lastChatAt < MINUTE) ||
    s.recentChat.some((x) => x.hash === hash)
  )
    return false;
  s.lastChatAt = event.at;
  s.recentChat.push({ hash, at: event.at });
  s.daily.chatRewards++;
  s.stones = Math.min(MAX_STONES, s.stones + 2);
  record(s, id, event.at, "聊天陪伴", 2);
  addXp(s, 2, event.at, id, "聊天成长");
  return true;
}
/** 已有数据损坏时拒绝写入，不能静默重置钱包或覆盖存档。 */
export function validateLifeStore(value: unknown): asserts value is LifeStore {
  input(value && typeof value === "object", "养成存档无法读取");
  const s = value as LifeStore;
  input(s.schemaVersion === 1, "养成存档版本不受支持");
  input(
    typeof s.profileId === "string" &&
      s.profileId.length > 0 &&
      typeof s.timezone === "string",
  );
  dayKey(Date.now(), s.timezone);
  input(
    validInteger(s.revision, 0, Number.MAX_SAFE_INTEGER) &&
      validNumber(s.lastAt, 0, 8e15),
  );
  input(
    validInteger(s.stones, 0, MAX_STONES) &&
      validInteger(s.totalXp, 0, Number.MAX_SAFE_INTEGER),
  );
  input(
    validInteger(s.rewardedLevel, 1, 20) &&
      s.rewardedLevel === growth(s.totalXp).level,
  );
  input(
    s.needs &&
      [s.needs.fullness, s.needs.energy, s.needs.joy].every((x) =>
        validNumber(x, 0, 100),
      ) &&
      validNumber(s.needs.hungerHours, 0, 72) &&
      typeof s.needs.sleeping === "boolean",
  );
  input(
    s.inventory &&
      Array.isArray(s.inventory.food) &&
      Array.isArray(s.inventory.items),
  );
  input(s.inventory.food.length <= 4 && s.inventory.items.length <= 2020);
  const foodIds = new Set<string>(),
    itemIds = new Set<string>();
  for (const f of s.inventory.food) {
    input(
      f &&
        lifeProduct(f.itemId)?.kind === "food" &&
        !foodIds.has(f.itemId) &&
        validInteger(f.quantity, 0, 10020) &&
        typeof f.autoFeed === "boolean",
    );
    foodIds.add(f.itemId);
  }
  for (const i of s.inventory.items) {
    input(
      i &&
        typeof i.instanceId === "string" &&
        !itemIds.has(i.instanceId) &&
        lifeProduct(i.itemId)?.kind !== "food" &&
        lifeProduct(i.itemId),
    );
    itemIds.add(i.instanceId);
  }
  input(
    s.room &&
      s.room.width === 1000 &&
      s.room.height === 700 &&
      validInteger(s.room.revision, 0, Number.MAX_SAFE_INTEGER),
  );
  validatePlacements(s, s.room.placements);
  input(
    s.daily &&
      typeof s.daily.day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(s.daily.day) &&
      typeof s.daily.checkedIn === "boolean",
  );
  input(
    validNumber(s.daily.onlineMinutes, 0, 1500) &&
      validInteger(s.daily.onlineStones, 0, 48) &&
      validInteger(s.daily.onlineXp, 0, 30) &&
      validInteger(s.daily.chatRewards, 0, 10) &&
      validInteger(s.daily.xp, 0, 90) &&
      validNumber(s.daily.sleepMinutes, 0, 1500),
  );
  input(
    Array.isArray(s.daily.completed) &&
      s.daily.completed.every((x) => ["feed", "sleep", "play"].includes(x)),
  );
  input(new Set(s.daily.completed).size === s.daily.completed.length);
  input(
    s.receipts &&
      typeof s.receipts === "object" &&
      !Array.isArray(s.receipts) &&
      Object.entries(s.receipts).every(
        ([k, v]) => /^[A-Za-z0-9-]{8,100}$/.test(k) && typeof v === "string",
      ),
  );
  input(
    Array.isArray(s.rewardedTurns) &&
      s.rewardedTurns.every((x) => typeof x === "string") &&
      Array.isArray(s.recentChat),
  );
  input(
    s.recentChat.every(
      (x) =>
        x &&
        typeof x.hash === "string" &&
        /^[a-f0-9]{1,8}$/.test(x.hash) &&
        validNumber(x.at, 0, 8e15),
    ),
  );
  input(
    [s.lastChatAt, s.lastPlayAt, s.lastAutoPlayAt].every((x) =>
      validNumber(x, 0, 8e15),
    ) && Array.isArray(s.ledger),
  );
  input(
    s.ledger.length <= 80 &&
      s.ledger.every(
        (x) =>
          x &&
          typeof x.id === "string" &&
          typeof x.label === "string" &&
          x.label.length <= 300 &&
          validNumber(x.at, 0, 8e15) &&
          validInteger(x.stones, -MAX_STONES, MAX_STONES) &&
          validInteger(x.xp, 0, 90),
      ),
  );
  input(
    s.summary === undefined ||
      (typeof s.summary === "string" && s.summary.length <= 1000),
  );
  input(
    s.presentation &&
      [
        "idle",
        "sleep",
        "eat",
        "full",
        "play",
        "drowsy",
        "hungry",
        "weak",
        "dejected",
        "recover",
        "walk",
      ].includes(s.presentation.action) &&
      validNumber(s.presentation.until, 0, 8e15),
  );
  updateWeakness(s);
}
