/* 灵伴 2.0 小窝：房间、需求、背包、商店、成长与布置。
   只通过 life.get / life.act 读写；页面只保存布置草稿、筛选和数量输入，不持有第二份业务权威。
   骨架只建一次，快照到达后按 key 更新节点，输入、选择和焦点不会因轮询丢失。 */
import type {
  LifeCommand,
  LifeItemKind,
  LifeLedgerEntry,
  LifePlacement,
  LifeProduct,
  LifeSnapshot,
} from '../../../packages/contracts/life.ts';
import type { SpriteRepresentation } from '../../../packages/contracts/index.ts';

/** 宿主提供的两条命令；结果先做结构校验再使用，所以这里按 unknown 接收。 */
export interface LifeHost {
  /** life.get */
  get(): Promise<unknown>;
  /** life.act */
  act(command: LifeCommand): Promise<unknown>;
  /** 产品资源根目录，Android 为 './'。 */
  assetRoot: string;
  /** 普通模式点宠物：打开聊天。 */
  onPetClick(): void;
  /** 小窝能否读取；不可用时宿主可显示原来的角色小窗。 */
  onAvailability?(available: boolean): void;
  /** 桌面宿主的错误信息已面向用户，可直接显示；移动端只按错误码映射。 */
  showRawErrors?: boolean;
}
export interface LifeCharacter {
  id: string;
  name: string;
  /** 静态回退图（可能是 webp）；没有 animation 或帧全部失败时显示。 */
  image: string;
  /** 角色完整动画：各动作真实帧地址、每帧毫秒与是否循环。 */
  animation?: SpriteRepresentation;
}

type Panel = 'room' | 'bag' | 'shop' | 'growth';
type BagTab = 'food' | 'toy' | 'furniture' | 'wallet';
type ShopKind = 'all' | LifeItemKind;
type Tone = 'ok' | 'bad' | 'busy' | 'info';
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type CommandBody = DistributiveOmit<LifeCommand, 'requestId'>;
type Box = { w: number; h: number; layer: 'floor' | 'rug' | 'surface'; role: string; rotations: number[] };
/** 图片画布尺寸（房间单位）、归一化锚点与交互点、可选前景文件。 */
type Visual = { w: number; h: number; ax: number; ay: number; ix: number; iy: number; fg: string | null };
type SpriteFrame = { url: string; ms: number };
type SpriteAction = { frames: SpriteFrame[]; loop: boolean };
type Sprite = { actions: Map<string, SpriteAction>; aspect: number; ax: number; ay: number };
type PetSpot = { x: number; y: number; z: number };

interface Op {
  label: string;
  command: LifeCommand;
  done: (s: LifeSnapshot) => string;
  state: 'sending' | 'failed';
}
interface EditState {
  /** 进入编辑时的 room.revision，保存时原样提交。 */
  base: number;
  draft: LifePlacement[];
  selected: string | null;
  dirty: boolean;
}
interface DragState {
  id: string;
  pointerId: number;
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  kx: number;
  ky: number;
  moved: boolean;
}
interface RoomEntry {
  instanceId: string;
  x: number;
  y: number;
  rotation: number;
  product: LifeProduct | undefined;
}

const POLL_MS = 5000;
const STEP = 20;
/** 宠物在 1000×700 房间里的绘制高度；宽度按动画素材比例。 */
const PET_H = 170;
/** 表现层步行速度（房间单位/秒），只影响画面，不写业务状态。 */
const WALK_SPEED = 260;
/** 地面最靠里的合法落点，与核心校验一致。 */
const MIN_FLOOR_Y = 250;
/** 短暂动作；presentation.until 过期后不再停留在这些动作上。 */
const TRANSIENT = new Set(['eat', 'full', 'play', 'recover', 'greet', 'happy', 'walk', 'drag', 'think']);
/** 旧角色包没有新增动作时按语义降级到已有动作，最后回到待机。 */
const LEGACY: Record<string, string> = {
  eat: 'happy',
  full: 'happy',
  play: 'happy',
  drowsy: 'sleep',
  hungry: 'idle',
  weak: 'sleep',
  dejected: 'sleep',
  recover: 'greet',
  walk: 'idle',
};
const KIND_LABEL: Record<LifeItemKind, string> = { food: '食物', toy: '玩具', furniture: '家具' };
/** 固定展示的日常；其它已完成的日常 ID 由快照带来时追加显示。 */
const DAILY_ROWS = ['checkin', 'feed', 'sleep', 'play'];
const DAILY_LABEL: Record<string, string> = {
  checkin: '每日签到',
  feed: '有效进食',
  sleep: '充分休息',
  play: '一起玩耍',
  chat: '聊天陪伴',
  online: '在线成长',
};
const WEAKNESS: Record<number, string> = {
  1: '它有点没精神，眼睛半睁着。',
  2: '它很虚弱，动作都慢下来了。',
  3: '它已经饿得有些颓废了。',
};
const CODE_TEXT: Record<string, string> = {
  UNAVAILABLE: '暂未收到结果，可能还没完成，也可能已经完成。',
  BUSY: '它还在处理上一件事，稍后再试。',
  INVALID_INPUT: '这项操作现在不能进行，可能是余额不足、尚未解锁或物品已经变化。',
  NOT_FOUND: '找不到这件物品了，可能已经用掉或收回。',
  CONFLICT: '状态已在别处更新。',
  STORAGE: '保存时出了问题，请稍后再试。',
  LIMIT: '数量超出上限。',
  SHAPE: '小窝返回的数据暂时无法识别。',
};
const RETRYABLE = new Set(['', 'UNAVAILABLE', 'BUSY', 'STORAGE', 'SHAPE']);

/* ---------- 小工具 ---------- */

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function btn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
function show(el: HTMLElement, visible: boolean): void {
  if (el.hidden === visible) el.hidden = !visible;
}
function setDisabled(el: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, disabled: boolean): void {
  if (el.disabled !== disabled) el.disabled = disabled;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function num(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}
/** 取整后仍落在 [lo, hi] 内，避免 937.5 这类边界被四舍五入到界外。 */
function clampInt(v: number, lo: number, hi: number): number {
  const a = Math.ceil(lo);
  const b = Math.floor(hi);
  return a > b ? Math.round((lo + hi) / 2) : Math.min(b, Math.max(a, Math.round(v)));
}
/** 服务端同样校验；这里只让步进器不提供无效数量。 */
function maxQty(p: LifeProduct | undefined): number {
  return p?.kind === 'food' ? 99 : 20;
}
function pct(v: number): string {
  return `${(v * 100).toFixed(3)}%`;
}
function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function newRequestId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function errorCode(e: unknown): string {
  return isObj(e) && typeof e.code === 'string' ? e.code : '';
}
function when(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

class LifeShapeError extends Error {
  readonly code = 'SHAPE';
}
/** 只做结构校验，防止旧宿主或未接线的桥返回空值时渲染崩溃。 */
function parseSnapshot(v: unknown): LifeSnapshot {
  if (
    !isObj(v) ||
    v.schemaVersion !== 1 ||
    typeof v.revision !== 'number' ||
    !isObj(v.needs) ||
    !isObj(v.presentation) ||
    !isObj(v.wallet) ||
    !Array.isArray(v.wallet.ledger) ||
    !isObj(v.growth) ||
    !isObj(v.daily) ||
    !Array.isArray(v.daily.completed) ||
    !isObj(v.inventory) ||
    !Array.isArray(v.inventory.food) ||
    !Array.isArray(v.inventory.items) ||
    !isObj(v.room) ||
    !Array.isArray(v.room.placements) ||
    !Array.isArray(v.catalog)
  )
    throw new LifeShapeError('life snapshot shape');
  return v as unknown as LifeSnapshot;
}

/** 产品资源只接受 assets/life/ 下的相对 png/webp 路径，其它一律走文字轮廓占位。 */
function assetUrl(root: string, asset: unknown, rotation?: number, base?: number): string | null {
  if (typeof asset !== 'string') return null;
  const a = asset.trim();
  if (!/^assets\/life\/[A-Za-z0-9_\-/]+\.(png|webp)$/.test(a) || a.includes('..') || a.includes('//')) return null;
  const path = rotation !== undefined && rotation !== base ? a.replace(/\.(png|webp)$/, `-r${rotation}.$1`) : a;
  return root + path;
}
function makeArt(cls = ''): HTMLElement {
  const el = h('span', `life-art ${cls}`.trim());
  el.setAttribute('aria-hidden', 'true');
  return el;
}
/** 图片失败先试 fallback（未旋转的素材），再换成简洁文字轮廓；不使用 emoji 充当资产。 */
function setArt(el: HTMLElement, url: string | null, name: string, fallbackUrl: string | null = null): void {
  const key = `${url ?? ''}|${fallbackUrl ?? ''}|${name}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const outline = () => h('span', 'life-art-fallback', name || '物品');
  if (!url) {
    el.replaceChildren(outline());
    return;
  }
  const img = h('img');
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.addEventListener('error', () => {
    if (el.dataset.key !== key) return;
    if (fallbackUrl && img.getAttribute('src') !== fallbackUrl) img.setAttribute('src', fallbackUrl);
    else el.replaceChildren(outline());
  });
  img.setAttribute('src', url);
  el.replaceChildren(img);
}
/** 按 key 复用节点：已有节点只更新，不重建。 */
function reconcile<T>(
  container: HTMLElement,
  items: readonly T[],
  key: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (el: HTMLElement, item: T) => void,
  cache: Map<string, HTMLElement>,
): void {
  const seen = new Set<string>();
  let prev: HTMLElement | null = null;
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    let el = cache.get(k);
    if (!el) {
      el = create(item);
      cache.set(k, el);
    }
    update(el, item);
    const expected: ChildNode | null = prev ? prev.nextSibling : container.firstChild;
    if (el !== expected) container.insertBefore(el, expected);
    prev = el;
  }
  for (const [k, el] of cache) {
    if (!seen.has(k)) {
      el.remove();
      cache.delete(k);
    }
  }
}
function boxOf(p: LifeProduct | undefined): Box {
  const pl = p?.placement;
  const rotations = pl && Array.isArray(pl.rotations) ? pl.rotations.filter((r) => typeof r === 'number' && Number.isFinite(r)) : [];
  return {
    w: Math.max(10, num(pl?.width, 100)),
    h: Math.max(10, num(pl?.height, 100)),
    layer: pl?.layer === 'rug' || pl?.layer === 'surface' ? pl.layer : 'floor',
    role: pl?.role ?? 'decoration',
    rotations: rotations.length ? rotations : [0],
  };
}
function zOf(layer: Box['layer'], y: number): number {
  // 地毯在最下层；普通家具和角色按落地点前后排序；桌面物件压在同一落点的桌子之上。
  return layer === 'rug' ? 1 + Math.round(y) : 1000 + Math.round(y) + (layer === 'surface' ? 40 : 0);
}
/** 产品图片画布尺寸与锚点；旧目录没有 visual 时按占地绘制，保持原行为。 */
function visualOf(p: LifeProduct | undefined): Visual {
  const v: unknown = p?.visual;
  if (isObj(v) && num(v.width) > 0 && num(v.height) > 0) {
    const a: Record<string, unknown> = isObj(v.anchor) ? v.anchor : {};
    const i: Record<string, unknown> = isObj(v.interaction) ? v.interaction : {};
    return {
      w: num(v.width),
      h: num(v.height),
      ax: clamp(num(a.x, 0.5), 0, 1),
      ay: clamp(num(a.y, 1), 0, 1),
      ix: clamp(num(i.x, 0.5), 0, 1),
      iy: clamp(num(i.y, 0.7), 0, 1),
      fg: typeof v.foreground === 'string' && v.foreground.trim() ? v.foreground.trim() : null,
    };
  }
  const box = boxOf(p);
  return { w: box.w, h: box.h, ax: 0.5, ay: 1, ix: 0.5, iy: 0.6, fg: null };
}
/** 与核心一致的合法落点：x 两侧取占地与图片宽度一半的较大值，y 不低于墙脚、占地深度和锚点以上的图片高度。 */
function limitsOf(p: LifeProduct | undefined, W: number, H: number): { x0: number; x1: number; y0: number; y1: number } {
  const box = boxOf(p);
  const v = visualOf(p);
  const hx = Math.max(box.w / 2, v.w / 2);
  return { x0: hx, x1: W - hx, y0: Math.max(MIN_FLOOR_Y, box.h, v.h * v.ay), y1: H };
}
/** 前景层与主图同尺寸同位置；可写成 assets/life/ 相对路径，或与主图同目录的文件名。 */
function foregroundUrl(root: string, p: LifeProduct | undefined, fg: string | null): string | null {
  if (!fg) return null;
  if (fg.startsWith('assets/')) return assetUrl(root, fg);
  if (!/^[A-Za-z0-9_-]+\.(png|webp)$/.test(fg) || typeof p?.asset !== 'string') return null;
  return assetUrl(root, p.asset.trim().replace(/[^/]*$/, '') + fg);
}
/** 帧地址来自宿主角色加载器；只经 img src 使用，拒绝脚本协议。 */
function frameUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s && !/^(javascript|vbscript):/i.test(s) ? s : '';
}
/** 把 SpriteRepresentation 规整成可播放的动作表；缺少 animation 或没有可用帧时返回 null。 */
function spriteOf(anim: unknown): Sprite | null {
  if (!isObj(anim) || !isObj(anim.frames)) return null;
  const fps = num(anim.fps) > 0 ? num(anim.fps) : 8;
  const timingsOf: Record<string, unknown> = isObj(anim.timings) ? anim.timings : {};
  const loops: Record<string, unknown> = isObj(anim.loops) ? anim.loops : {};
  const actions = new Map<string, SpriteAction>();
  for (const [action, list] of Object.entries(anim.frames)) {
    if (!Array.isArray(list)) continue;
    const t = timingsOf[action];
    const timings: unknown[] = Array.isArray(t) ? t : [];
    const frames: SpriteFrame[] = [];
    list.forEach((u: unknown, i: number) => {
      const url = frameUrl(u);
      if (url) frames.push({ url, ms: Math.round(clamp(num(timings[i], 1000 / fps), 40, 10000)) });
    });
    if (frames.length) actions.set(action, { frames, loop: loops[action] !== false });
  }
  if (!actions.size) return null;
  const size = isObj(anim.size) && num(anim.size.width) > 0 && num(anim.size.height) > 0 ? { w: num(anim.size.width), h: num(anim.size.height) } : null;
  let ax = 0.5;
  let ay = 1;
  if (isObj(anim.anchor)) {
    ax = num(anim.anchor.x, ax);
    ay = num(anim.anchor.y, ay);
    // 锚点可能是像素坐标，按素材尺寸归一化。
    if (size && (ax > 1 || ay > 1)) {
      ax /= size.w;
      ay /= size.h;
    }
  }
  return { actions, aspect: size ? size.w / size.h : 150 / 170, ax: clamp(ax, 0, 1), ay: clamp(ay, 0, 1) };
}

/* ---------- 组件 ---------- */

export class LifeView {
  readonly root: HTMLElement;
  private readonly host: LifeHost;
  private snap: LifeSnapshot | null = null;
  private products = new Map<string, LifeProduct>();
  private instanceItem = new Map<string, string>();
  private available: boolean | null = null;
  private loadError = '';
  private active = false;
  private disposed = false;
  private polling = false;
  private pollTimer = 0;
  private untilTimer = 0;
  private frameTimer = 0;
  private walkTimer = 0;
  private op: Op | null = null;
  private panel: Panel = 'room';
  private bagTab: BagTab = 'food';
  private shopKind: ShopKind = 'all';
  private shopSet = '';
  private readonly qty = new Map<string, number>();
  private edit: EditState | null = null;
  private drag: DragState | null = null;
  private dragRaf = 0;
  private suppressClick = false;
  private character: LifeCharacter | null = null;
  private characterSig = '';
  private sprite: Sprite | null = null;
  private playKey: string | null = null;
  private playIndex = 0;
  private frameSlot = '';
  private readonly preloaded = new Map<string, HTMLImageElement>();
  private readonly failedFrames = new Set<string>();
  private petPos: { x: number; y: number } | null = null;
  private walking = false;
  private summarySeen = '';
  private levelNote = '';
  private readonly cleanups: Array<() => void> = [];
  private readonly caches = {
    items: new Map<string, HTMLElement>(),
    fg: new Map<string, HTMLElement>(),
    food: new Map<string, HTMLElement>(),
    toy: new Map<string, HTMLElement>(),
    furniture: new Map<string, HTMLElement>(),
    shop: new Map<string, HTMLElement>(),
    ledger: new Map<string, HTMLElement>(),
    growthLedger: new Map<string, HTMLElement>(),
    tray: new Map<string, HTMLElement>(),
    unlocks: new Map<string, HTMLElement>(),
    daily: new Map<string, HTMLElement>(),
  };

  /* 骨架引用 */
  private feedback!: HTMLElement;
  private feedbackText!: HTMLElement;
  private retryBtn!: HTMLButtonElement;
  private dismissBtn!: HTMLButtonElement;
  private loading!: HTMLElement;
  private unavailable!: HTMLElement;
  private unavailableText!: HTMLElement;
  private unavailableRetry!: HTMLButtonElement;
  private body!: HTMLElement;
  private staleNote!: HTMLElement;
  private stones!: HTMLElement;
  private checkin!: HTMLButtonElement;
  private levelLabel!: HTMLElement;
  private levelXp!: HTMLElement;
  private levelBar!: HTMLElement;
  private levelFill!: HTMLElement;
  private summaryNote!: HTMLElement;
  private summaryText!: HTMLElement;
  private levelUpNote!: HTMLElement;
  private levelUpText!: HTMLElement;
  private tabs!: Record<Panel, HTMLButtonElement>;
  private panels!: Record<Panel, HTMLElement>;

  private room!: HTMLElement;
  private itemsLayer!: HTMLElement;
  private fgLayer!: HTMLElement;
  private pet!: HTMLButtonElement;
  private petImg!: HTMLImageElement;
  private roomTag!: HTMLElement;
  private editBar!: HTMLElement;
  private editTitle!: HTMLElement;
  private editSelected!: HTMLElement;
  private editSelectedName!: HTMLElement;
  private rotateBtn!: HTMLButtonElement;
  private moveBtns!: HTMLButtonElement[];
  private takeBackBtn!: HTMLButtonElement;
  private tray!: HTMLElement;
  private trayEmpty!: HTMLElement;
  private conflictNote!: HTMLElement;
  private editNote!: HTMLElement;
  private saveBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private weakNote!: HTMLElement;
  private weakText!: HTMLElement;
  private foodNote!: HTMLElement;
  private foodText!: HTMLElement;
  private foodNoteBtn!: HTMLButtonElement;
  private needs!: Record<'fullness' | 'energy' | 'joy', { row: HTMLElement; bar: HTMLElement; fill: HTMLElement; text: HTMLElement }>;
  private actionBtns!: { feed: HTMLButtonElement; play: HTMLButtonElement; rest: HTMLButtonElement; edit: HTMLButtonElement };

  private bagTabs!: Record<BagTab, HTMLButtonElement>;
  private bagLists!: Record<BagTab, HTMLElement>;
  private bagEmpty!: Record<Exclude<BagTab, 'wallet'>, HTMLElement>;
  private walletStones!: HTMLElement;
  private walletToday!: HTMLElement;
  private ledgerList!: HTMLElement;
  private ledgerEmpty!: HTMLElement;

  private shopKinds!: Record<ShopKind, HTMLButtonElement>;
  private shopSetSelect!: HTMLSelectElement;
  private shopSetSig = '';
  private shopGrid!: HTMLElement;
  private shopEmpty!: HTMLElement;

  private growthLevel!: HTMLElement;
  private growthXp!: HTMLElement;
  private growthBar!: HTMLElement;
  private growthFill!: HTMLElement;
  private growthToday!: HTMLElement;
  private dailyList!: HTMLElement;
  private unlockTitle!: HTMLElement;
  private unlockList!: HTMLElement;
  private growthLedger!: HTMLElement;
  private growthLedgerEmpty!: HTMLElement;

  constructor(host: LifeHost) {
    this.host = host;
    this.root = h('section', 'life');
    this.root.setAttribute('aria-label', '小窝');
    this.root.dataset.state = 'loading';
    this.build();
    this.listen(document, 'visibilitychange', () => this.onVisibility());
    if (typeof matchMedia === 'function') this.listen(matchMedia('(prefers-reduced-motion: reduce)'), 'change', () => this.renderPet());
  }

  /* ---------- 生命周期 ---------- */

  /** 页面可见时开始读取与绘制；隐藏时暂停轮询、动作计时和角色帧，编辑草稿保留。 */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      void this.poll();
      this.renderPet();
    } else {
      this.stopTimers();
      this.endDrag();
    }
  }

  /** 角色随每次快照传入；只有内容真的变化才重置播放，轮询不会把动作打回第一帧。 */
  setCharacter(c: LifeCharacter | null): void {
    if (this.disposed) return;
    const sig = c ? JSON.stringify([c.id, c.name, c.image, c.animation?.frames ?? null, c.animation?.timings ?? null, c.animation?.loops ?? null]) : '';
    if (sig === this.characterSig) return;
    const sameArt =
      c && this.character && c.id === this.character.id && c.image === this.character.image && JSON.stringify(c.animation ?? null) === JSON.stringify(this.character.animation ?? null);
    this.characterSig = sig;
    this.character = c ? { id: c.id, name: c.name, image: frameUrl(c.image), animation: c.animation } : null;
    if (!sameArt) {
      this.sprite = spriteOf(c?.animation);
      this.failedFrames.clear();
      this.preloaded.clear();
      window.clearTimeout(this.frameTimer);
      this.frameTimer = 0;
      this.playKey = null;
      this.playIndex = 0;
    }
    this.renderPet();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.stopTimers();
    if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
    this.dragRaf = 0;
    this.drag = null;
    this.preloaded.clear();
    for (const fn of this.cleanups.splice(0)) fn();
    this.root.remove();
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.cleanups.push(() => target.removeEventListener(type, fn));
  }

  private stopTimers(): void {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = 0;
    window.clearTimeout(this.untilTimer);
    this.untilTimer = 0;
    window.clearTimeout(this.frameTimer);
    this.frameTimer = 0;
    this.stopWalk();
  }

  private stopWalk(): void {
    window.clearTimeout(this.walkTimer);
    this.walkTimer = 0;
    this.walking = false;
    if (this.pet) this.pet.style.transition = '';
  }

  private onVisibility(): void {
    if (!this.active || this.disposed) return;
    if (document.hidden) this.stopTimers();
    else {
      void this.poll();
      this.renderPet();
    }
  }

  /** 动作到期后立即重新读取真实状态，不让画面停在进食等短暂动作上。 */
  private scheduleUntil(): void {
    window.clearTimeout(this.untilTimer);
    this.untilTimer = 0;
    const s = this.snap;
    if (!s || !this.active || document.hidden || this.disposed) return;
    const wait = num(s.presentation.until) - Date.now();
    // 已过期的由本地降级显示并随常规轮询对齐，避免对同一过期快照反复请求。
    if (wait <= 0 || wait > 10 * 60 * 1000) return;
    this.untilTimer = window.setTimeout(() => {
      this.untilTimer = 0;
      this.renderPet();
      void this.poll();
    }, wait + 150);
  }

  /* ---------- 读取与命令 ---------- */

  private schedulePoll(): void {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = 0;
    if (!this.active || this.disposed || document.hidden) return;
    // 读不到时放慢重试，避免不可用的宿主被反复请求。
    this.pollTimer = window.setTimeout(() => void this.poll(), this.snap ? POLL_MS : POLL_MS * 3);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    window.clearTimeout(this.pollTimer);
    try {
      const s = parseSnapshot(await this.host.get());
      if (this.disposed) return;
      this.loadError = '';
      this.accept(s);
      this.setAvailable(true);
    } catch (e) {
      if (this.disposed) return;
      const raw = this.host.showRawErrors && e instanceof Error && e.message && errorCode(e) !== 'SHAPE' ? `（${e.message}）` : '';
      this.loadError =
        errorCode(e) === 'SHAPE' ? '当前版本的小窝还没有接入，聊天和设置不受影响。' : `暂时读不到小窝状态${raw}，聊天和设置不受影响。`;
      if (!this.snap) this.setAvailable(false);
      this.render();
    } finally {
      this.polling = false;
      if (!this.disposed) this.schedulePoll();
    }
  }

  private setAvailable(ok: boolean): void {
    if (this.available === ok) return;
    this.available = ok;
    this.host.onAvailability?.(ok);
  }

  private accept(s: LifeSnapshot): void {
    if (this.snap && s.revision < this.snap.revision) return;
    const prev = this.snap;
    this.snap = s;
    this.products = new Map(s.catalog.filter((p) => isObj(p) && typeof p.id === 'string').map((p): [string, LifeProduct] => [p.id, p]));
    this.instanceItem = new Map(
      s.inventory.items.filter((i) => isObj(i) && typeof i.instanceId === 'string').map((i): [string, string] => [i.instanceId, i.itemId]),
    );
    if (prev && num(s.growth.level) > num(prev.growth.level)) {
      const from = num(prev.growth.level);
      const to = num(s.growth.level);
      const unlocked = s.catalog.filter((p) => p.purchasable && p.unlockLevel > from && p.unlockLevel <= to).map((p) => p.name);
      this.levelNote =
        `升到 Lv ${to} 了！` +
        (unlocked.length ? `新解锁可购买：${unlocked.slice(0, 4).join('、')}${unlocked.length > 4 ? ` 等 ${unlocked.length} 件` : ''}。` : '') +
        '升级奖励已直接放进背包，可在成长页的最近流水里查看。';
    }
    this.render();
    this.scheduleUntil();
  }

  private act(label: string, body: CommandBody, done: (s: LifeSnapshot) => string): void {
    if (!this.snap || this.op || this.disposed) return;
    const command = { requestId: newRequestId(), ...body } as LifeCommand;
    this.op = { label, command, done, state: 'sending' };
    void this.send();
  }

  /** 发送当前操作；失败后由用户手动重试，重试沿用同一个 requestId，不自动重放。 */
  private async send(): Promise<void> {
    const op = this.op;
    if (!op) return;
    op.state = 'sending';
    this.setFeedback(`${op.label}…`, 'busy');
    this.render();
    try {
      const s = parseSnapshot(await this.host.act(op.command));
      if (this.disposed || this.op !== op) return;
      this.op = null;
      if (op.command.kind === 'room.save') this.edit = null;
      this.accept(s);
      this.setAvailable(true);
      this.setFeedback(op.done(s), 'ok');
    } catch (e) {
      if (this.disposed || this.op !== op) return;
      const code = errorCode(e);
      if (op.command.kind === 'room.save' && code === 'CONFLICT') {
        this.op = null;
        this.setFeedback('房间已在别处更新，草稿仍保留。可以载入最新布局，或用草稿覆盖保存。', 'bad');
        void this.poll();
      } else if (RETRYABLE.has(code)) {
        op.state = 'failed';
        this.setFeedback(`${op.label}：${this.describe(e, CODE_TEXT[code] ?? CODE_TEXT.UNAVAILABLE)}可以重试同一次操作，或先重新读取看看结果。`, 'bad', true);
      } else {
        this.op = null;
        this.setFeedback(`${op.label}没有完成：${this.describe(e, '请稍后再试。')}`, 'bad');
        void this.poll();
      }
    }
    this.render();
  }

  private retry(): void {
    if (this.op?.state === 'failed') void this.send();
  }

  private dismissOp(): void {
    if (this.op?.state !== 'failed') return;
    this.op = null;
    this.setFeedback('已放弃等待，正在读取最新状态。', 'info');
    this.render();
    void this.poll();
  }

  private describe(e: unknown, fallback: string): string {
    const code = errorCode(e);
    if (code && CODE_TEXT[code]) return CODE_TEXT[code];
    if (this.host.showRawErrors && e instanceof Error && e.message) return e.message;
    return fallback;
  }

  private setFeedback(text: string, tone: Tone, retry = false): void {
    setText(this.feedbackText, text);
    this.feedback.dataset.tone = tone;
    show(this.feedback, Boolean(text));
    show(this.retryBtn, retry);
    show(this.dismissBtn, retry);
  }

  /* ---------- 骨架 ---------- */

  private build(): void {
    this.feedbackText = h('p', 'life-feedback-text');
    this.retryBtn = btn('重试', 'primary life-btn', () => this.retry());
    this.dismissBtn = btn('重新读取', 'quiet life-btn', () => this.dismissOp());
    this.feedback = h('div', 'life-feedback');
    this.feedback.setAttribute('role', 'status');
    this.feedback.setAttribute('aria-live', 'polite');
    this.feedback.hidden = true;
    this.feedback.append(this.feedbackText, this.retryBtn, this.dismissBtn);

    this.loading = h('p', 'life-empty', '正在打开小窝…');
    this.unavailableText = h('p');
    this.unavailableRetry = btn('重新读取', 'quiet life-btn', () => void this.poll());
    this.unavailable = h('div', 'life-note life-unavailable');
    this.unavailable.setAttribute('role', 'status');
    this.unavailable.append(h('b', '', '小窝暂时打不开'), this.unavailableText, this.unavailableRetry);
    this.unavailable.hidden = true;

    this.body = h('div', 'life-body');
    this.body.hidden = true;
    this.body.append(this.buildTop(), this.buildNotes(), this.buildTabs());
    this.panels = {
      room: this.buildRoomPanel(),
      bag: this.buildBagPanel(),
      shop: this.buildShopPanel(),
      growth: this.buildGrowthPanel(),
    };
    for (const p of ['room', 'bag', 'shop', 'growth'] as const) this.body.append(this.panels[p]);
    this.root.append(this.loading, this.unavailable, this.feedback, this.body);
  }

  private buildTop(): HTMLElement {
    this.stones = h('b', '', '—');
    const stoneBox = h('div', 'life-stones');
    stoneBox.append(h('small', '', '灵石'), this.stones);
    this.checkin = btn('签到', 'primary life-btn', () =>
      this.act('签到', { kind: 'checkin' }, () => '签到成功，奖励已经记入钱包。'),
    );
    this.levelLabel = h('b', '', 'Lv —');
    this.levelXp = h('small', '', '');
    this.levelFill = h('span');
    this.levelBar = h('div', 'life-bar');
    this.levelBar.setAttribute('role', 'progressbar');
    this.levelBar.setAttribute('aria-label', '升级进度');
    this.levelBar.setAttribute('aria-valuemin', '0');
    this.levelBar.append(this.levelFill);
    const levelRow = h('div', 'life-level-row');
    levelRow.append(this.levelLabel, this.levelXp);
    const level = h('div', 'life-level');
    level.append(levelRow, this.levelBar);
    this.staleNote = h('p', 'life-stale');
    this.staleNote.hidden = true;
    const top = h('header', 'life-top');
    top.append(stoneBox, this.checkin, level, this.staleNote);
    return top;
  }

  private buildNotes(): HTMLElement {
    this.summaryText = h('p');
    this.summaryNote = h('div', 'life-note');
    this.summaryNote.hidden = true;
    this.summaryNote.append(
      this.summaryText,
      btn('知道了', 'quiet life-btn', () => {
        this.summarySeen = this.snap?.summary ?? '';
        show(this.summaryNote, false);
      }),
    );
    this.levelUpText = h('p');
    this.levelUpNote = h('div', 'life-note life-note-ok');
    this.levelUpNote.setAttribute('role', 'status');
    this.levelUpNote.setAttribute('aria-live', 'polite');
    this.levelUpNote.hidden = true;
    this.levelUpNote.append(
      this.levelUpText,
      btn('看看成长', 'quiet life-btn', () => this.goPanel('growth')),
      btn('知道了', 'quiet life-btn', () => {
        this.levelNote = '';
        this.render();
      }),
    );
    const wrap = h('div', 'life-notes');
    wrap.append(this.summaryNote, this.levelUpNote);
    return wrap;
  }

  private buildTabs(): HTMLElement {
    const nav = h('nav', 'life-tabs');
    nav.setAttribute('aria-label', '小窝分区');
    const tab = (p: Panel, text: string) => {
      const b = btn(text, '', () => this.goPanel(p));
      b.setAttribute('aria-pressed', 'false');
      nav.append(b);
      return b;
    };
    this.tabs = { room: tab('room', '房间'), bag: tab('bag', '背包'), shop: tab('shop', '商店'), growth: tab('growth', '成长') };
    return nav;
  }

  private buildRoomPanel(): HTMLElement {
    const panel = h('div', 'life-panel life-panel-room');
    panel.dataset.panel = 'room';
    this.room = h('div', 'life-room');
    const wall = h('div', 'life-wall');
    const win = h('div', 'life-window');
    const floor = h('div', 'life-floor');
    for (const d of [wall, win, floor]) d.setAttribute('aria-hidden', 'true');
    this.itemsLayer = h('div', 'life-items');
    // 床前景单独一层：与床主图同位置，z 序压在睡觉的宠物之上。
    this.fgLayer = h('div', 'life-items life-fg-layer');
    this.fgLayer.setAttribute('aria-hidden', 'true');
    this.petImg = h('img');
    this.petImg.alt = '';
    this.petImg.draggable = false;
    this.petImg.addEventListener('error', () => {
      const src = this.petImg.dataset.src;
      if (!src || this.failedFrames.has(src)) return;
      this.failedFrames.add(src);
      this.updateFrame();
    });
    this.pet = btn('', 'life-pet', () => {
      if (!this.edit) this.host.onPetClick();
    });
    this.pet.append(this.petImg);
    this.roomTag = h('span', 'life-room-tag');
    this.roomTag.hidden = true;
    this.room.append(wall, win, floor, this.itemsLayer, this.pet, this.fgLayer, this.roomTag);
    this.room.setAttribute('role', 'group');
    this.room.setAttribute('aria-label', '房间');

    const roomCol = h('div', 'life-room-col');
    roomCol.append(this.room, this.buildEditBar());

    this.weakText = h('p');
    this.weakNote = h('div', 'life-note life-note-bad');
    this.weakNote.hidden = true;
    this.weakNote.append(this.weakText);
    this.foodText = h('p');
    this.foodNoteBtn = btn('', 'quiet life-btn', () => {});
    this.foodNote = h('div', 'life-note');
    this.foodNote.hidden = true;
    this.foodNote.append(this.foodText, this.foodNoteBtn);

    const needs = h('div', 'life-needs');
    needs.append(h('h3', 'life-section-title', '状态'));
    const need = (label: string) => {
      const row = h('div', 'life-need');
      const fill = h('span');
      const bar = h('div', 'life-bar');
      bar.setAttribute('role', 'meter');
      bar.setAttribute('aria-label', label);
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.append(fill);
      const text = h('small');
      row.append(h('b', '', label), bar, text);
      needs.append(row);
      return { row, bar, fill, text };
    };
    this.needs = { fullness: need('饱食'), energy: need('精力'), joy: need('心情') };
    this.needs.fullness.row.dataset.need = 'fullness';
    this.needs.energy.row.dataset.need = 'energy';
    this.needs.joy.row.dataset.need = 'joy';

    const actions = h('div', 'life-actions');
    this.actionBtns = {
      feed: btn('喂食', 'primary life-btn', () => this.goBag('food', '选一份食物喂它吧。')),
      play: btn('玩耍', 'quiet life-btn', () => this.act('陪它玩', { kind: 'play' }, () => '陪它玩了一会儿，它很开心。')),
      rest: btn('休息', 'quiet life-btn', () => this.toggleSleep()),
      edit: btn('布置', 'quiet life-btn', () => this.enterEdit()),
    };
    actions.append(this.actionBtns.feed, this.actionBtns.play, this.actionBtns.rest, this.actionBtns.edit);

    const side = h('div', 'life-side-col');
    side.append(this.weakNote, this.foodNote, needs, actions);
    panel.append(roomCol, side);
    return panel;
  }

  private buildEditBar(): HTMLElement {
    this.editTitle = h('h3', 'life-section-title', '布置房间');
    this.editTitle.tabIndex = -1;
    const hint = h('p', 'life-hint', '拖动家具摆放，或选中后用下面的按钮移动。保存后才会生效，取消会恢复进入时的布局。');
    this.editSelectedName = h('b');
    const move = (text: string, label: string, dx: number, dy: number) => {
      const b = btn(text, 'quiet life-btn', () => this.moveSelected(dx, dy));
      b.setAttribute('aria-label', label);
      return b;
    };
    this.moveBtns = [
      move('左移', '向左移动', -STEP, 0),
      move('右移', '向右移动', STEP, 0),
      move('往里', '往房间里面移动', 0, -STEP),
      move('往外', '往房间外侧移动', 0, STEP),
    ];
    this.rotateBtn = btn('转向', 'quiet life-btn', () => this.rotateSelected());
    this.takeBackBtn = btn('收回背包', 'quiet life-btn danger', () => this.takeBackSelected());
    const moves = h('div', 'life-edit-move');
    moves.append(...this.moveBtns, this.rotateBtn, this.takeBackBtn);
    this.editSelected = h('div', 'life-edit-selected');
    this.editSelected.append(this.editSelectedName, moves);
    this.tray = h('div', 'life-tray');
    this.trayEmpty = h('p', 'life-hint', '背包里没有可以放置的家具或玩具了。');
    this.conflictNote = h('div', 'life-note life-note-bad');
    this.conflictNote.hidden = true;
    this.conflictNote.append(
      h('p', '', '房间布局已在别处更新过。你的草稿还在：可以载入最新布局重新摆，或用当前草稿覆盖保存。'),
      btn('载入最新布局', 'quiet life-btn', () => this.reloadEdit()),
      btn('用草稿覆盖保存', 'quiet life-btn', () => this.saveEdit(true)),
    );
    this.editNote = h('p', 'life-hint');
    this.cancelBtn = btn('取消', 'quiet life-btn', () => this.cancelEdit());
    this.saveBtn = btn('保存布置', 'primary life-btn', () => this.saveEdit(false));
    const acts = h('div', 'life-edit-actions');
    acts.append(this.cancelBtn, this.saveBtn);
    this.editBar = h('div', 'life-editbar');
    this.editBar.hidden = true;
    this.editBar.append(this.editTitle, hint, this.editSelected, h('h4', 'life-subtitle', '可以放进房间'), this.tray, this.trayEmpty, this.conflictNote, this.editNote, acts);
    return this.editBar;
  }

  private buildBagPanel(): HTMLElement {
    const panel = h('div', 'life-panel life-panel-bag');
    panel.dataset.panel = 'bag';
    const nav = h('div', 'life-tabs life-subtabs');
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', '背包分类');
    const tab = (t: BagTab, text: string) => {
      const b = btn(text, '', () => {
        this.bagTab = t;
        this.render();
      });
      b.setAttribute('aria-pressed', 'false');
      nav.append(b);
      return b;
    };
    this.bagTabs = { food: tab('food', '食物'), toy: tab('toy', '玩具'), furniture: tab('furniture', '家具'), wallet: tab('wallet', '钱包') };
    const list = () => h('div', 'life-list');
    const empty = (text: string) => {
      const p = h('p', 'life-empty', text);
      p.hidden = true;
      return p;
    };
    this.bagEmpty = {
      food: empty('背包里没有食物。可以去商店买一些，基础口粮便宜又管饱。'),
      toy: empty('还没有玩具。没有玩具也可以直接点“玩耍”陪它。'),
      furniture: empty('还没有家具。去商店看看各个套装吧。'),
    };
    this.walletStones = h('b', 'life-wallet-stones', '—');
    this.walletToday = h('p', 'life-hint');
    this.ledgerList = h('ul', 'life-list life-ledger');
    this.ledgerEmpty = h('p', 'life-empty', '还没有流水记录。');
    const wallet = h('div', 'life-wallet');
    const walletCard = h('div', 'life-stat');
    walletCard.append(h('small', '', '当前灵石'), this.walletStones, this.walletToday);
    wallet.append(walletCard, h('h3', 'life-section-title', '最近流水'), this.ledgerList, this.ledgerEmpty);
    this.bagLists = { food: list(), toy: list(), furniture: list(), wallet };
    panel.append(
      nav,
      this.bagLists.food,
      this.bagEmpty.food,
      this.bagLists.toy,
      this.bagEmpty.toy,
      this.bagLists.furniture,
      this.bagEmpty.furniture,
      this.bagLists.wallet,
    );
    return panel;
  }

  private buildShopPanel(): HTMLElement {
    const panel = h('div', 'life-panel life-panel-shop');
    panel.dataset.panel = 'shop';
    const filters = h('div', 'life-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', '商品分类');
    const kind = (k: ShopKind, text: string) => {
      const b = btn(text, 'life-chipbtn', () => {
        this.shopKind = k;
        this.render();
      });
      b.setAttribute('aria-pressed', 'false');
      filters.append(b);
      return b;
    };
    this.shopKinds = { all: kind('all', '全部'), food: kind('food', '食物'), toy: kind('toy', '玩具'), furniture: kind('furniture', '家具') };
    this.shopSetSelect = h('select');
    this.shopSetSelect.setAttribute('aria-label', '按套装筛选');
    this.shopSetSelect.append(new Option('全部套装', ''));
    this.shopSetSelect.addEventListener('change', () => {
      this.shopSet = this.shopSetSelect.value;
      this.render();
    });
    filters.append(this.shopSetSelect);
    this.shopGrid = h('div', 'life-shop');
    this.shopEmpty = h('p', 'life-empty', '这个分类里暂时没有商品。');
    this.shopEmpty.hidden = true;
    panel.append(
      filters,
      h('p', 'life-hint', '“解锁”表示达到等级后可以购买；“已获得”是背包里已经有的数量。升级奖励会直接放进背包。'),
      this.shopGrid,
      this.shopEmpty,
    );
    return panel;
  }

  private buildGrowthPanel(): HTMLElement {
    const panel = h('div', 'life-panel life-panel-growth');
    panel.dataset.panel = 'growth';
    this.growthLevel = h('b', '', 'Lv —');
    this.growthXp = h('small');
    this.growthFill = h('span');
    this.growthBar = h('div', 'life-bar life-bar-big');
    this.growthBar.setAttribute('role', 'progressbar');
    this.growthBar.setAttribute('aria-label', '本级经验');
    this.growthBar.setAttribute('aria-valuemin', '0');
    this.growthBar.append(this.growthFill);
    const card = h('div', 'life-stat life-growth-card');
    card.append(h('small', '', '成长等级'), this.growthLevel, this.growthBar, this.growthXp);
    this.growthToday = h('p', 'life-hint');
    this.dailyList = h('ul', 'life-list life-checklist');
    this.unlockTitle = h('h3', 'life-section-title', '接下来解锁');
    this.unlockList = h('div', 'life-list');
    this.growthLedger = h('ul', 'life-list life-ledger');
    this.growthLedgerEmpty = h('p', 'life-empty', '还没有流水记录。');
    panel.append(
      card,
      h('h3', 'life-section-title', '今天的日常'),
      this.growthToday,
      this.dailyList,
      this.unlockTitle,
      this.unlockList,
      h('h3', 'life-section-title', '最近流水'),
      this.growthLedger,
      this.growthLedgerEmpty,
    );
    return panel;
  }

  /* ---------- 导航 ---------- */

  private goPanel(p: Panel): void {
    if (this.edit && p !== 'room') return;
    this.panel = p;
    this.render();
  }

  private goBag(tab: BagTab, note?: string): void {
    if (this.edit) return;
    this.bagTab = tab;
    this.panel = 'bag';
    if (note && !this.op) this.setFeedback(note, 'info');
    this.render();
    this.tabs.bag.focus({ preventScroll: false });
  }

  private toggleSleep(): void {
    const sleeping = Boolean(this.snap?.needs.sleeping);
    this.act(sleeping ? '叫醒它' : '安排休息', { kind: 'sleep', sleeping: !sleeping }, (s) =>
      s.needs.sleeping ? '它躺下休息了。' : '它醒过来了。',
    );
  }

  /* ---------- 渲染 ---------- */

  private render(): void {
    if (this.disposed) return;
    const s = this.snap;
    this.root.dataset.state = s ? 'ready' : this.available === false ? 'unavailable' : 'loading';
    show(this.loading, !s && this.available !== false);
    show(this.unavailable, !s && this.available === false);
    setText(this.unavailableText, this.loadError);
    show(this.body, Boolean(s));
    if (!s) return;
    this.root.dataset.edit = this.edit ? 'true' : 'false';
    this.root.dataset.panel = this.panel;
    const locked = Boolean(this.op);

    show(this.staleNote, Boolean(this.loadError));
    setText(this.staleNote, this.loadError ? `${this.loadError}下面是上次读取到的状态。` : '');
    setText(this.stones, String(Math.floor(num(s.wallet.stones))));
    setText(this.checkin, s.daily.checkedIn ? '今日已签到' : '签到');
    setDisabled(this.checkin, locked || s.daily.checkedIn);
    const g = s.growth;
    const maxed = num(g.level) >= num(g.maxLevel, Infinity);
    setText(this.levelLabel, `Lv ${num(g.level)}${maxed ? ' · 已满级' : ''}`);
    const need = Math.max(1, num(g.nextLevelXp, 1));
    const have = clamp(num(g.levelXp), 0, need);
    setText(this.levelXp, maxed ? `累计 ${num(g.totalXp)} 经验` : `${have} / ${need} 经验`);
    this.levelFill.style.width = pct(maxed ? 1 : have / need);
    this.levelBar.setAttribute('aria-valuemax', String(need));
    this.levelBar.setAttribute('aria-valuenow', String(maxed ? need : have));

    const summary = typeof s.summary === 'string' ? s.summary.trim() : '';
    show(this.summaryNote, Boolean(summary) && summary !== this.summarySeen);
    setText(this.summaryText, summary);
    show(this.levelUpNote, Boolean(this.levelNote));
    setText(this.levelUpText, this.levelNote);

    for (const p of ['room', 'bag', 'shop', 'growth'] as const) {
      this.tabs[p].setAttribute('aria-pressed', String(this.panel === p));
      setDisabled(this.tabs[p], Boolean(this.edit) && p !== 'room');
      show(this.panels[p], this.panel === p);
    }
    if (this.panel === 'room') {
      this.renderRoom();
      this.renderRoomSide(s, locked);
    } else if (this.panel === 'bag') this.renderBag(s, locked);
    else if (this.panel === 'shop') this.renderShop(s, locked);
    else this.renderGrowth(s);
  }

  private roomSize(): { W: number; H: number } {
    const r = this.snap?.room;
    return { W: Math.max(1, num(r?.width, 1000)), H: Math.max(1, num(r?.height, 700)) };
  }

  private productOfInstance(id: string): LifeProduct | undefined {
    const itemId = this.instanceItem.get(id);
    return itemId ? this.products.get(itemId) : undefined;
  }

  private entries(): RoomEntry[] {
    const s = this.snap;
    if (!s) return [];
    const list = this.edit ? this.edit.draft : s.room.placements;
    return list
      .filter((p) => isObj(p) && typeof p.instanceId === 'string' && this.instanceItem.has(p.instanceId))
      .map((p) => ({ instanceId: p.instanceId, x: num(p.x), y: num(p.y), rotation: num(p.rotation), product: this.productOfInstance(p.instanceId) }));
  }

  private renderRoom(): void {
    const s = this.snap;
    if (!s) return;
    const list = this.entries();
    const { W, H } = this.roomSize();
    this.room.style.aspectRatio = `${W} / ${H}`;
    reconcile(this.itemsLayer, list, (e) => e.instanceId, (e) => this.createItem(e.instanceId), (el, e) => this.updateItem(el, e), this.caches.items);
    const fgs = list
      .map((e) => ({ e, url: foregroundUrl(this.host.assetRoot, e.product, visualOf(e.product).fg) }))
      .filter((f): f is { e: RoomEntry; url: string } => Boolean(f.url));
    reconcile(this.fgLayer, fgs, (f) => f.e.instanceId, () => this.createForeground(), (el, f) => this.updateForeground(el, f.e, f.url), this.caches.fg);
    this.renderPet(list);
    let tag = '';
    if (this.edit) tag = '布置中';
    else if (s.needs.sleeping) tag = '正在睡觉';
    else if (s.needs.weakness >= 2) tag = '没什么精神';
    show(this.roomTag, Boolean(tag));
    setText(this.roomTag, tag);
    if (this.edit) this.renderEditBar(s);
    show(this.editBar, Boolean(this.edit));
  }

  /** 物品外框按图片画布绘制且不接收指针；可点、可拖的是贴着物体本身的 hit 区域，透明边不挡住别的家具。 */
  private createItem(id: string): HTMLElement {
    const el = h('div', 'life-item');
    const hit = h('div', 'life-item-hit');
    hit.addEventListener('pointerdown', (e) => this.onItemPointerDown(e, id, hit));
    hit.addEventListener('pointermove', (e) => this.onItemPointerMove(e));
    hit.addEventListener('pointerup', (e) => this.onItemPointerUp(e));
    hit.addEventListener('pointercancel', (e) => this.onItemPointerUp(e));
    hit.addEventListener('lostpointercapture', (e) => this.onItemPointerUp(e));
    hit.addEventListener('click', () => this.onItemClick(id));
    hit.addEventListener('keydown', (e) => this.onItemKey(e, id));
    el.append(makeArt('life-item-art'), hit);
    return el;
  }

  private itemHit(id: string): HTMLElement | null {
    return this.caches.items.get(id)?.querySelector<HTMLElement>('.life-item-hit') ?? null;
  }

  private updateItem(el: HTMLElement, e: RoomEntry): void {
    const { W, H } = this.roomSize();
    const box = boxOf(e.product);
    const v = visualOf(e.product);
    // 主图按画布尺寸绘制，落点 (x, y) 对齐锚点；占地只用于边界和碰撞，不拉伸图片。
    el.style.left = pct((e.x - v.ax * v.w) / W);
    el.style.top = pct((e.y - v.ay * v.h) / H);
    el.style.width = pct(v.w / W);
    el.style.height = pct(v.h / H);
    el.style.zIndex = String(zOf(box.layer, e.y));
    el.dataset.layer = box.layer;
    const hit = el.lastElementChild as HTMLElement;
    const hw = Math.min(v.w, Math.max(box.w, v.w * 0.7, 80));
    const ht = Math.min(v.h * v.ay, Math.max(v.h * v.ay * (box.layer === 'rug' ? 0.5 : 0.85), 60));
    hit.style.left = pct((v.ax * v.w - hw / 2) / v.w);
    hit.style.width = pct(hw / v.w);
    hit.style.top = pct((v.ay * v.h - ht) / v.h);
    hit.style.height = pct((ht + Math.min(8, v.h * (1 - v.ay))) / v.h);
    const name = e.product?.name ?? '未知物品';
    const art = el.firstElementChild as HTMLElement;
    const base = assetUrl(this.host.assetRoot, e.product?.asset);
    const rotated = box.rotations.length > 1 ? assetUrl(this.host.assetRoot, e.product?.asset, e.rotation, box.rotations[0]) : base;
    setArt(art, rotated, name, rotated !== base ? base : null);
    const editing = Boolean(this.edit);
    const selected = editing && this.edit?.selected === e.instanceId;
    el.dataset.selected = String(selected);
    const roleAction = box.role === 'bed' ? (this.snap?.needs.sleeping ? '叫醒它' : '让它去睡觉') : box.role === 'bowl' ? '喂食' : box.role === 'toy' ? '陪它玩' : '';
    const interactive = editing || Boolean(roleAction);
    if (interactive) {
      hit.setAttribute('role', 'button');
      hit.tabIndex = 0;
    } else {
      hit.removeAttribute('role');
      hit.removeAttribute('tabindex');
    }
    if (editing) {
      hit.setAttribute('aria-pressed', String(selected));
      hit.setAttribute('aria-label', `${name}，${selected ? '已选中，' : ''}可拖动，或用方向键移动`);
    } else {
      hit.removeAttribute('aria-pressed');
      if (roleAction) hit.setAttribute('aria-label', `${name}：${roleAction}`);
      else hit.removeAttribute('aria-label');
    }
    hit.setAttribute('aria-hidden', interactive ? 'false' : 'true');
  }

  private createForeground(): HTMLElement {
    const el = h('div', 'life-fg');
    const img = h('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    // 前景缺失时直接不画，床主图仍完整。
    img.addEventListener('error', () => {
      el.hidden = true;
    });
    el.append(img);
    return el;
  }

  private updateForeground(el: HTMLElement, e: RoomEntry, url: string): void {
    const { W, H } = this.roomSize();
    const v = visualOf(e.product);
    el.style.left = pct((e.x - v.ax * v.w) / W);
    el.style.top = pct((e.y - v.ay * v.h) / H);
    el.style.width = pct(v.w / W);
    el.style.height = pct(v.h / H);
    el.style.zIndex = String(zOf(boxOf(e.product).layer, e.y) + 2);
    const img = el.firstElementChild as HTMLImageElement;
    if (img.getAttribute('src') !== url) {
      el.hidden = false;
      img.setAttribute('src', url);
    }
  }

  /** 当前应表现的动作：短暂动作过了 presentation.until 就回到休息或待机，等下一次读取对齐。 */
  private baseAction(): string {
    const s = this.snap;
    if (!s) return 'idle';
    const a: string = typeof s.presentation.action === 'string' ? s.presentation.action : 'idle';
    const until = num(s.presentation.until);
    if (TRANSIENT.has(a) && until > 0 && Date.now() >= until) return s.needs.sleeping ? 'sleep' : 'idle';
    return a;
  }

  private petWidth(): number {
    return clamp(PET_H * (this.sprite?.aspect ?? 150 / 170), 90, 240);
  }

  /** 宠物落脚点（房间坐标）与层级。只读房间草稿/快照，不写业务；用到的床或玩具被收走时回到地面中间。 */
  private petSpot(list: RoomEntry[]): PetSpot {
    const s = this.snap;
    const { W, H } = this.roomSize();
    const action = this.baseAction();
    const pw = this.petWidth();
    const find = (role: string) => list.find((e) => boxOf(e.product).role === role);
    const free = (x: number, y: number): PetSpot => {
      const fy = clamp(y, PET_H, H);
      return { x: clamp(x, pw / 2, W - pw / 2), y: fy, z: 1000 + Math.round(fy) + 1 };
    };
    if (s?.needs.sleeping || action === 'sleep') {
      const bed = find('bed');
      if (bed) {
        // 躺在床面交互点上；z 压在床主图之上、前景之下，被子会盖住身体下半部分。
        const v = visualOf(bed.product);
        const x = bed.x + (v.ix - v.ax) * v.w;
        const y = bed.y + (v.iy - v.ay) * v.h;
        return { x: clamp(x, pw / 2, W - pw / 2), y: clamp(y, PET_H * 0.5, H), z: zOf(boxOf(bed.product).layer, bed.y) + 1 };
      }
    } else if (action === 'eat' || action === 'full' || action === 'hungry') {
      const bowl = find('bowl');
      if (bowl) {
        const reach = Math.max(boxOf(bowl.product).w / 2, visualOf(bowl.product).w * 0.3);
        return free(bowl.x + reach + pw * 0.4, bowl.y + 6);
      }
    } else if (action === 'play') {
      const toy = find('toy');
      if (toy) {
        const reach = Math.max(boxOf(toy.product).w / 2, visualOf(toy.product).w * 0.3);
        return free(toy.x - reach - pw * 0.4, toy.y + 6);
      }
    }
    return free(W / 2, H * 0.88);
  }

  /** 解析要播放的动作：按 动作 → 语义降级 → 待机 选第一个有可用帧的；步行时优先 walk。 */
  private resolveAction(): string | null {
    const sp = this.sprite;
    if (!sp) return null;
    const a = this.baseAction();
    const chain = [...(this.walking ? ['walk'] : []), a, LEGACY[a] ?? 'idle', 'idle'];
    for (const k of chain) {
      const act = sp.actions.get(k);
      if (act && act.frames.some((f) => !this.failedFrames.has(f.url))) return k;
    }
    return null;
  }

  /** 动作变了才从第一帧重来；同一动作随轮询刷新时继续播放。 */
  private updateFrame(): void {
    if (this.disposed || !this.character) return;
    const key = this.resolveAction();
    if (key !== this.playKey) {
      this.playKey = key;
      this.playIndex = 0;
      this.preload(key);
    }
    this.showFrame();
    this.scheduleFrame();
  }

  private preload(key: string | null): void {
    const act = key ? this.sprite?.actions.get(key) : undefined;
    if (!act) return;
    for (const f of act.frames) {
      if (this.preloaded.has(f.url)) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = f.url;
      this.preloaded.set(f.url, img);
    }
  }

  private currentAction(): SpriteAction | undefined {
    return this.playKey ? this.sprite?.actions.get(this.playKey) : undefined;
  }

  private showFrame(): void {
    const act = this.currentAction();
    let src = this.character?.image ?? '';
    if (act) {
      const i = reducedMotion() ? 0 : Math.min(this.playIndex, act.frames.length - 1);
      const f = act.frames[i];
      src = f && !this.failedFrames.has(f.url) ? f.url : (act.frames.find((x) => !this.failedFrames.has(x.url))?.url ?? src);
    }
    if (src && this.petImg.dataset.src !== src) {
      this.petImg.dataset.src = src;
      this.petImg.setAttribute('src', src);
    }
  }

  /** 按每帧 timings 播放；loops 为 false 的动作停在最后一帧。减少动画、页面隐藏或未激活时不计时。 */
  private scheduleFrame(): void {
    const act = this.currentAction();
    const runnable = Boolean(
      act && act.frames.length > 1 && this.active && !document.hidden && !this.disposed && !reducedMotion() && (act.loop || this.playIndex < act.frames.length - 1),
    );
    // 其它渲染（拖动、轮询）不重启当前帧的计时，否则动画会被频繁渲染拖住。
    const slot = `${this.playKey}|${this.playIndex}`;
    if (runnable && this.frameTimer && this.frameSlot === slot) return;
    window.clearTimeout(this.frameTimer);
    this.frameTimer = 0;
    if (!runnable || !act) return;
    this.frameSlot = slot;
    const ms = act.frames[Math.min(this.playIndex, act.frames.length - 1)].ms;
    this.frameTimer = window.setTimeout(() => {
      this.frameTimer = 0;
      const cur = this.currentAction();
      if (!cur) return;
      const next = this.playIndex + 1;
      this.playIndex = next < cur.frames.length ? next : cur.loop ? 0 : cur.frames.length - 1;
      this.showFrame();
      this.scheduleFrame();
    }, ms);
  }

  /** 站位变化时短暂走过去（纯表现）；首次出现、布置中、减少动画或页面不可见时直接就位。 */
  private placePet(spot: PetSpot): void {
    const { W, H } = this.roomSize();
    const pw = this.petWidth();
    const ax = this.sprite?.ax ?? 0.5;
    const ay = this.sprite?.ay ?? 1;
    const prev = this.petPos;
    if (!prev || prev.x !== spot.x || prev.y !== spot.y) {
      const dist = prev ? Math.hypot(spot.x - prev.x, spot.y - prev.y) : 0;
      if (prev && dist > 12 && !this.edit && this.active && !document.hidden && !reducedMotion()) {
        const ms = Math.round(clamp((dist / WALK_SPEED) * 1000, 350, 2600));
        window.clearTimeout(this.walkTimer);
        this.pet.style.transition = `left ${ms}ms linear, top ${ms}ms linear`;
        this.walking = true;
        this.walkTimer = window.setTimeout(() => {
          this.walkTimer = 0;
          this.walking = false;
          this.pet.style.transition = '';
          this.updateFrame();
        }, ms);
      } else this.stopWalk();
      this.petPos = { x: spot.x, y: spot.y };
    }
    this.pet.style.left = pct((spot.x - ax * pw) / W);
    this.pet.style.top = pct((spot.y - ay * PET_H) / H);
    this.pet.style.width = pct(pw / W);
    this.pet.style.height = pct(PET_H / H);
    this.pet.style.zIndex = String(spot.z);
  }

  private renderPet(list?: RoomEntry[]): void {
    if (this.disposed) return;
    const s = this.snap;
    const c = this.character;
    if (!s || !c || !(this.sprite || c.image)) {
      show(this.pet, false);
      window.clearTimeout(this.frameTimer);
      this.frameTimer = 0;
      this.stopWalk();
      return;
    }
    show(this.pet, true);
    this.placePet(this.petSpot(list ?? this.entries()));
    this.updateFrame();
    this.pet.dataset.action = this.playKey ?? this.baseAction();
    this.pet.dataset.weak = String(num(s.needs.weakness));
    const name = c.name || '它';
    this.pet.setAttribute('aria-label', `${name}，点一下和它聊天`);
    this.pet.tabIndex = this.edit ? -1 : 0;
    this.pet.setAttribute('aria-hidden', this.edit ? 'true' : 'false');
  }

  private renderRoomSide(s: LifeSnapshot, locked: boolean): void {
    const n = s.needs;
    const set = (key: 'fullness' | 'energy' | 'joy', value: number, phrase: string) => {
      const v = Math.round(clamp(num(value), 0, 100));
      const r = this.needs[key];
      r.fill.style.width = `${v}%`;
      r.bar.setAttribute('aria-valuenow', String(v));
      r.bar.setAttribute('aria-valuetext', `${v}，${phrase}`);
      setText(r.text, `${phrase} · ${v}`);
      r.row.dataset.low = String(v < 30);
    };
    const f = num(n.fullness);
    const e = num(n.energy);
    const j = num(n.joy);
    set('fullness', f, f >= 70 ? '吃饱了' : f >= 40 ? '还不饿' : f >= 20 ? '有点饿' : '饿了');
    set('energy', e, n.sleeping ? '正在睡觉' : e >= 70 ? '精神很好' : e >= 30 ? '还有精神' : '有点困');
    set('joy', j, j >= 70 ? '很开心' : j >= 40 ? '还不错' : '想玩一会儿');

    const weak = num(n.weakness);
    show(this.weakNote, weak > 0);
    setText(this.weakText, weak > 0 ? `${WEAKNESS[weak] ?? WEAKNESS[3]}真正吃到东西后会慢慢恢复；不影响聊天和工作。` : '');

    const foods = s.inventory.food.filter((x) => isObj(x) && num(x.quantity) > 0);
    const autoFoods = foods.filter((x) => x.autoFeed);
    let foodMsg = '';
    let foodAction: (() => void) | null = null;
    let foodLabel = '';
    if (!foods.length && (f < 40 || weak > 0)) {
      foodMsg = '背包里没有食物了，它没法自己吃饭。';
      foodLabel = '去商店';
      foodAction = () => {
        this.shopKind = 'food';
        this.goPanel('shop');
      };
    } else if (foods.length && !autoFoods.length && (f < 40 || weak > 0)) {
      foodMsg = '背包里只有没设为自动食用的食物，可以直接喂它，或打开自动食用。';
      foodLabel = '去喂食';
      foodAction = () => this.goBag('food');
    }
    show(this.foodNote, Boolean(foodMsg));
    setText(this.foodText, foodMsg);
    setText(this.foodNoteBtn, foodLabel);
    this.foodNoteBtn.onclick = foodAction;

    setDisabled(this.actionBtns.feed, Boolean(this.edit));
    setDisabled(this.actionBtns.play, locked || Boolean(this.edit));
    setDisabled(this.actionBtns.rest, locked || Boolean(this.edit));
    setDisabled(this.actionBtns.edit, Boolean(this.edit));
    setText(this.actionBtns.rest, n.sleeping ? '叫醒' : '休息');
  }

  private renderEditBar(s: LifeSnapshot): void {
    const ed = this.edit;
    if (!ed) return;
    const locked = Boolean(this.op);
    const sel = ed.selected ? ed.draft.find((p) => p.instanceId === ed.selected) : undefined;
    const product = sel ? this.productOfInstance(sel.instanceId) : undefined;
    show(this.editSelected, Boolean(sel));
    if (sel) {
      const box = boxOf(product);
      setText(this.editSelectedName, `已选中：${product?.name ?? '未知物品'}`);
      show(this.rotateBtn, box.rotations.length > 1);
      this.rotateBtn.setAttribute('aria-label', `转向，当前 ${num(sel.rotation)} 度`);
    }
    for (const b of [...this.moveBtns, this.rotateBtn, this.takeBackBtn]) setDisabled(b, locked);

    const placed = new Set(ed.draft.map((p) => p.instanceId));
    const unplaced = s.inventory.items.filter((i) => !placed.has(i.instanceId) && this.products.get(i.itemId)?.placement);
    reconcile(
      this.tray,
      unplaced,
      (i) => i.instanceId,
      (i) => {
        const b = btn('', 'quiet life-btn life-tray-item', () => this.addToRoom(i.instanceId));
        b.append(makeArt(), h('span'));
        return b;
      },
      (el, i) => {
        const p = this.products.get(i.itemId);
        const name = p?.name ?? '未知物品';
        setArt(el.firstElementChild as HTMLElement, assetUrl(this.host.assetRoot, p?.asset), name);
        setText(el.lastElementChild as HTMLElement, name);
        el.setAttribute('aria-label', `把${name}放进房间`);
        setDisabled(el as HTMLButtonElement, locked);
      },
      this.caches.tray,
    );
    show(this.trayEmpty, !unplaced.length);
    show(this.conflictNote, s.room.revision !== ed.base);
    const lost = ed.draft.filter((p) => !this.instanceItem.has(p.instanceId)).length;
    setText(this.editNote, lost ? `有 ${lost} 件物品已不在背包里，保存时会跳过。` : ed.dirty ? '有未保存的修改。' : '');
    setDisabled(this.saveBtn, locked);
    setDisabled(this.cancelBtn, this.op?.state === 'sending');
    setText(this.saveBtn, this.op?.state === 'sending' && this.op.command.kind === 'room.save' ? '正在保存…' : '保存布置');
  }

  private renderBag(s: LifeSnapshot, locked: boolean): void {
    for (const t of ['food', 'toy', 'furniture', 'wallet'] as const) {
      this.bagTabs[t].setAttribute('aria-pressed', String(this.bagTab === t));
      show(this.bagLists[t], this.bagTab === t);
    }
    for (const t of ['food', 'toy', 'furniture'] as const) show(this.bagEmpty[t], false);
    if (this.bagTab === 'food') this.renderFood(s, locked);
    else if (this.bagTab === 'wallet') this.renderWallet(s);
    else this.renderOwned(s, this.bagTab, locked);
  }

  private renderFood(s: LifeSnapshot, locked: boolean): void {
    const order = new Map(s.catalog.map((p, i): [string, number] => [p.id, i]));
    const foods = s.inventory.food
      .filter((f) => isObj(f) && typeof f.itemId === 'string')
      .slice()
      .sort((a, b) => (order.get(a.itemId) ?? 1e9) - (order.get(b.itemId) ?? 1e9));
    reconcile(
      this.bagLists.food,
      foods,
      (f) => f.itemId,
      (f) => {
        const row = h('div', 'life-row');
        const text = h('div', 'life-row-text');
        text.append(h('b'), h('small'));
        const sw = h('input');
        sw.type = 'checkbox';
        sw.addEventListener('change', () => {
          const p = this.products.get(f.itemId);
          const before = this.op;
          this.act(
            sw.checked ? '打开自动食用' : '关闭自动食用',
            { kind: 'autofeed', itemId: f.itemId, enabled: sw.checked },
            (ns) => {
              const on = ns.inventory.food.find((x) => x.itemId === f.itemId)?.autoFeed;
              return `${p?.name ?? '这种食物'}${on ? '会在饿的时候自动吃' : '留着手动喂'}。`;
            },
          );
          // 没能发出时回到真实设置，开关不停在未生效的位置。
          if (this.op === before) sw.checked = !sw.checked;
        });
        const label = h('label', 'life-switch');
        label.append(sw, document.createTextNode('自动食用'));
        const feed = btn('喂它', 'primary life-btn', () => {
          const p = this.products.get(f.itemId);
          this.act(`喂${p?.name ?? '食物'}`, { kind: 'feed', itemId: f.itemId }, () => `它吃了${p?.name ?? '食物'}，看起来很满足。`);
        });
        const acts = h('div', 'life-row-actions');
        acts.append(label, feed);
        row.append(makeArt(), text, acts);
        return row;
      },
      (row, f) => {
        const p = this.products.get(f.itemId);
        const name = p?.name ?? '未知食物';
        const q = Math.max(0, Math.floor(num(f.quantity)));
        setArt(row.children[0] as HTMLElement, assetUrl(this.host.assetRoot, p?.asset), name);
        const text = row.children[1] as HTMLElement;
        setText(text.children[0], `${name} ×${q}`);
        setText(text.children[1], [p?.nutrition ? `恢复约 ${p.nutrition} 饱食` : '', p?.description ?? ''].filter(Boolean).join(' · '));
        const acts = row.children[2] as HTMLElement;
        const sw = acts.querySelector('input') as HTMLInputElement;
        // 发送中保留用户刚切换的位置；其余时候永远显示快照里的真实设置。
        if (!(this.op?.command.kind === 'autofeed' && this.op.command.itemId === f.itemId)) sw.checked = Boolean(f.autoFeed);
        sw.setAttribute('aria-label', `${name}自动食用`);
        setDisabled(sw, locked);
        const feed = acts.querySelector('button') as HTMLButtonElement;
        feed.setAttribute('aria-label', `喂它${name}`);
        setDisabled(feed, locked || q <= 0);
      },
      this.caches.food,
    );
    show(this.bagEmpty.food, !foods.length);
  }

  private renderOwned(s: LifeSnapshot, kind: 'toy' | 'furniture', locked: boolean): void {
    const placed = new Set(s.room.placements.map((p) => p.instanceId));
    const groups = new Map<string, { itemId: string; ids: string[]; placed: string[] }>();
    for (const i of s.inventory.items) {
      const p = this.products.get(i.itemId);
      if (!p || p.kind !== kind) continue;
      const g = groups.get(i.itemId) ?? { itemId: i.itemId, ids: [], placed: [] };
      g.ids.push(i.instanceId);
      if (placed.has(i.instanceId)) g.placed.push(i.instanceId);
      groups.set(i.itemId, g);
    }
    const list = [...groups.values()];
    reconcile(
      this.bagLists[kind],
      list,
      (g) => g.itemId,
      (g) => {
        const row = h('div', 'life-row');
        const text = h('div', 'life-row-text');
        text.append(h('b'), h('small'));
        const acts = h('div', 'life-row-actions');
        if (kind === 'toy') {
          acts.append(
            btn('玩一会儿', 'primary life-btn', () => {
              // 点击时按最新快照挑实例，优先已经放在房间里的那件。
              const cur = this.snap;
              if (!cur) return;
              const placedNow = new Set(cur.room.placements.map((x) => x.instanceId));
              const ids = cur.inventory.items.filter((i) => i.itemId === g.itemId).map((i) => i.instanceId);
              const id = ids.find((x) => placedNow.has(x)) ?? ids[0];
              if (!id) return;
              const name = this.products.get(g.itemId)?.name ?? '玩具';
              this.act(`玩${name}`, { kind: 'play', instanceId: id }, () => `它玩了一会儿${name}。`);
            }),
          );
        }
        acts.append(btn('', 'quiet life-btn', () => this.placeFromBag(g.itemId)));
        row.append(makeArt(), text, acts);
        return row;
      },
      (row, g) => {
        const p = this.products.get(g.itemId);
        const name = p?.name ?? '未知物品';
        setArt(row.children[0] as HTMLElement, assetUrl(this.host.assetRoot, p?.asset), name);
        const text = row.children[1] as HTMLElement;
        const free = g.ids.length - g.placed.length;
        setText(text.children[0], name);
        setText(text.children[1], `共 ${g.ids.length} 件 · 已放置 ${g.placed.length} · 可放置 ${free}${p?.setName ? ` · ${p.setName}` : ''}`);
        const buttons = (row.children[2] as HTMLElement).querySelectorAll('button');
        const placeBtn = buttons[buttons.length - 1] as HTMLButtonElement;
        setText(placeBtn, free > 0 ? '放进房间' : '调整位置');
        placeBtn.setAttribute('aria-label', `${free > 0 ? '把' : '调整'}${name}${free > 0 ? '放进房间' : '的位置'}`);
        setDisabled(placeBtn, !p?.placement);
        if (kind === 'toy') setDisabled(buttons[0] as HTMLButtonElement, locked);
      },
      this.caches[kind],
    );
    show(this.bagEmpty[kind], !list.length);
  }

  private renderWallet(s: LifeSnapshot): void {
    setText(this.walletStones, String(Math.floor(num(s.wallet.stones))));
    const d = s.daily;
    setText(
      this.walletToday,
      `今天：${d.checkedIn ? '已签到' : '还没签到'} · 有效陪伴 ${Math.floor(num(d.onlineMinutes))} 分钟，得到 ${num(d.onlineStones)} 灵石 · 聊天奖励 ${num(d.chatRewards)}`,
    );
    this.renderLedger(s, this.ledgerList, this.ledgerEmpty, this.caches.ledger);
  }

  private renderLedger(s: LifeSnapshot, list: HTMLElement, empty: HTMLElement, cache: Map<string, HTMLElement>): void {
    const entries = s.wallet.ledger
      .filter((e): e is LifeLedgerEntry => isObj(e) && typeof e.id === 'string')
      .slice()
      .sort((a, b) => num(b.at) - num(a.at))
      .slice(0, 30);
    reconcile(
      list,
      entries,
      (e) => e.id,
      () => {
        const li = h('li', 'life-ledger-row');
        li.append(h('span', 'life-ledger-label'), h('span', 'life-ledger-delta'), h('small'));
        return li;
      },
      (li, e) => {
        setText(li.children[0], e.label);
        const parts = [] as string[];
        if (num(e.stones)) parts.push(`${signed(num(e.stones))} 灵石`);
        if (num(e.xp)) parts.push(`${signed(num(e.xp))} 经验`);
        setText(li.children[1], parts.join('  ') || '—');
        (li.children[1] as HTMLElement).dataset.sign = num(e.stones) < 0 ? 'minus' : 'plus';
        setText(li.children[2], when(num(e.at)));
      },
      cache,
    );
    show(empty, !entries.length);
    show(list, entries.length > 0);
  }

  private renderShop(s: LifeSnapshot, locked: boolean): void {
    for (const k of ['all', 'food', 'toy', 'furniture'] as const) this.shopKinds[k].setAttribute('aria-pressed', String(this.shopKind === k));
    const sets = new Map<string, string>();
    for (const p of s.catalog) if (p.setId) sets.set(p.setId, p.setName || p.setId);
    const sig = JSON.stringify([...sets]);
    if (sig !== this.shopSetSig) {
      this.shopSetSig = sig;
      this.shopSetSelect.replaceChildren(new Option('全部套装', ''), ...[...sets].map(([id, name]) => new Option(name, id)));
      if (!sets.has(this.shopSet)) this.shopSet = '';
      this.shopSetSelect.value = this.shopSet;
    }
    show(this.shopSetSelect, sets.size > 0 && this.shopKind !== 'food');
    const level = num(s.growth.level);
    const list = s.catalog.filter(
      (p) =>
        isObj(p) &&
        typeof p.id === 'string' &&
        (this.shopKind === 'all' || p.kind === this.shopKind) &&
        (!this.shopSet || this.shopKind === 'food' || p.setId === this.shopSet),
    );
    const owned = new Map<string, number>();
    for (const f of s.inventory.food) owned.set(f.itemId, (owned.get(f.itemId) ?? 0) + Math.max(0, num(f.quantity)));
    for (const i of s.inventory.items) owned.set(i.itemId, (owned.get(i.itemId) ?? 0) + 1);
    const placedCount = new Map<string, number>();
    for (const p of s.room.placements) {
      const itemId = this.instanceItem.get(p.instanceId);
      if (itemId) placedCount.set(itemId, (placedCount.get(itemId) ?? 0) + 1);
    }
    reconcile(
      this.shopGrid,
      list,
      (p) => p.id,
      (p) => this.createCard(p.id),
      (el, p) => this.updateCard(el, p, level, num(s.wallet.stones), owned.get(p.id) ?? 0, placedCount.get(p.id) ?? 0, locked),
      this.caches.shop,
    );
    show(this.shopEmpty, !list.length);
  }

  private createCard(id: string): HTMLElement {
    const card = h('article', 'life-card');
    const head = h('div', 'life-card-head');
    head.append(h('b', 'life-card-name'), h('span', 'life-price'));
    const tags = h('div', 'life-tags');
    const input = h('input');
    input.type = 'number';
    input.min = '1';
    input.max = String(maxQty(this.products.get(id)));
    input.step = '1';
    input.inputMode = 'numeric';
    input.value = String(this.qty.get(id) ?? 1);
    const setQty = (v: number) => {
      const q = Math.round(clamp(Number.isFinite(v) ? v : 1, 1, maxQty(this.products.get(id))));
      this.qty.set(id, q);
      if (input.value !== String(q) && document.activeElement !== input) input.value = String(q);
      this.render();
    };
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (input.value !== '' && Number.isFinite(v)) setQty(v);
    });
    input.addEventListener('blur', () => {
      input.value = String(this.qty.get(id) ?? 1);
    });
    const minus = btn('−', 'quiet life-btn', () => setQty((this.qty.get(id) ?? 1) - 1));
    const plus = btn('+', 'quiet life-btn', () => setQty((this.qty.get(id) ?? 1) + 1));
    const qty = h('div', 'life-qty');
    qty.append(minus, input, plus);
    const buy = btn('购买', 'primary life-btn', () => this.buy(id));
    const reason = h('small', 'life-reason');
    card.append(makeArt(), head, h('p', 'life-card-desc'), tags, qty, buy, reason);
    return card;
  }

  private updateCard(card: HTMLElement, p: LifeProduct, level: number, stones: number, owned: number, placed: number, locked: boolean): void {
    const [art, head, desc, tags, qtyBox, buy, reason] = Array.from(card.children) as HTMLElement[];
    setArt(art, assetUrl(this.host.assetRoot, p.asset), p.name);
    setText(head.children[0], p.name);
    const price = Math.max(0, Math.floor(num(p.price)));
    setText(head.children[1], `${price} 灵石`);
    setText(desc, p.description ?? '');
    const unlocked = level >= num(p.unlockLevel);
    const tagList: Array<[string, string]> = [[KIND_LABEL[p.kind] ?? '物品', '']];
    if (p.setName) tagList.push([p.setName, '']);
    tagList.push(unlocked ? ['已解锁', 'ok'] : [`Lv ${num(p.unlockLevel)} 解锁`, 'lock']);
    if (owned > 0) tagList.push([p.kind === 'food' ? `已获得 ×${owned}` : `已获得 ${owned} 件${placed ? ` · 已放置 ${placed}` : ''}`, 'have']);
    const sig = JSON.stringify(tagList);
    if (tags.dataset.sig !== sig) {
      tags.dataset.sig = sig;
      tags.replaceChildren(
        ...tagList.map(([text, tone]) => {
          const t = h('span', 'life-tag', text);
          if (tone) t.dataset.tone = tone;
          return t;
        }),
      );
    }
    const max = maxQty(p);
    const q = Math.min(this.qty.get(p.id) ?? 1, max);
    const input = qtyBox.querySelector('input') as HTMLInputElement;
    if (input.max !== String(max)) input.max = String(max);
    if (document.activeElement !== input && input.value !== String(q)) input.value = String(q);
    input.setAttribute('aria-label', `${p.name}购买数量`);
    const [minus, , plus] = Array.from(qtyBox.children) as HTMLButtonElement[];
    minus.setAttribute('aria-label', `减少${p.name}数量`);
    plus.setAttribute('aria-label', `增加${p.name}数量`);
    const total = price * q;
    let why = '';
    if (!p.purchasable) why = '不在商店出售，可通过升级奖励获得。';
    else if (!unlocked) why = `成长到 Lv ${num(p.unlockLevel)} 后可以购买。`;
    else if (total > stones) why = `灵石不足，还差 ${total - Math.floor(stones)}。`;
    const can = !why;
    card.dataset.locked = String(!unlocked);
    show(qtyBox, p.purchasable && unlocked);
    setDisabled(input, locked);
    setDisabled(minus, locked || q <= 1);
    setDisabled(plus, locked || q >= max);
    const sending = this.op?.state === 'sending' && this.op.command.kind === 'buy' && this.op.command.itemId === p.id;
    setText(buy, sending ? '正在购买…' : !p.purchasable ? '非卖品' : !unlocked ? `Lv ${num(p.unlockLevel)} 解锁` : `购买 ×${q} · ${total} 灵石`);
    buy.setAttribute('aria-label', can ? `购买${q}份${p.name}，共${total}灵石` : `${p.name}：${why}`);
    setDisabled(buy as HTMLButtonElement, locked || !can);
    setText(reason, why);
  }

  private buy(itemId: string): void {
    const s = this.snap;
    const p = this.products.get(itemId);
    if (!s || !p) return;
    const q = Math.min(this.qty.get(itemId) ?? 1, maxQty(p));
    const total = Math.max(0, Math.floor(num(p.price))) * q;
    if (!p.purchasable || num(s.growth.level) < num(p.unlockLevel) || total > num(s.wallet.stones)) return;
    this.act(`购买${p.name} ×${q}`, { kind: 'buy', itemId, quantity: q }, () => {
      this.qty.set(itemId, 1);
      return p.kind === 'food' ? `买到了 ${q} 份${p.name}，已放进背包。` : `买到了 ${q} 件${p.name}，已放进背包，可以去布置房间。`;
    });
  }

  private renderGrowth(s: LifeSnapshot): void {
    const g = s.growth;
    const maxed = num(g.level) >= num(g.maxLevel, Infinity);
    const need = Math.max(1, num(g.nextLevelXp, 1));
    const have = clamp(num(g.levelXp), 0, need);
    setText(this.growthLevel, `Lv ${num(g.level)} / ${num(g.maxLevel)}`);
    setText(this.growthXp, maxed ? `已满级，累计 ${num(g.totalXp)} 经验。` : `本级 ${have} / ${need}，再得 ${need - have} 经验升级 · 累计 ${num(g.totalXp)}`);
    this.growthFill.style.width = pct(maxed ? 1 : have / need);
    this.growthBar.setAttribute('aria-valuemax', String(need));
    this.growthBar.setAttribute('aria-valuenow', String(maxed ? need : have));
    const d = s.daily;
    setText(this.growthToday, `今天获得 ${num(d.xp)} 经验 · 有效陪伴 ${Math.floor(num(d.onlineMinutes))} 分钟 · 聊天奖励 ${num(d.chatRewards)}`);
    const done = new Set(d.completed.filter((x): x is string => typeof x === 'string'));
    if (d.checkedIn) done.add('checkin');
    const rows = [...DAILY_ROWS, ...[...done].filter((k) => !DAILY_ROWS.includes(k))];
    reconcile(
      this.dailyList,
      rows,
      (k) => k,
      () => {
        const li = h('li');
        li.append(h('span', 'life-check'), h('span'), h('small'));
        li.firstElementChild?.setAttribute('aria-hidden', 'true');
        return li;
      },
      (li, k) => {
        const ok = done.has(k);
        li.dataset.done = String(ok);
        setText(li.children[0], ok ? '✓' : '');
        setText(li.children[1], DAILY_LABEL[k] ?? k);
        setText(li.children[2], ok ? '已完成' : '未完成');
      },
      this.caches.daily,
    );

    const level = num(g.level);
    const upcoming = s.catalog.filter((p) => num(p.unlockLevel) > level).sort((a, b) => num(a.unlockLevel) - num(b.unlockLevel));
    const nextLevel = upcoming.length ? num(upcoming[0].unlockLevel) : 0;
    const next = upcoming.filter((p) => num(p.unlockLevel) === nextLevel);
    setText(this.unlockTitle, next.length ? `Lv ${nextLevel} 解锁` : '接下来解锁');
    reconcile(
      this.unlockList,
      next.length ? next : [],
      (p) => p.id,
      () => {
        const row = h('div', 'life-row');
        const text = h('div', 'life-row-text');
        text.append(h('b'), h('small'));
        row.append(makeArt(), text);
        return row;
      },
      (row, p) => {
        setArt(row.children[0] as HTMLElement, assetUrl(this.host.assetRoot, p.asset), p.name);
        const text = row.children[1] as HTMLElement;
        setText(text.children[0], p.name);
        setText(text.children[1], `${KIND_LABEL[p.kind] ?? '物品'}${p.setName ? ` · ${p.setName}` : ''} · ${num(p.price)} 灵石，解锁后可以购买`);
      },
      this.caches.unlocks,
    );
    show(this.unlockList, next.length > 0);
    show(this.unlockTitle, next.length > 0);
    this.renderLedger(s, this.growthLedger, this.growthLedgerEmpty, this.caches.growthLedger);
  }

  /* ---------- 房间互动与布置 ---------- */

  private onItemClick(id: string): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (this.edit) {
      this.select(id);
      return;
    }
    const p = this.productOfInstance(id);
    const role = boxOf(p).role;
    if (role === 'bowl') this.goBag('food', '选一份食物喂它吧。');
    else if (role === 'bed') this.toggleSleep();
    else if (role === 'toy') this.act(`玩${p?.name ?? '玩具'}`, { kind: 'play', instanceId: id }, () => `它玩了一会儿${p?.name ?? '玩具'}。`);
  }

  private onItemKey(e: KeyboardEvent, id: string): void {
    if (e.isComposing) return;
    if (!this.edit) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.onItemClick(id);
      }
      return;
    }
    const step = e.shiftKey ? STEP * 2.5 : STEP / 2;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      if (this.edit.selected !== id) this.select(id);
      this.moveSelected(moves[e.key][0], moves[e.key][1]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.select(id);
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      if (this.edit.selected !== id) this.select(id);
      this.rotateSelected();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (this.edit.selected !== id) this.select(id);
      this.takeBackSelected();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.edit.selected = null;
      this.render();
    }
  }

  /** 拖动、方向按钮、键盘、自动放入和保存都经过这里，边界与核心校验一致。 */
  private clampPos(id: string, x: number, y: number): { x: number; y: number } {
    const { W, H } = this.roomSize();
    const L = limitsOf(this.productOfInstance(id), W, H);
    return { x: clampInt(x, L.x0, L.x1), y: clampInt(y, L.y0, L.y1) };
  }

  private enterEdit(focusInstance?: string): void {
    const s = this.snap;
    if (!s || this.edit) return;
    const draft = s.room.placements
      .filter((p) => this.instanceItem.has(p.instanceId))
      .map((p) => ({ instanceId: p.instanceId, rotation: num(p.rotation), ...this.clampPos(p.instanceId, num(p.x), num(p.y)) }));
    this.edit = { base: s.room.revision, draft, selected: null, dirty: false };
    this.panel = 'room';
    if (focusInstance) {
      if (draft.some((p) => p.instanceId === focusInstance)) this.edit.selected = focusInstance;
      else this.addToRoom(focusInstance);
    }
    if (!this.op) this.setFeedback('', 'info');
    this.render();
    const target = this.edit.selected ? this.itemHit(this.edit.selected) : null;
    (target ?? this.editTitle).focus({ preventScroll: false });
  }

  private placeFromBag(itemId: string): void {
    const s = this.snap;
    if (!s) return;
    const ids = s.inventory.items.filter((i) => i.itemId === itemId).map((i) => i.instanceId);
    if (!ids.length) return;
    const placed = new Set((this.edit ? this.edit.draft : s.room.placements).map((p) => p.instanceId));
    const target = ids.find((id) => !placed.has(id)) ?? ids[0];
    if (this.edit) {
      this.panel = 'room';
      if (placed.has(target)) this.select(target);
      else this.addToRoom(target);
    } else this.enterEdit(target);
  }

  private addToRoom(id: string): void {
    const ed = this.edit;
    const p = this.productOfInstance(id);
    if (!ed || !p?.placement || ed.draft.some((x) => x.instanceId === id)) return;
    const { W, H } = this.roomSize();
    const offset = (ed.draft.length % 5) * 30 - 60;
    const pos = this.clampPos(id, W / 2 + offset, H * 0.78);
    ed.draft.push({ instanceId: id, rotation: boxOf(p).rotations[0], ...pos });
    ed.selected = id;
    ed.dirty = true;
    this.render();
    this.itemHit(id)?.focus({ preventScroll: true });
  }

  private select(id: string): void {
    if (!this.edit) return;
    this.edit.selected = id;
    this.render();
  }

  private moveSelected(dx: number, dy: number): void {
    const ed = this.edit;
    const p = ed?.selected ? ed.draft.find((x) => x.instanceId === ed.selected) : undefined;
    if (!ed || !p) return;
    const c = this.clampPos(p.instanceId, p.x + dx, p.y + dy);
    if (c.x === p.x && c.y === p.y) return;
    p.x = c.x;
    p.y = c.y;
    ed.dirty = true;
    this.render();
  }

  private rotateSelected(): void {
    const ed = this.edit;
    const p = ed?.selected ? ed.draft.find((x) => x.instanceId === ed.selected) : undefined;
    if (!ed || !p) return;
    const rotations = boxOf(this.productOfInstance(p.instanceId)).rotations;
    if (rotations.length < 2) return;
    const i = rotations.indexOf(num(p.rotation));
    p.rotation = rotations[(i + 1) % rotations.length];
    ed.dirty = true;
    this.render();
  }

  private takeBackSelected(): void {
    const ed = this.edit;
    if (!ed?.selected) return;
    const id = ed.selected;
    ed.draft = ed.draft.filter((x) => x.instanceId !== id);
    ed.selected = null;
    ed.dirty = true;
    this.render();
    this.editTitle.focus({ preventScroll: true });
  }

  private cancelEdit(): void {
    if (!this.edit || this.op?.state === 'sending') return;
    this.endDrag();
    this.edit = null;
    // 保存结果未确认时取消：不再重试，改为读取最新布局对齐。
    const unknownSave = this.op?.command.kind === 'room.save';
    if (unknownSave) this.op = null;
    this.setFeedback(unknownSave ? '已退出布置，正在读取房间的实际布局。' : '已取消布置，房间保持原样。', 'info');
    this.render();
    if (unknownSave) void this.poll();
    this.actionBtns.edit.focus({ preventScroll: true });
  }

  private reloadEdit(): void {
    if (!this.edit || this.op) return;
    this.edit = null;
    this.enterEdit();
  }

  private saveEdit(overwrite: boolean): void {
    const ed = this.edit;
    const s = this.snap;
    if (!ed || !s || this.op) return;
    if (overwrite) ed.base = s.room.revision;
    const placements = ed.draft
      .filter((p) => this.instanceItem.has(p.instanceId))
      .map((p) => ({ instanceId: p.instanceId, rotation: num(p.rotation), ...this.clampPos(p.instanceId, p.x, p.y) }));
    this.act('保存布置', { kind: 'room.save', placements, expectedRoomRevision: ed.base }, () => '布置已保存。');
  }

  private onItemPointerDown(e: PointerEvent, id: string, el: HTMLElement): void {
    this.suppressClick = false;
    if (!this.edit || this.op?.state === 'sending' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const p = this.edit.draft.find((x) => x.instanceId === id);
    const rect = this.room.getBoundingClientRect();
    if (!p || !rect.width || !rect.height) return;
    const { W, H } = this.roomSize();
    if (this.edit.selected !== id) this.select(id);
    this.drag = { id, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, kx: W / rect.width, ky: H / rect.height, moved: false };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已失效时退化为普通点击 */
    }
    e.preventDefault();
  }

  private onItemPointerMove(e: PointerEvent): void {
    const d = this.drag;
    const ed = this.edit;
    if (!d || !ed || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const p = ed.draft.find((x) => x.instanceId === d.id);
    if (!p) return;
    const c = this.clampPos(d.id, d.ox + dx * d.kx, d.oy + dy * d.ky);
    p.x = c.x;
    p.y = c.y;
    // 拖动只改本地草稿并按帧更新位置，保存前不写入业务。
    if (!this.dragRaf)
      this.dragRaf = requestAnimationFrame(() => {
        this.dragRaf = 0;
        if (!this.disposed) this.renderRoom();
      });
  }

  private onItemPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    if (d.moved && this.edit) {
      this.suppressClick = true;
      this.edit.dirty = true;
      this.render();
    }
  }

  private endDrag(): void {
    if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
    this.dragRaf = 0;
    if (this.drag && this.edit) this.edit.dirty = this.edit.dirty || this.drag.moved;
    this.drag = null;
  }
}
