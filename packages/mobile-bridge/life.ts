import type { LifeSnapshot, LifeProduct } from "../contracts/life.ts";
import type { SpriteRepresentation } from "../contracts/index.ts";
import { MobileBridgeError } from "../mobile-contracts/index.ts";

const fail = (): never => {
  throw new MobileBridgeError(
    "UNAVAILABLE",
    "小窝数据不兼容，请更新应用后重试。",
  );
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown, max = 300): string =>
  typeof v === "string" && v.length <= max ? v : fail();
const num = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? v
    : fail();
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  Number.isSafeInteger(v) ? num(v, min, max) : fail();
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
const one = <T extends string>(v: unknown, values: readonly T[]): T =>
  values.includes(v as T) ? (v as T) : fail();
const list = (v: unknown, max = 2000): unknown[] =>
  Array.isArray(v) && v.length <= max ? v : fail();
const asset = (v: unknown): string =>
  /^assets\/life\/[a-z0-9-]+\.(png|webp)$/.test(text(v))
    ? (v as string)
    : fail();
export const PET_ACTIONS = [
  "idle",
  "greet",
  "happy",
  "think",
  "sleep",
  "drag",
  "walk",
  "eat",
  "full",
  "play",
  "drowsy",
  "hungry",
  "weak",
  "dejected",
  "recover",
] as const;
const LIFE_ACTIONS = [
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
] as const;

/** 白名单投影同时校验数据，不把内部凭据、去重表或额外字段交给 WebView。 */
export function projectLife(value: unknown): LifeSnapshot {
  const s = obj(value),
    n = obj(s.needs),
    presentation = obj(s.presentation),
    wallet = obj(s.wallet),
    g = obj(s.growth),
    d = obj(s.daily),
    inventory = obj(s.inventory),
    room = obj(s.room);
  if (
    s.schemaVersion !== 1 ||
    room.width !== 1000 ||
    room.height !== 700 ||
    g.maxLevel !== 20
  )
    fail();
  const catalog = list(s.catalog, 100).map((value) => {
    const p = obj(value);
    const product: LifeProduct = {
      id: text(p.id, 100),
      name: text(p.name),
      description: text(p.description, 1000),
      kind: one(p.kind, ["food", "toy", "furniture"]),
      price: int(p.price, 0, 1e9),
      unlockLevel: int(p.unlockLevel, 1, 20),
      asset: asset(p.asset),
      purchasable: bool(p.purchasable),
    };
    if (p.setId !== undefined) product.setId = text(p.setId, 100);
    if (p.setName !== undefined) product.setName = text(p.setName);
    if (p.nutrition !== undefined) product.nutrition = num(p.nutrition, 0, 100);
    if (p.defaultAutoFeed !== undefined)
      product.defaultAutoFeed = bool(p.defaultAutoFeed);
    if (p.placement !== undefined) {
      const shape = obj(p.placement);
      product.placement = {
        width: num(shape.width, 1, 1000),
        height: num(shape.height, 1, 700),
        layer: one(shape.layer, ["floor", "rug", "surface"]),
        rotations: list(shape.rotations, 8).map((x) => num(x, 0, 359)),
      };
      if (shape.role !== undefined)
        product.placement.role = one(shape.role, [
          "bed",
          "bowl",
          "seat",
          "table",
          "toy",
          "decoration",
        ] as const);
    }
    if (p.visual !== undefined) {
      const v = obj(p.visual),
        a = obj(v.anchor),
        i = obj(v.interaction);
      product.visual = {
        width: num(v.width, 1, 1000),
        height: num(v.height, 1, 700),
        anchor: { x: num(a.x, 0, 1), y: num(a.y, 0, 1) },
        interaction: { x: num(i.x, 0, 1), y: num(i.y, 0, 1) },
      };
      if (v.foreground !== undefined)
        product.visual.foreground = asset(v.foreground);
    }
    return product;
  });
  return {
    schemaVersion: 1,
    revision: int(s.revision),
    profileId: text(s.profileId, 100),
    needs: {
      fullness: num(n.fullness, 0, 100),
      energy: num(n.energy, 0, 100),
      joy: num(n.joy, 0, 100),
      hungerHours: num(n.hungerHours, 0, 72),
      weakness: int(n.weakness, 0, 3) as 0 | 1 | 2 | 3,
      sleeping: bool(n.sleeping),
    },
    presentation: {
      action: one(presentation.action, LIFE_ACTIONS),
      until: num(presentation.until, 0, 8e15),
    },
    wallet: {
      stones: int(wallet.stones, 0, 1e9),
      ledger: list(wallet.ledger, 80).map((value) => {
        const x = obj(value);
        return {
          id: text(x.id, 100),
          at: num(x.at, 0, 8e15),
          label: text(x.label),
          stones: int(x.stones, -1e9, 1e9),
          xp: int(x.xp, 0, 90),
        };
      }),
    },
    growth: {
      level: int(g.level, 1, 20),
      totalXp: int(g.totalXp),
      levelXp: int(g.levelXp),
      nextLevelXp: int(g.nextLevelXp, 0, 500),
      maxLevel: 20,
    },
    daily: {
      day: text(d.day, 10),
      checkedIn: bool(d.checkedIn),
      onlineMinutes: num(d.onlineMinutes, 0, 1500),
      onlineStones: int(d.onlineStones, 0, 48),
      chatRewards: int(d.chatRewards, 0, 10),
      xp: int(d.xp, 0, 90),
      completed: list(d.completed, 10).map((x) => text(x, 30)),
    },
    inventory: {
      food: list(inventory.food, 4).map((value) => {
        const f = obj(value);
        return {
          itemId: text(f.itemId, 100),
          quantity: int(f.quantity, 0, 10020),
          autoFeed: bool(f.autoFeed),
        };
      }),
      items: list(inventory.items, 2020).map((value) => {
        const i = obj(value);
        return {
          instanceId: text(i.instanceId, 100),
          itemId: text(i.itemId, 100),
        };
      }),
    },
    room: {
      revision: int(room.revision),
      width: 1000,
      height: 700,
      placements: list(room.placements, 200).map((value) => {
        const p = obj(value);
        return {
          instanceId: text(p.instanceId, 100),
          x: num(p.x, 0, 1000),
          y: num(p.y, 0, 700),
          rotation: num(p.rotation, 0, 359),
        };
      }),
    },
    catalog,
    ...(s.summary !== undefined ? { summary: text(s.summary, 1000) } : {}),
  };
}
export function validLife(v: unknown): boolean {
  try {
    projectLife(v);
    return true;
  } catch {
    return false;
  }
}

export function projectAnimation(
  value: unknown,
  characterId: string,
): SpriteRepresentation {
  const v = obj(value),
    frames: Record<string, string[]> = {},
    timings: Record<string, number[]> = {},
    loops: Record<string, boolean> = {};
  const fps = num(v.fps, 1, 30),
    raw = obj(v.frames);
  for (const [action, paths] of Object.entries(raw)) {
    one(action, PET_ACTIONS);
    frames[action] = list(paths, 60).map((path) => {
      const p = text(path, 200);
      if (
        !p.startsWith(`./characters/${characterId}/`) ||
        !/^\.\/characters\/[a-z]+\/[a-z0-9-]+\.(svg|png|webp)$/.test(p)
      )
        fail();
      return p;
    });
    if (!frames[action].length) fail();
    if (v.timings !== undefined && obj(v.timings)[action] !== undefined) {
      timings[action] = list(obj(v.timings)[action], 60).map((ms) =>
        num(ms, 33, 10000),
      );
      if (timings[action].length !== frames[action].length) fail();
    }
    if (v.loops !== undefined && obj(v.loops)[action] !== undefined)
      loops[action] = bool(obj(v.loops)[action]);
  }
  if (!frames.idle?.length) fail();
  const result: SpriteRepresentation = { fps, frames, timings, loops };
  if (v.size !== undefined) {
    const s = obj(v.size);
    result.size = {
      width: num(s.width, 1, 1024),
      height: num(s.height, 1, 1024),
    };
  }
  if (v.anchor !== undefined) {
    const a = obj(v.anchor);
    result.anchor = { x: num(a.x, 0, 1), y: num(a.y, 0, 1) };
  }
  return result;
}
export function validAnimation(v: unknown, id: string): boolean {
  try {
    projectAnimation(v, id);
    return true;
  } catch {
    return false;
  }
}
