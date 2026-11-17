/** 养成公共契约；只包含可序列化数据，不绑定宿主或渲染技术。 */
export type LifeAction =
  | "idle"
  | "sleep"
  | "eat"
  | "full"
  | "play"
  | "drowsy"
  | "hungry"
  | "weak"
  | "dejected"
  | "recover"
  | "walk";
export type LifeItemKind = "food" | "toy" | "furniture";
export interface LifeProduct {
  id: string;
  name: string;
  description: string;
  kind: LifeItemKind;
  setId?: string;
  setName?: string;
  price: number;
  unlockLevel: number;
  /** 相对产品资源根目录的路径，两端由 UI 解析资源根目录。 */
  asset: string;
  /** 图片绘制尺寸与地面占地分开，避免把正方形透明素材压扁。 */
  visual?: {
    width: number;
    height: number;
    anchor: { x: number; y: number };
    interaction: { x: number; y: number };
    foreground?: string;
  };
  nutrition?: number;
  defaultAutoFeed?: boolean;
  purchasable: boolean;
  placement?: {
    width: number;
    height: number;
    layer: "floor" | "rug" | "surface";
    rotations: number[];
    role?: "bed" | "bowl" | "seat" | "table" | "toy" | "decoration";
  };
}
export interface LifePlacement {
  instanceId: string;
  x: number;
  y: number;
  rotation: number;
}
export interface LifeLedgerEntry {
  id: string;
  at: number;
  label: string;
  stones: number;
  xp: number;
}
export interface LifeSnapshot {
  schemaVersion: 1;
  revision: number;
  profileId: string;
  needs: {
    fullness: number;
    energy: number;
    joy: number;
    hungerHours: number;
    weakness: 0 | 1 | 2 | 3;
    sleeping: boolean;
  };
  presentation: { action: LifeAction; until: number };
  wallet: { stones: number; ledger: LifeLedgerEntry[] };
  growth: {
    level: number;
    totalXp: number;
    levelXp: number;
    nextLevelXp: number;
    maxLevel: number;
  };
  daily: {
    day: string;
    checkedIn: boolean;
    onlineMinutes: number;
    onlineStones: number;
    chatRewards: number;
    xp: number;
    completed: string[];
  };
  inventory: {
    food: { itemId: string; quantity: number; autoFeed: boolean }[];
    items: { instanceId: string; itemId: string }[];
  };
  room: {
    revision: number;
    width: number;
    height: number;
    placements: LifePlacement[];
  };
  catalog: LifeProduct[];
  /** 离线补算摘要，只展示已提交的真实变化。 */
  summary?: string;
}
export type LifeCommand = { requestId: string } & (
  | { kind: "checkin" }
  | { kind: "buy"; itemId: string; quantity: number }
  | { kind: "feed"; itemId: string }
  | { kind: "autofeed"; itemId: string; enabled: boolean }
  | { kind: "play"; instanceId?: string }
  | { kind: "sleep"; sleeping: boolean }
  | {
      kind: "room.save";
      placements: LifePlacement[];
      expectedRoomRevision: number;
    }
);
export interface LifeCommands {
  "life.get": { params: undefined; result: LifeSnapshot };
  "life.act": { params: LifeCommand; result: LifeSnapshot };
}
export const lifeCommands = ["life.get", "life.act"] as const;
export interface PetLifeService {
  snapshot(): LifeSnapshot;
  act(command: unknown): Promise<LifeSnapshot>;
  /** 平台所有者提供是否可计入在线陪伴，页面可见性不决定业务时间。 */
  advance(now?: number, online?: boolean): Promise<void>;
}
declare module "../kernel/index.ts" {
  interface Services {
    "pet.life": PetLifeService;
  }
}
