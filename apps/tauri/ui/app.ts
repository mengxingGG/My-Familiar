/* Familiar · 灵伴 Android 前端。
   只通过 MobileBridge 的 request/subscribe 与核心交流：先订阅、再读取快照，按 revision 丢弃迟到的旧快照。
   界面骨架只建一次，之后按快照局部更新，避免流式回复把输入框或表单重置。 */
import type {
  CapabilityId,
  CharacterId,
  MobileApprovalBridge,
  MobileApprovalSnapshot,
  MobileAttachment,
  MobileBridge,
  MobileCapability,
  MobileCharacter,
  MobileConversation,
  MobileMediaPreview,
  MobileMessage,
  MobileProviderKind,
  MobileProviderOption,
  MobileSnapshot,
  MobileTask,
  MobileCommands,
  ProviderSettings,
} from '../../../packages/mobile-contracts/index.ts';
import { LibraryView } from './library.ts';
import { ModelTools } from './model-tools.ts';
import { ContextView } from './context.ts';
import { McpView } from './mcp.ts';
import { CareView } from './care.ts';
import { FeishuView } from './feishu.ts';
import { BackupView } from './backup.ts';
import { PermissionsView } from './permissions.ts';
import { UpdateView } from './updates.ts';
import type { ApprovalChoice } from '../../../packages/mobile-contracts/index.ts';

type Tab = 'home' | 'abilities' | 'settings';
type PageId = 'chat' | 'companion' | 'model' | 'library' | 'context' | 'mcp' | 'care' | 'feishu' | 'permissions' | 'backup';
type SheetId = 'history' | 'capability' | 'confirm' | 'media';
type TaskContext = 'home' | 'chat' | 'list';
type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'busy';
type Layer =
  | { kind: 'tab'; tab: Tab; returnFocus: HTMLElement | null }
  | { kind: 'page'; page: PageId; returnFocus: HTMLElement | null }
  | { kind: 'sheet'; sheet: SheetId; returnFocus: HTMLElement | null };
type RunResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

type CapGroup = 'resident' | 'tasks' | 'senses' | 'other';
type Runtime = NonNullable<MobileSnapshot['runtime']>;

interface ConfirmSpec {
  title: string;
  body: string;
  confirmLabel: string;
  action: () => Promise<unknown>;
  /** 成功后的提示；留空则不提示（比如结果要等快照确认的动作）。 */
  done: string;
  /** 默认是危险操作的砖红按钮；primary 用于“去系统设置”这类需要确认、但不具破坏性的动作。 */
  tone?: 'danger' | 'primary';
}
interface CapGuide {
  name: string;
  group: CapGroup;
  /** 授权方式：系统弹窗，或需要用户到系统设置页亲自打开。 */
  via: 'dialog' | 'settings';
  note: string;
}
interface FormState {
  dirty: boolean;
  /** 只有比这个 revision 新的快照才会回填表单。 */
  floor: number;
  /** 页面每次打开/关闭都会变，迟到的保存结果据此丢弃。 */
  token: number;
  /** 每次输入自增，保存期间又改过就保持“未保存”。 */
  edits: number;
}

/* ---------- 文案与状态映射 ---------- */

const ERROR_REASON: Record<string, string> = {
  UNAVAILABLE: '暂时连不上灵伴，请稍后再试。',
  INVALID_INPUT: '填写的内容不太对，请检查后再试。',
  BUSY: '它还在忙上一件事，稍等一下再试。',
  NOT_FOUND: '找不到这一项了，可能已经被删除。',
  STORAGE: '保存到手机时出了问题，请稍后再试。',
  PROVIDER: '模型服务没有正常回应，请检查服务地址、模型和密钥。',
  CONFLICT: '内容已有新版本，请读取后再试。',
  LIMIT: '内容超过大小上限，请删减或拆分。',
  INVALID_DOCUMENT: '文档格式不正确，请检查后再试。',
  DOCUMENT_EMPTY: '文档没有可提取文字，请将需要的页面作为图片添加。',
  DOCUMENT_PASSWORD: '请先解锁文档后再添加。',
  DOCUMENT_TIMEOUT: '文档解析超时，请拆分后再添加。',
};

const CAP_STATE: Record<MobileCapability['state'], { label: string; tone: Tone }> = {
  unavailable: { label: '暂不可用', tone: 'muted' },
  notGranted: { label: '未授权', tone: 'warn' },
  granted: { label: '已授权', tone: 'ok' },
  disconnected: { label: '已断开', tone: 'bad' },
};
const CAP_STATE_ORDER: ReadonlyArray<MobileCapability['state']> = ['granted', 'notGranted', 'disconnected', 'unavailable'];

const CAP_GUIDE: Record<CapabilityId, CapGuide> = {
  overlay: {
    name: '悬浮窗',
    group: 'resident',
    via: 'settings',
    note: '悬浮窗只决定它能不能出现在桌面和其他应用上方；要不要在后台常驻，在小窝里单独开关。',
  },
  notifications: {
    name: '通知',
    group: 'resident',
    via: 'dialog',
    note: '不允许通知也能常驻，只是通知栏里可能看不到它的常驻提示。',
  },
  battery: {
    name: '电池优化',
    group: 'resident',
    via: 'settings',
    note: '有些手机（例如小米）还有自启动、后台限制等系统策略，需要在系统设置里另外允许。这些属于系统管理，即使都设置好，系统仍可能在资源紧张时关闭它。',
  },
  calendar: { name: '日历', group: 'tasks', via: 'dialog', note: '系统授权决定能否访问日历；是否直接执行由权限管理中的全局模式和白名单决定。' },
  notes: { name: '笔记', group: 'tasks', via: 'dialog', note: '笔记操作遵循全局权限策略；交接给笔记应用后需要核对是否保存。' },
  files: { name: '文件', group: 'tasks', via: 'dialog', note: '没有授权时，它不会读写手机里的文件。' },
  accessibility: {
    name: '无障碍',
    group: 'tasks',
    via: 'settings',
    note: '开启后，灵伴能读取当前屏幕上显示的内容，并可以代你点击、输入和滑动；某一步经你批准后，还可以采集当前应用的画面交给你选的模型来看，不会在后台持续录屏。请只在你需要它帮忙操作手机时开启，不需要时随时可以在系统设置里关闭。',
  },
  camera: {
    name: '相机',
    group: 'senses',
    via: 'dialog',
    note: '在聊天里点相机按钮时，会打开手机自带的相机，相机权限由系统相机自己询问。拍好的照片只放进待发送，点发送后才交给你选的模型；灵伴不会自己在后台拍照。',
  },
  microphone: { name: '麦克风', group: 'senses', via: 'dialog', note: '用于和它语音交流；不授权也可以照常打字聊天。' },
  location: { name: '位置', group: 'senses', via: 'dialog', note: '不授权也不影响聊天，只是它不知道你在哪儿。' },
};
/** 笔记、文件、相机不经 capability.request 申请，界面不给它们放授权或设置按钮；相机权限由系统相机自己处理。 */
const CAP_NOT_REQUESTABLE: ReadonlySet<string> = new Set<CapabilityId>(['notes', 'files', 'camera']);
const CAP_GROUPS: ReadonlyArray<{ id: CapGroup; title: string; hint: string }> = [
  { id: 'resident', title: '常驻与提醒', hint: '让它能出现在桌面上、在通知栏露个脸，少被系统关掉。' },
  { id: 'tasks', title: '帮你做事', hint: '记日程、写笔记、找文件，或在你同意后代你操作手机。' },
  { id: 'senses', title: '相机、语音与位置', hint: '都是可选的，不授权也能照常打字聊天。' },
  { id: 'other', title: '其他', hint: '' },
];
/** 常驻卡片上提示的相关授权，只在未授权或断开时出现。 */
const RESIDENT_HINTS: ReadonlyArray<{ id: CapabilityId; text: string }> = [
  { id: 'overlay', text: '想让它出现在桌面上，需要另外允许悬浮窗。' },
  { id: 'notifications', text: '允许通知后，能在通知栏看到它的常驻状态。' },
  { id: 'battery', text: '允许不受电池优化限制，能减少被系统关掉的情况。' },
];
const ENGINE_STATE: Record<Runtime['engine'], { label: string; tone: Tone }> = {
  starting: { label: '正在醒来', tone: 'busy' },
  ready: { label: '已就绪', tone: 'ok' },
  stopped: { label: '休息中', tone: 'muted' },
  failed: { label: '出了问题', tone: 'bad' },
};

const TASK_STATUS: Record<MobileTask['status'], { label: string; tone: Tone }> = {
  awaitingApproval: { label: '等你确认', tone: 'warn' },
  running: { label: '正在执行', tone: 'busy' },
  requiresUserAction: { label: '等你操作', tone: 'warn' },
  completed: { label: '已完成', tone: 'ok' },
  stopped: { label: '已停止', tone: 'muted' },
  failed: { label: '没有完成', tone: 'bad' },
  unknown: { label: '结果未知', tone: 'bad' },
};
const STOP_LABEL: Partial<Record<MobileTask['status'], string>> = {
  awaitingApproval: '不用了',
  running: '停止',
  requiresUserAction: '取消',
};

interface TaskKindSpec {
  label: string;
  icon: IconName;
  /** “等你确认”时内容预览的小标题。 */
  preview: string;
  /** 各状态下的说明；没有的状态不显示说明。 */
  notes: Partial<Record<MobileTask['status'], string>>;
}
const WRITE_NOTES = (target: string): TaskKindSpec['notes'] => ({
  awaitingApproval: `看看内容对不对，批准后才会写入${target}。`,
  running: `正在写入${target}，需要时可以停止。`,
  requiresUserAction: '请在系统弹出的界面里完成这一步。',
  stopped: '这件事没有继续执行。',
  failed: '没有成功写入，可以在对话里让它再试一次。',
  unknown: `没能确认是否已经写入，请打开${target}核对一下。`,
});
const TASK_KIND: Record<MobileTask['kind'], TaskKindSpec> = {
  calendar: { label: '日历', icon: 'calendar', preview: '将要写入日历的内容', notes: WRITE_NOTES('日历') },
  notes: { label: '笔记', icon: 'note', preview: '将要写入笔记的内容', notes: WRITE_NOTES('笔记') },
  accessibility: {
    label: '手机操作',
    icon: 'access',
    preview: '它打算在手机上做的操作',
    notes: {
      awaitingApproval: '看看它打算怎么操作，批准后才会代你点击、输入、滑动，或采集当前应用的画面交给你选的模型。',
      running: '正在代你操作手机，随时可以停止。',
      requiresUserAction: '请在手机上完成这一步，它会等你。',
      stopped: '这次操作没有继续。',
      failed: '操作没有完成，可以在对话里让它再试一次。',
      unknown: '没能确认操作是否已经完成，请看一下手机上的实际情况。',
    },
  },
  tool: {
    label: '工具',
    icon: 'tool',
    preview: '它打算做的事',
    notes: {
      awaitingApproval: '看看它打算做什么，批准后才会执行。',
      running: '正在执行，需要时可以停止。',
      requiresUserAction: '请在系统弹出的界面里完成这一步。',
      stopped: '这件事没有继续执行。',
      failed: '没有完成，可以在对话里让它再试一次。',
      unknown: '没能确认是否已经执行，请核对一下结果。',
    },
  },
};
const ATTENTION: ReadonlyArray<MobileTask['status']> = ['awaitingApproval', 'requiresUserAction', 'running'];

const PET_LINES = [
  '嘿嘿，被你发现啦',
  '{name}蹭了蹭你的手心',
  '我一直在这儿哦',
  '今天也辛苦啦',
  '再摸一下下～',
  '{name}开心地晃了晃',
];
const SUGGESTIONS = ['今天有点累，陪我聊聊吧', '给我讲个睡前小故事', '帮我把明天要做的事理一理'];

/* ---------- 图标（常量字符串，不拼接任何外部数据） ---------- */

const ICONS = {
  home: '<path d="M4 11 12 4.5 20 11"/><path d="M6 9.5V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9.5"/>',
  chat: '<path d="M7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V15A2.5 2.5 0 0 1 5 12.5v-6A2.5 2.5 0 0 1 7.5 4z"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M10.5 17.5h3"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevron: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  send: '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2.2"/>',
  list: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  trash: '<path d="M5 7h14M10 4h4M7 7l.8 11.2A2 2 0 0 0 9.8 20h4.4a2 2 0 0 0 2-1.8L17 7"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  note: '<path d="M6.5 4h8L19 8.5V18a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M14 4v5h5M8 13h8M8 16.5h5"/>',
  access: '<circle cx="12" cy="5" r="1.8"/><path d="M5 8.5c2.3.8 4.6 1.2 7 1.2s4.7-.4 7-1.2M12 9.7V14m0 0-3 6m3-6 3 6"/>',
  tool: '<path d="M14.8 4.2a4.6 4.6 0 0 0-4.4 6L4.6 16a2 2 0 0 0 2.8 2.8l5.8-5.8a4.6 4.6 0 0 0 6-4.4l-2.8 2.8-2.6-.4-.4-2.6z"/>',
  check: '<path d="M5.5 12.5 10 17l8.5-9.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path d="M4 4l16 16"/>',
  down: '<path d="M12 5v13M6.5 12.5 12 18l5.5-5.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  overlay: '<rect x="3.5" y="4" width="11" height="16.5" rx="2.5"/><path d="M7.5 17h3"/><circle cx="17" cy="9" r="3.8"/><path d="M15.7 8.6h.01M18.3 8.6h.01"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5L19 18H5z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  battery: '<rect x="3" y="7.5" width="15.5" height="9" rx="2.2"/><path d="M21 10.5v3M11.5 9.5l-2 2.7h3l-2 2.8"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21M9 21h6"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10" r="2.3"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 10h17"/>',
  power: '<path d="M12 3.8v7.4"/><path d="M7.3 6.6a7 7 0 1 0 9.4 0"/>',
  collapse: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  clip: '<path d="M19 11.2 12.4 17.8a4.6 4.6 0 0 1-6.5-6.5l7.2-7.2a3.1 3.1 0 0 1 4.4 4.4l-7.1 7.1a1.55 1.55 0 0 1-2.2-2.2l6.5-6.5"/>',
  paste: '<path d="M9 4H6a2 2 0 0 0-2 2v14h16V6a2 2 0 0 0-2-2h-3"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="m7 17 3-4 3 3 2-2 3 3"/><circle cx="15" cy="10" r="1"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="M4 17.5l5-4.5 3.5 3 3-2.5 4.5 4"/>',
  camera: '<path d="M4.5 8.5a2 2 0 0 1 2-2h1.8l1.4-2h4.6l1.4 2h1.8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.6" r="3.3"/><path d="M17 9.5h.01"/>',
} as const;
type IconName = keyof typeof ICONS;

const CAP_ICON: Record<CapabilityId, IconName> = {
  calendar: 'calendar',
  notes: 'note',
  accessibility: 'access',
  overlay: 'overlay',
  notifications: 'bell',
  battery: 'battery',
  microphone: 'mic',
  location: 'pin',
  files: 'folder',
  camera: 'camera',
};

/* ---------- DOM 小工具 ---------- */

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'on') {
        for (const [type, fn] of Object.entries(value as Record<string, (e: Event) => void>)) el.addEventListener(type, fn);
      } else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

function icon(name: IconName, cls = 'icon'): HTMLElement {
  const span = document.createElement('span');
  span.className = cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${ICONS[name]}</svg>`;
  return span;
}

function q<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Familiar UI: missing ${selector}`);
  return found;
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function show(el: HTMLElement, visible: boolean): void {
  if (el.hidden === visible) el.hidden = !visible;
}

function setDisabled(el: HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement, disabled: boolean): void {
  if (el.disabled !== disabled) el.disabled = disabled;
}

function setCurrent(el: HTMLElement, current: boolean): void {
  if (current) el.setAttribute('aria-current', 'page');
  else el.removeAttribute('aria-current');
}

/** 按 key 复用节点：已有节点只更新内容，不重建，焦点和滚动都保留。 */
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

function activeElement(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ---------- 数据小工具 ---------- */

function errorText(error: unknown, action: string): string {
  // 只按错误码给出友好原因，绝不展示原始 message，避免泄露密钥或网络响应内容。
  const code =
    error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  return `${action}：${ERROR_REASON[code] ?? '出了点小问题，请再试一次。'}`;
}

function safeCharacterId(id: string): string {
  return /^[a-z0-9_-]+$/i.test(id) ? id : 'mori';
}

/** 快照给的形象地址只接受相对路径或 http(s)/宿主资源地址；缺失或可疑时回退到打包目录里的默认图。 */
function characterImage(id: string, image?: string): string {
  const src = typeof image === 'string' ? image.trim() : '';
  if (src && !/[\s"'<>\\]/.test(src) && !src.startsWith('//')) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src);
    if (!scheme || /^(https?|asset|tauri)$/i.test(scheme[1])) return src;
  }
  return `./characters/${safeCharacterId(id)}/idle-0.svg`;
}

function imageOf(s: MobileSnapshot, id: string): string {
  return characterImage(id, characterOf(s, id)?.image);
}

/* ---------- 模型类型 ---------- */

/** 旧宿主没有 providers 时返回空数组，界面按单一兼容接口展示。 */
function providerOptions(s: MobileSnapshot): MobileProviderOption[] {
  return Array.isArray(s.providers) ? s.providers : [];
}

function activeKind(s: MobileSnapshot): MobileProviderKind {
  return s.provider.kind ?? 'compatible';
}

function providerOption(s: MobileSnapshot, kind: string | null): MobileProviderOption | undefined {
  return kind ? providerOptions(s).find((p) => p.id === kind) : undefined;
}

function providerName(s: MobileSnapshot, kind: string | null): string {
  return providerOption(s, kind)?.name.trim() || '兼容接口';
}

/** 比较地址时只忽略首尾空白和末尾斜杠，其余差异都算换了地址。 */
function sameUrl(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function kindMark(name: string): string {
  const first = Array.from(name.trim())[0] ?? '?';
  return first.toUpperCase();
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (Math.abs(diff) < 60_000) return '刚刚';
  if (diff > 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return `今天 ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay(d, new Date()) ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return '早上好';
  if (hour >= 11 && hour < 14) return '中午好';
  if (hour >= 14 && hour < 18) return '下午好';
  if (hour >= 18 && hour < 23) return '晚上好';
  return '夜深了';
}

function isConfigured(s: MobileSnapshot): boolean {
  return Boolean(s.provider.baseUrl.trim() && s.provider.model.trim());
}

function activeConversation(s: MobileSnapshot): MobileConversation | null {
  return s.conversations.find((c) => c.id === s.activeConversationId) ?? null;
}

function sortedConversations(s: MobileSnapshot): MobileConversation[] {
  const time = (c: MobileConversation) => Date.parse(c.updatedAt) || 0;
  return [...s.conversations].sort((a, b) => time(b) - time(a));
}

function attentionTasks(s: MobileSnapshot): MobileTask[] {
  return s.tasks.filter((t) => ATTENTION.includes(t.status));
}

function taskKind(kind: string): TaskKindSpec {
  return Object.prototype.hasOwnProperty.call(TASK_KIND, kind) ? TASK_KIND[kind as MobileTask['kind']] : TASK_KIND.tool;
}

function characterOf(s: MobileSnapshot, id: string): MobileCharacter | undefined {
  return s.characters.find((c) => c.id === id);
}

function petName(s: MobileSnapshot): string {
  return s.companion.nickname.trim() || characterOf(s, s.companion.characterId)?.name || '灵伴';
}

function conversationTitle(c: MobileConversation | null): string {
  return c?.title.trim() || '新的对话';
}

function capGuide(id: string): CapGuide | undefined {
  return Object.prototype.hasOwnProperty.call(CAP_GUIDE, id) ? CAP_GUIDE[id as CapabilityId] : undefined;
}

function capIcon(id: string): IconName {
  return Object.prototype.hasOwnProperty.call(CAP_ICON, id) ? CAP_ICON[id as CapabilityId] : 'info';
}

function capStateInfo(c: MobileCapability): { label: string; tone: Tone } {
  return CAP_STATE[c.state] ?? CAP_STATE.unavailable;
}

interface CapActionSpec {
  /** 卡片上的短文案。 */
  label: string;
  /** 详情弹层里的完整文案。 */
  sheetLabel: string;
  /** 已授权时只是打开系统设置供查看或撤回，不是申请。 */
  manage: boolean;
}

/** 按核心状态决定操作：未授权 / 已断开可以申请；已授权的已知系统权限可以去系统设置查看；
    暂不可用、笔记与文件没有按钮。 */
function capAction(c: MobileCapability): CapActionSpec | null {
  if (CAP_NOT_REQUESTABLE.has(c.id)) return null;
  const guide = capGuide(c.id);
  if (c.state === 'notGranted') {
    const label = guide?.via === 'settings' ? '去系统设置' : '去授权';
    return { label, sheetLabel: label, manage: false };
  }
  if (c.state === 'disconnected') return { label: '重新连接', sheetLabel: '重新连接', manage: false };
  if (c.state === 'granted' && guide) return { label: '系统设置', sheetLabel: '在系统设置中查看', manage: true };
  return null;
}

function capExplain(c: MobileCapability): string {
  const viaSettings = capGuide(c.id)?.via === 'settings';
  if (c.id === 'camera') {
    // 只说明调用系统相机；相机权限由系统相机自己询问，这里没有授权按钮。
    switch (c.state) {
      case 'granted':
        return '可以在聊天输入框旁点相机按钮拍照。相机权限由系统相机自己管理，想查看或关闭可以到手机的系统设置里。';
      case 'notGranted':
        return '这里不用单独授权。点相机按钮时会打开系统相机，由它询问相机权限；拒绝也不影响其他功能。';
      case 'disconnected':
        return '暂时打不开系统相机，稍后再试试；选图片和文本文件、打字聊天照常可用。';
      default:
        return '这台手机或当前版本暂时不能调用系统相机，聊天里不会出现拍照按钮。';
    }
  }
  if (CAP_NOT_REQUESTABLE.has(c.id)) {
    switch (c.state) {
      case 'granted':
        return '已经可以使用。想撤销的话，可以到手机系统设置的应用权限里关闭。';
      case 'notGranted':
        return '这一项不在这里单独申请，用到时会按需询问你；拒绝也不影响其他功能。';
      case 'disconnected':
        return '现在暂时连不上，稍后再看看；其他功能照常可用。';
      default:
        return '这台设备或当前版本还不支持这项能力，暂时无法开启。';
    }
  }
  switch (c.state) {
    case 'notGranted':
      return viaSettings
        ? '点“去系统设置”会打开手机的设置页，需要你在那里亲自打开开关。不想开也没关系，其他功能照常可用。'
        : '点“去授权”后手机会弹出系统询问，允许或拒绝都由你决定；拒绝后其他功能照常可用。';
    case 'granted':
      return capGuide(c.id)
        ? '已经授权。点“在系统设置中查看”会打开手机的设置页，要不要关闭由你在那里决定；回到这里后按实际状态显示。'
        : '已经授权。想撤销的话，可以随时到手机的系统设置里关闭。';
    case 'disconnected':
      if (c.id === 'accessibility') return '无障碍开关已开启，但服务尚未连接。到系统设置查看；如果显示“无法运行”，先关闭再重新开启，回到这里后会更新状态。';
      return viaSettings
        ? '之前打开过，但现在连接中断了，可能是在系统设置里被关掉了。可以重新打开。'
        : '之前授权过，但现在连接中断了，可以尝试重新连接。';
    default:
      return '这台设备或当前版本还不支持这项能力，暂时无法开启。';
  }
}

/** 常驻开关的含义：后台服务在跑，或者正在启动，都算“开着”，按钮应提供停止。 */
function runtimeOn(r: Runtime): boolean {
  return r.running || r.engine === 'starting';
}

function residentView(r: Runtime, name: string): { label: string; tone: Tone; lead: string } {
  if (r.engine === 'starting') return { label: '正在启动', tone: 'busy', lead: `${name}正在醒来，马上就好。` };
  if (r.running) {
    if (r.engine === 'ready') return { label: '常驻中', tone: 'ok', lead: `${name}在后台陪着你，离开应用也不会走开。` };
    if (r.engine === 'failed') return { label: '出了问题', tone: 'bad', lead: '后台服务还开着，但伙伴没能正常运行。可以停止后重新开启。' };
    return { label: '正在准备', tone: 'busy', lead: '后台服务已经开启，伙伴还没准备好。' };
  }
  if (r.engine === 'failed') return { label: '没能启动', tone: 'bad', lead: '上次开启没有成功，可以再试一次。' };
  return { label: '未开启', tone: 'muted', lead: `开启后，离开应用时${name}也能留在后台陪你。` };
}

interface BackgroundWork {
  replying: boolean;
  /** 等你批准的任务：runtime.set(false) 会连同当前回复一起取消。 */
  approvals: number;
  tasks: number;
}

/** 停止常驻会一并停下的东西：正在进行的回复、等你批准的任务和执行中的任务。 */
function backgroundWork(s: MobileSnapshot): BackgroundWork {
  return {
    replying: Boolean(s.activeReply),
    approvals: s.tasks.filter((t) => t.status === 'awaitingApproval').length,
    tasks: s.tasks.filter((t) => t.status === 'running' || t.status === 'requiresUserAction').length,
  };
}

/* ---------- 附件 ---------- */

interface MediaLimits {
  max: number;
  image: number;
  text: number;
}

/** 优先用快照给的限制；缺失或不合理时用约定的默认值（8 个、图片 12 MiB、文本 400000 字节）。 */
function mediaLimits(s: MobileSnapshot | null): MediaLimits {
  const m = s?.media;
  const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
  return { max: pos(m?.maxAttachments, 8), image: pos(m?.maxBytes, 12 * 1024 * 1024), text: pos(m?.maxTextBytes, 400000) };
}

/** 快照没有 media、或宿主说不能选时，界面不出现添加入口。 */
function canChoose(s: MobileSnapshot | null): boolean {
  return Boolean(s && s.media && s.media.choose === true);
}

/** 只认 media.camera === true；不从文件选择或能力状态推断能不能拍照。 */
function canCamera(s: MobileSnapshot | null): boolean {
  return Boolean(s && s.media && s.media.camera === true);
}

type MediaSource = 'files' | 'camera' | 'clipboard';

function isAttachment(a: unknown): a is MobileAttachment {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return typeof x.id === 'string' && x.id !== '' && typeof x.name === 'string';
}

function attachmentsOf(m: MobileMessage): MobileAttachment[] {
  return Array.isArray(m.attachments) ? m.attachments.filter(isAttachment) : [];
}

function fileKindLabel(a: MobileAttachment): string {
  return a.kind === 'image' ? '图片' : a.kind === 'text' ? '文本文件' : '文件';
}

function fileName(a: MobileAttachment): string {
  return a.name.trim() || (a.kind === 'image' ? '未命名图片' : '未命名文件');
}

function formatBytes(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function fileMeta(a: MobileAttachment): string {
  const size = formatBytes(a.bytes);
  return size ? `${fileKindLabel(a)} · ${size}` : fileKindLabel(a);
}

function overLimit(a: MobileAttachment, lim: MediaLimits): boolean {
  if (typeof a.bytes !== 'number' || !Number.isFinite(a.bytes)) return false;
  return a.bytes > (a.kind === 'image' ? lim.image : lim.text);
}

/** 只接受 PNG/JPEG/WebP/GIF 的 base64 data URL，其它一律当作没有图片预览。 */
function safeDataUrl(v: unknown): string | null {
  return typeof v === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null;
}

/** 列表里的一行摘要：有文字用文字，只有附件时写附件。 */
function messageSummary(m: MobileMessage): string {
  const text = m.text.trim();
  if (text) return text;
  const files = attachmentsOf(m);
  if (!files.length) return '';
  if (files.length === 1) return `［${fileKindLabel(files[0])}］${fileName(files[0])}`;
  return `［${files.length} 个附件］`;
}

/* ---------- 入口 ---------- */

export function mountApp(bridge: MobileBridge): () => void {
  const app = new FamiliarApp(bridge);
  app.start();
  return () => app.destroy();
}

class FamiliarApp {
  private readonly bridge: MobileBridge;
  private readonly root: HTMLElement;
  private readonly ownsRoot: boolean;
  private readonly uid = `fam-${Math.random().toString(36).slice(2, 8)}`;

  private snap: MobileSnapshot | null = null;
  private booted = false;
  private fatal: string | null = null;
  private loading = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private readonly cleanups: Array<() => void> = [];
  private readonly timers = new Set<number>();
  private rafId = 0;
  private popFallback = 0;
  private readonly pending = new Set<string>();
  private layers: Layer[] = [];

  private confirmSpec: ConfirmSpec | null = null;
  private confirmToken = 0;
  private capabilityId: CapabilityId | null = null;

  private chatConversationId: string | null | undefined = undefined;
  /** 非当前会话的输入草稿，只在内存里；null 键是“还没有会话”时的草稿。当前会话的草稿就是输入框本身。 */
  private readonly drafts = new Map<string | null, string>();
  /** 正在发送的那句话属于哪个会话；以 null 发出、核心新建会话后会改成新会话的 id。 */
  private outgoing: { key: string | null } | null = null;
  /** 以 null 发送时记下当时已有的会话；之后从“无会话”切到一个不在其中的新会话，视为同一段对话延续，输入框不换。 */
  private adoptFrom: Set<string> | null = null;
  /** 当前会话待发送的附件（和输入框一样属于眼前这段会话）。 */
  private tray: MobileAttachment[] = [];
  /** 非当前会话的待发送附件，与 drafts 同一套键，只在内存里。 */
  private readonly trayDrafts = new Map<string | null, MobileAttachment[]>();
  /** 系统选择器或系统相机打开时所属的会话和来源；两者共用一把锁，回来只放进这段会话。 */
  private chooseOrigin: { key: string | null; source: MediaSource } | null = null;
  /** 预览结果只在内存里缓存少量几项，卸载即丢弃。 */
  private readonly previewCache = new Map<string, MobileMediaPreview>();
  private readonly previewInflight = new Map<string, Promise<MobileMediaPreview>>();
  private mediaView: {
    att: MobileAttachment;
    /** 从待发送托盘打开时记下所属会话，可以在预览里移除。 */
    trayKey: string | null | undefined;
    status: 'loading' | 'ready' | 'none' | 'error' | 'unsupported';
    preview: MobileMediaPreview | null;
    error: string;
  } | null = null;
  private mediaToken = 0;
  private chatPinned = true;
  private reply: { conversationId: string; messageId: string } | null = null;
  private continueId: string | null = null;
  private petTaps = 0;
  private bubbleTimer = 0;
  private capsSignature: string | null = null;
  /** 正在请求的常驻目标（请求未返回时用来写按钮文案）。 */
  private runtimeTarget: boolean | null = null;
  /** 请求已被接受、但快照还没体现的常驻目标；只认点击之后的新快照，不自行宣布结果。 */
  private runtimeIntent: { enabled: boolean; revision: number; timer: number } | null = null;
  private runtimeSlow = false;
  private runtimeSig: string | null = null;
  /** 关闭一层后要聚焦的控件（从设置跳到常驻卡片、在预览里移除附件时用）；scroll 表示顺便滚到眼前。 */
  private focusAfterPop: { el: HTMLElement; scroll: boolean } | null = null;

  private readonly companionForm: FormState = { dirty: false, floor: -1, token: 0, edits: 0 };
  private readonly modelForm: FormState = { dirty: false, floor: -1, token: 0, edits: 0 };
  /** 模型页上正在查看的类型；旧宿主没有类型列表时为 null。只在页面打开期间有意义。 */
  private modelKind: MobileProviderKind | null = null;
  /** 本次打开页面期间、各类型改过但未保存的地址和模型；密钥从不跨类型保留。关闭页面即丢弃。 */
  private readonly kindDrafts = new Map<string, { baseUrl: string; model: string }>();
  /** 打开伙伴页后第一次回填时，把选中的形象滚到形象架中间。 */
  private shelfScrollPending = false;

  private readonly caches = {
    messages: new Map<string, HTMLElement>(),
    chatTasks: new Map<string, HTMLElement>(),
    homeTasks: new Map<string, HTMLElement>(),
    allTasks: new Map<string, HTMLElement>(),
    history: new Map<string, HTMLElement>(),
    chars: new Map<string, HTMLElement>(),
    kinds: new Map<string, HTMLElement>(),
    tray: new Map<string, HTMLElement>(),
  };

  /* 骨架引用 */
  private ribbon!: HTMLElement;
  private frame!: HTMLElement;
  private shell!: HTMLElement;
  private views!: Record<Tab, HTMLElement>;
  private dockButtons!: Record<Tab | 'chat', HTMLButtonElement>;
  private dockBadge!: HTMLElement;
  private pages!: Record<PageId, HTMLElement>;
  private pageHeadings!: Record<PageId, HTMLElement>;
  private libraryView!: LibraryView;
  private mcpView!: McpView;
  private mcpRow!: HTMLElement;
  private careView!: CareView;
  private careRow!: HTMLElement;
  private backupView!: BackupView;
  private backupRow!: HTMLElement;
  private permissionView!: PermissionsView;
  private permissionRow!: HTMLElement;
  private feishuView!: FeishuView;
  private feishuRow!: HTMLElement;
  private modelTools!: ModelTools;
  private contextView!: ContextView;
  private contextButton!: HTMLButtonElement;
  private libraryRow!: HTMLElement;
  private sheets!: Record<SheetId, HTMLElement>;
  private readonly sheetHeadings: Partial<Record<SheetId, HTMLElement>> = {};
  private scrim!: HTMLElement;
  private toasts!: HTMLElement;
  private announcer!: HTMLElement;

  private homeStage!: HTMLElement;
  private homePetBtn!: HTMLButtonElement;
  private petBubble!: HTMLElement;
  private homeName!: HTMLElement;
  private homeDot!: HTMLElement;
  private homeStatus!: HTMLElement;
  private setupNotice!: HTMLElement;
  private retryCard!: HTMLElement;
  private retryText!: HTMLElement;
  private retryBtn!: HTMLButtonElement;
  private attentionSection!: HTMLElement;
  private attentionList!: HTMLElement;
  private continueBtn!: HTMLButtonElement;
  private continueKicker!: HTMLElement;
  private continueTitle!: HTMLElement;
  private continueText!: HTMLElement;
  private capsChips!: HTMLElement;
  private stageBadge!: HTMLElement;

  private resCard!: HTMLElement;
  private resChip!: HTMLElement;
  private resLead!: HTMLElement;
  private resFacts!: Record<'service' | 'engine' | 'overlay', { dot: HTMLElement; text: HTMLElement }>;
  private resDetail!: HTMLElement;
  private resHints!: Map<CapabilityId, HTMLElement>;
  private resNote!: HTMLElement;
  private resToggle!: HTMLButtonElement;
  private resFoot!: HTMLElement;
  private startupBox!: HTMLElement;
  private startupToggle!: HTMLInputElement;
  private startupStatus!: HTMLElement;

  private capGroups!: Record<CapGroup, { section: HTMLElement; list: HTMLElement; cache: Map<string, HTMLElement> }>;
  private capMissing!: HTMLElement;
  private capEmpty!: HTMLElement;
  private taskList!: HTMLElement;
  private taskEmpty!: HTMLElement;

  private setAvatar!: HTMLImageElement;
  private setAvatarWrap!: HTMLElement;
  private setName!: HTMLElement;
  private setCompanionSub!: HTMLElement;
  private setModelText!: HTMLElement;
  private setModeText!: HTMLElement;
  private updateView!: UpdateView;
  private homeUpdateView!: UpdateView;
  private setResidentBlock!: HTMLElement;
  private setResidentText!: HTMLElement;

  private chatAvatar!: HTMLImageElement;
  private chatAvatarWrap!: HTMLElement;
  private chatStatus!: HTMLElement;
  private chatScroll!: HTMLElement;
  private chatEmpty!: HTMLElement;
  private chatEmptyStage!: HTMLElement;
  private chatEmptyTitle!: HTMLElement;
  private msgList!: HTMLElement;
  private chatTasks!: HTMLElement;
  private jumpBtn!: HTMLButtonElement;
  private chatNewBtn!: HTMLButtonElement;
  private chatHistoryBtn!: HTMLButtonElement;
  private composerNotice!: HTMLElement;
  private chatEmptyHint!: HTMLElement;
  private attachBtn!: HTMLButtonElement;
  private cameraBtn!: HTMLButtonElement;
  private pasteBtn!: HTMLButtonElement;
  private sourceGroup!: HTMLElement;
  private trayBox!: HTMLElement;
  private trayCount!: HTMLElement;
  private trayList!: HTMLElement;
  private composer!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private voiceBar!: HTMLElement;
  private voiceStatus!: HTMLElement;
  private voiceFinish!: HTMLButtonElement;
  private voiceStop!: HTMLButtonElement;
  private voiceButtons!: HTMLElement;
  private voiceSettings!: HTMLElement;
  private voiceForm!: HTMLFormElement;
  private voiceDirty = false;
  private liveForm!: HTMLFormElement;
  private liveDirty = false;
  private wakeForm!: HTMLFormElement;
  private wakeDirty = false;
  private localVoices: MobileCommands['voice.local.catalog']['result'] | undefined;
  private localVoiceChoice = '';
  private localVoiceOptionsKey = '';
  private petSettings!: HTMLElement;
  private petForm!: HTMLFormElement;
  private dockForm!: HTMLFormElement;
  private petStatus!: HTMLElement;
  private petDirty = false;
  private dockDirty = false;
  private dictationSeen = new Set<string>();
  private voiceConversation = false;

  private compStage!: HTMLElement;
  private compStageName!: HTMLElement;
  private compStageDesc!: HTMLElement;
  private charCount!: HTMLElement;
  private charGrid!: HTMLElement;
  private nickInput!: HTMLInputElement;
  private personaInput!: HTMLTextAreaElement;
  private personaCount!: HTMLElement;
  private compStatus!: HTMLElement;
  private compSave!: HTMLButtonElement;

  private modelCard!: HTMLElement;
  private modelCardTitle!: HTMLElement;
  private modelCardText!: HTMLElement;
  private modelGuard!: HTMLElement;
  private kindSection!: HTMLElement;
  private kindGrid!: HTMLElement;
  private kindNote!: HTMLElement;
  private urlHelp!: HTMLElement;
  private clearKeyText!: HTMLElement;
  private urlInput!: HTMLInputElement;
  private modelInput!: HTMLInputElement;
  private keyInput!: HTMLInputElement;
  private keyToggle!: HTMLButtonElement;
  private keyHint!: HTMLElement;
  private modelStatus!: HTMLElement;
  private modelSave!: HTMLButtonElement;
  private clearKeyRow!: HTMLElement;
  private clearKeyBtn!: HTMLButtonElement;

  private historyList!: HTMLElement;
  private historyEmpty!: HTMLElement;
  private historyNew!: HTMLButtonElement;
  private capSheetChip!: HTMLElement;
  private capSheetIcon!: HTMLElement;
  private capSheetDesc!: HTMLElement;
  private capSheetDetail!: HTMLElement;
  private capSheetExplain!: HTMLElement;
  private capSheetNote!: HTMLElement;
  private capSheetAction!: HTMLButtonElement;
  private confirmBody!: HTMLElement;
  private confirmError!: HTMLElement;
  private confirmOk!: HTMLButtonElement;
  private confirmCancel!: HTMLButtonElement;
  private mediaMeta!: HTMLElement;
  private mediaStage!: HTMLElement;
  private mediaImg!: HTMLImageElement;
  private mediaText!: HTMLElement;
  private mediaState!: HTMLElement;
  private mediaStateText!: HTMLElement;
  private mediaRetry!: HTMLButtonElement;
  private mediaNote!: HTMLElement;
  private mediaRemove!: HTMLButtonElement;

  constructor(bridge: MobileBridge) {
    this.bridge = bridge;
    const existing = document.getElementById('familiar-root');
    this.ownsRoot = !existing;
    this.root = existing ?? document.body.appendChild(h('div', { id: 'familiar-root' }));
    this.root.classList.add('app');
  }

  /* ---------- 生命周期 ---------- */

  start(): void {
    this.build();
    this.listen(window, 'popstate', (e) => this.onPopState(e as PopStateEvent));
    this.listen(document, 'keydown', (e) => this.onKeydown(e as KeyboardEvent));
    this.listen(window, 'resize', () => this.syncViewport());
    const vv = window.visualViewport;
    if (vv) {
      this.listen(vv, 'resize', () => this.syncViewport());
      this.listen(vv, 'scroll', () => this.syncViewport());
    }
    const prior = history.state && typeof history.state === 'object' ? (history.state as Record<string, unknown>) : {};
    history.replaceState({ ...prior, familiarDepth: 0 }, '');
    this.syncViewport();
    this.applyLayers();
    this.render();

    try {
      this.unsubscribe = this.bridge.subscribe((s) => this.accept(s));
    } catch {
      this.fatal = '暂时连不上灵伴，请稍后重试。';
    }
    void this.loadSnapshot();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.libraryView?.dispose();
    this.mcpView?.dispose();
    this.careView?.dispose();
    this.feishuView?.dispose();
    this.modelTools?.dispose();
    this.contextView?.dispose();
    try {
      this.unsubscribe?.();
    } catch {
      /* 取消订阅失败不影响卸载 */
    }
    this.unsubscribe = null;
    for (const fn of this.cleanups.splice(0)) fn();
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    window.clearTimeout(this.popFallback);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.keyInput) this.keyInput.value = '';
    this.mediaView = null;
    this.mediaToken += 1;
    this.previewCache.clear();
    this.previewInflight.clear();
    this.tray = [];
    this.trayDrafts.clear();
    this.chooseOrigin = null;
    if (this.ownsRoot) this.root.remove();
    else {
      this.root.replaceChildren();
      for (const key of Object.keys(this.root.dataset)) delete this.root.dataset[key];
      this.root.style.removeProperty('--app-h');
      this.root.style.removeProperty('--app-top');
    }
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.cleanups.push(() => target.removeEventListener(type, fn));
  }

  private later(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private cancelLater(id: number): void {
    if (!id) return;
    window.clearTimeout(id);
    this.timers.delete(id);
  }

  private syncViewport(): void {
    // 软键盘弹出时以可视区域为准，输入框始终贴在键盘上方。
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    const top = vv ? Math.max(0, vv.offsetTop) : 0;
    this.root.style.setProperty('--app-h', `${Math.round(height)}px`);
    this.root.style.setProperty('--app-top', `${Math.round(top)}px`);
    if (this.chatPinned && this.isPageOpen('chat')) this.scrollChatToBottom();
  }

  /* ---------- 快照 ---------- */

  private async loadSnapshot(): Promise<void> {
    if (this.loading || this.disposed) return;
    this.loading = true;
    if (!this.snap) this.fatal = null;
    this.schedule();
    try {
      const s = await this.bridge.request('snapshot.get', undefined);
      this.accept(s);
    } catch {
      if (!this.disposed && !this.snap) this.fatal = '暂时没能读取到灵伴的状态，请稍后重试。';
    } finally {
      this.loading = false;
      if (!this.disposed) this.schedule();
    }
  }

  private accept(s: MobileSnapshot): void {
    if (this.disposed || !s || typeof s !== 'object') return;
    if (s.protocolVersion !== 1) {
      if (!this.snap) this.fatal = '灵伴核心和这个界面的版本不一致，请更新应用后再试。';
      this.schedule();
      return;
    }
    if (this.snap && s.revision <= this.snap.revision) return;
    if (!this.snap && s.voice?.dictation) this.dictationSeen.add(s.voice.dictation.id);
    this.snap = s;
    this.fatal = null;
    this.schedule();
  }

  private schedule(): void {
    if (this.rafId || this.disposed) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.render();
    });
  }

  private busy(key: string): boolean {
    return this.pending.has(key);
  }

  /** 统一的忙碌保护：同一个 key 正在进行时直接忽略重复点击。 */
  private async run<T>(key: string, task: () => Promise<T>, failLabel?: string): Promise<RunResult<T> | null> {
    if (this.disposed || this.pending.has(key)) return null;
    this.pending.add(key);
    this.schedule();
    try {
      return { ok: true, value: await task() };
    } catch (error) {
      if (failLabel && !this.disposed) this.toast(errorText(error, failLabel), 'error');
      return { ok: false, error };
    } finally {
      this.pending.delete(key);
      if (!this.disposed) this.schedule();
    }
  }

  /* ---------- 骨架 ---------- */

  private build(): void {
    this.ribbon = h(
      'div',
      { class: 'ribbon', role: 'note', hidden: true },
      h('b', { text: '预览 · 示例数据' }),
      h('span', { text: '这里的对话、常驻状态、能力和任务都是演示内容，不会读写你的手机。' }),
    );
    this.views = {
      home: this.buildHome(),
      abilities: this.buildAbilities(),
      settings: this.buildSettings(),
    };
    const dock = this.buildDock();
    this.shell = h(
      'div',
      { class: 'shell' },
      h('div', { class: 'views' }, this.views.home, this.views.abilities, this.views.settings),
      dock,
    );
    const chat = this.buildChat();
    const companion = this.buildCompanion();
    const model = this.buildModel();
    this.libraryView = new LibraryView(this.bridge, this.backButton(), spec => this.openConfirm(spec), (text, tone) => this.toast(text, tone));
    this.contextView = new ContextView(this.bridge, this.backButton());
    this.mcpView = new McpView(this.bridge, this.backButton(), spec => this.openConfirm(spec));
    this.careView = new CareView(this.bridge, this.backButton(), spec => this.openConfirm(spec));
    this.backupView = new BackupView(this.bridge,this.backButton(),spec=>this.openConfirm(spec));
    this.permissionView = new PermissionsView(this.bridge, this.backButton());
    this.feishuView = new FeishuView(this.bridge, this.backButton(), spec => this.openConfirm(spec));
    this.pages = { chat: chat.page, companion: companion.page, model: model.page, library: this.libraryView.page, context: this.contextView.page, mcp: this.mcpView.page, care: this.careView.page, feishu: this.feishuView.page, permissions: this.permissionView.page, backup: this.backupView.page };
    this.pageHeadings = { chat: chat.heading, companion: companion.heading, model: model.heading, library: this.libraryView.heading, context: this.contextView.heading, mcp: this.mcpView.heading, care: this.careView.heading, feishu: this.feishuView.heading, permissions: this.permissionView.heading, backup: this.backupView.heading };

    this.scrim = h('div', { class: 'scrim', hidden: true, 'aria-hidden': 'true', on: { click: () => this.back() } });
    this.sheets = {
      history: this.buildHistorySheet(),
      capability: this.buildCapabilitySheet(),
      confirm: this.buildConfirmDialog(),
      media: this.buildMediaSheet(),
    };
    this.toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    this.announcer = h('div', { class: 'sr-only', 'aria-live': 'polite' });

    this.frame = h(
      'div',
      { class: 'frame' },
      this.shell,
      chat.page,
      companion.page,
      model.page,
      this.libraryView.page,
      this.contextView.page,
      this.mcpView.page,
      this.careView.page,
      this.feishuView.page,
      this.permissionView.page,
      this.backupView.page,
      this.scrim,
      this.sheets.history,
      this.sheets.capability,
      this.sheets.media,
      this.sheets.confirm,
      this.toasts,
    );
    this.voiceStatus = h('span', { role: 'status' });
    this.voiceFinish = h('button', { type: 'button', class: 'quiet', text: '完成录音', on: { click: () => void this.voiceCommand('voice.finish') } });
    this.voiceStop = h('button', { type: 'button', class: 'quiet danger', text: '停止语音', on: { click: () => void this.voiceCommand('voice.stop') } });
    this.voiceBar = h('div', { class: 'voice-bar', hidden: true }, this.voiceStatus, this.voiceFinish, this.voiceStop);
    this.root.replaceChildren(this.ribbon, this.voiceBar, this.frame, this.announcer);
    this.root.dataset.ready = 'false';
  }

  private buildStage(kind: 'home' | 'mini'): HTMLElement {
    return h(
      'div',
      { class: `stage stage-${kind}` },
      h('span', { class: 'orbit', 'aria-hidden': 'true' }),
      h('span', { class: 'sparkle s1', 'aria-hidden': 'true' }),
      h('span', { class: 'sparkle s2', 'aria-hidden': 'true' }),
      h('span', { class: 'sparkle s3', 'aria-hidden': 'true' }),
      h('span', { class: 'sparkle s4', 'aria-hidden': 'true' }),
      h('span', { class: 'ground', 'aria-hidden': 'true' }),
      h('img', { class: 'pet', alt: '', draggable: 'false' }),
      h('span', { class: 'thinking', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    );
  }

  private buildHome(): HTMLElement {
    this.homeUpdateView = new UpdateView(this.bridge);
    this.homeStage = this.buildStage('home');
    this.petBubble = h('p', { class: 'pet-bubble', role: 'status', hidden: true });
    this.homePetBtn = h('button', {
      type: 'button',
      class: 'pet-touch',
      'aria-label': '摸摸它',
      on: { click: () => this.petReact() },
    });
    this.stageBadge = h('span', { class: 'stage-badge', hidden: true }, h('span', { class: 'dot', 'data-tone': 'ok', 'aria-hidden': 'true' }), '常驻中');
    this.homeStage.append(this.stageBadge, this.petBubble, this.homePetBtn);

    this.homeName = h('h1', { class: 'hero-name', text: '灵伴' });
    this.homeDot = h('span', { class: 'dot', 'aria-hidden': 'true' });
    this.homeStatus = h('span', { text: '正在唤醒灵伴…' });
    const chatBtn = h(
      'button',
      { type: 'button', class: 'primary big', 'data-needs': 'snap', disabled: true, on: { click: () => void this.openConversation(null) } },
      icon('chat'),
      '说句话',
    );
    const styleBtn = h(
      'button',
      { type: 'button', class: 'quiet big', 'data-needs': 'snap', disabled: true, on: { click: () => this.openPage('companion') } },
      '换个样子',
    );
    const hero = h(
      'section',
      { class: 'hero', 'aria-label': '伙伴' },
      this.homeStage,
      h('div', { class: 'hero-id' }, this.homeName, h('p', { class: 'hero-status' }, this.homeDot, this.homeStatus)),
      h('div', { class: 'hero-actions' }, chatBtn, styleBtn),
    );

    this.retryText = h('p');
    this.retryBtn = h('button', { type: 'button', class: 'quiet', on: { click: () => void this.loadSnapshot() } }, '重新连接');
    this.retryCard = h(
      'div',
      { class: 'notice', 'data-tone': 'bad', role: 'alert', hidden: true },
      h('div', { class: 'notice-text' }, h('b', { text: '没有连上灵伴' }), this.retryText),
      this.retryBtn,
    );
    this.setupNotice = h(
      'div',
      { class: 'notice', 'data-tone': 'warn', hidden: true },
      h(
        'div',
        { class: 'notice-text' },
        h('b', { text: '还没有连接模型' }),
        h('p', { text: '接上一个模型服务后，它才能陪你聊天。' }),
      ),
      h('button', { type: 'button', class: 'primary', on: { click: () => this.openPage('model') } }, '去连接'),
    );

    const attentionTitle = `${this.uid}-attention`;
    this.attentionList = h('div', { class: 'task-list' });
    this.attentionSection = h(
      'section',
      { class: 'block', 'aria-labelledby': attentionTitle, hidden: true },
      h('h2', { id: attentionTitle, class: 'block-title', text: '等你处理' }),
      this.attentionList,
    );

    this.continueKicker = h('span', { class: 'card-kicker', text: '上次聊到' });
    this.continueTitle = h('b', { class: 'card-title', text: '正在读取…' });
    this.continueText = h('span', { class: 'card-text' });
    this.continueBtn = h(
      'button',
      {
        type: 'button',
        class: 'card card-link',
        'data-needs': 'snap',
        disabled: true,
        on: { click: () => void this.openConversation(this.continueId) },
      },
      h('span', { class: 'card-body' }, this.continueKicker, this.continueTitle, this.continueText),
      icon('chevron', 'icon card-chevron'),
    );

    this.capsChips = h('span', { class: 'chips' });
    const capsBtn = h(
      'button',
      { type: 'button', class: 'card card-link', on: { click: () => this.goTab('abilities') } },
      h('span', { class: 'card-body' }, h('span', { class: 'card-kicker', text: '手机能力' }), this.capsChips),
      icon('chevron', 'icon card-chevron'),
    );

    const top = h(
      'header',
      { class: 'topbar' },
      h('span', { class: 'brand', 'aria-hidden': 'true', text: 'f.' }),
      h('span', { class: 'brand-text' }, h('b', { text: '灵伴' }), h('small', { text: 'Familiar' })),
    );

    return h(
      'section',
      { class: 'view view-home', 'aria-label': '小窝' },
      top,
      this.homeUpdateView.root,
      h(
        'div',
        { class: 'home-grid' },
        hero,
        h(
          'div',
          { class: 'home-side' },
          this.retryCard,
          this.setupNotice,
          this.buildResident(),
          this.attentionSection,
          this.continueBtn,
          capsBtn,
        ),
      ),
    );
  }

  /** 常驻伙伴卡片：开关只发请求，显示的永远是快照里的实际状态。悬浮窗状态单独一行，与常驻开关分开。 */
  private buildResident(): HTMLElement {
    const titleId = `${this.uid}-resident`;
    this.resChip = h('span', { class: 'chip' });
    this.resLead = h('p', { class: 'res-lead' });
    const fact = (label: string) => {
      const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
      const text = h('span');
      return { el: h('div', { class: 'res-fact' }, h('dt', { text: label }), h('dd', null, dot, text)), dot, text };
    };
    const service = fact('后台陪伴');
    const engine = fact('伙伴状态');
    const overlay = fact('桌面悬浮窗');
    this.resFacts = { service, engine, overlay };
    this.resDetail = h('p', { class: 'res-detail' });

    this.resHints = new Map();
    const hints = h('div', { class: 'res-hints' });
    for (const hint of RESIDENT_HINTS) {
      const row = h(
        'div',
        { class: 'res-hint', hidden: true },
        h('span', { class: 'cap-icon cap-icon-s', 'data-cap': hint.id }, icon(capIcon(hint.id))),
        h('span', { class: 'res-hint-text', text: hint.text }),
        h('button', { type: 'button', class: 'link-btn', on: { click: () => this.openCapability(hint.id) } }, '去授权'),
      );
      this.resHints.set(hint.id, row);
      hints.append(row);
    }

    this.resNote = h('p', { class: 'res-note', role: 'status' });
    this.resToggle = h('button', { type: 'button', class: 'primary big wide', on: { click: () => void this.toggleRuntime() } });
    this.resFoot = h('p', { class: 'res-foot' });
    this.startupToggle = h('input', { type: 'checkbox', 'aria-label': '开机启动伙伴', on: { change: () => { void this.setStartup(this.startupToggle.checked); } } });
    this.startupStatus = h('p', { class: 'block-hint', role: 'status' });
    this.startupBox = h('div', { class: 'res-startup', hidden: true },
      h('label', { class: 'voice-check' }, this.startupToggle, '开机启动伙伴'),
      h('p', { class: 'block-hint', text: '开机解锁后启动常驻伙伴，需要悬浮窗权限。录音和唤醒仍需手动开启。此开关管理下次开机，当前陪伴用上方按钮控制。' }),
      this.startupStatus);
    const more = h(
      'details',
      { class: 'res-more' },
      h('summary', null, icon('info', 'icon icon-inline'), '后台总被系统关掉？'),
      h('p', {
        text: '有些手机（例如小米）会按系统策略限制后台应用。可以在手机的系统设置里为灵伴允许自启动、取消省电限制。这些属于系统的管理策略，即使都设置好，系统仍可能在资源紧张时关闭它，届时回到这里重新开启即可。',
      }),
    );

    this.resCard = h(
      'section',
      { class: 'resident panel', 'aria-labelledby': titleId, hidden: true },
      h(
        'div',
        { class: 'res-head' },
        h('span', { class: 'cap-icon', 'data-cap': 'resident' }, icon('power')),
        h('div', { class: 'res-head-text' }, h('h2', { id: titleId, class: 'res-title', tabindex: '-1', text: '常驻伙伴' }), this.resLead),
        this.resChip,
      ),
      h('dl', { class: 'res-facts' }, service.el, engine.el, overlay.el),
      this.resDetail,
      hints,
      this.resNote,
      this.resToggle,
      this.resFoot,
      this.startupBox,
      more,
    );
    return this.resCard;
  }

  private buildAbilities(): HTMLElement {
    const titleId = `${this.uid}-abilities`;
    const groups = {} as Record<CapGroup, { section: HTMLElement; list: HTMLElement; cache: Map<string, HTMLElement> }>;
    for (const g of CAP_GROUPS) {
      const groupTitle = `${this.uid}-capgroup-${g.id}`;
      const list = h('div', { class: 'cap-list' });
      const section = h(
        'section',
        { class: 'block cap-group', 'aria-labelledby': groupTitle, hidden: true },
        h('h2', { id: groupTitle, class: 'block-title', text: g.title }),
        g.hint ? h('p', { class: 'block-hint', text: g.hint }) : null,
        list,
      );
      groups[g.id] = { section, list, cache: new Map() };
    }
    this.capGroups = groups;
    this.capMissing = h('p', { class: 'footnote cap-missing', hidden: true });
    this.capEmpty = h('p', { class: 'empty', text: '正在读取…' });
    this.taskList = h('div', { class: 'task-list' });
    this.taskEmpty = h('p', {
      class: 'empty',
      text: '还没有任务。它要记日程、写笔记、代你操作手机或使用工具时，会先放在这里请你批准。',
    });
    return h(
      'section',
      { class: 'view view-abilities', 'aria-labelledby': titleId, hidden: true },
      h(
        'header',
        { class: 'view-head' },
        h('h1', { id: titleId, text: '手机能力' }),
        h('p', { text: '用到哪项再授权哪项，每一项都可以拒绝；已授权的可以从这里打开系统设置查看或关闭。' }),
      ),
      this.capEmpty,
      ...CAP_GROUPS.map((g) => groups[g.id].section),
      this.capMissing,
      h('section', { class: 'block' }, h('h2', { class: 'block-title', text: '任务记录' }), this.taskList, this.taskEmpty),
    );
  }

  private buildSettings(): HTMLElement {
    const titleId = `${this.uid}-settings`;
    this.setAvatar = h('img', { alt: '' });
    this.setAvatarWrap = h('span', { class: 'avatar' }, this.setAvatar);
    this.setName = h('b', { text: '伙伴' });
    this.setCompanionSub = h('small', { text: '形象、昵称和性格' });
    this.setModelText = h('small', { text: '正在读取…' });
    this.setModeText = h('p');
    this.updateView = new UpdateView(this.bridge);
    const companionRow = h(
      'button',
      { type: 'button', class: 'row-link', 'data-needs': 'snap', disabled: true, on: { click: () => this.openPage('companion') } },
      this.setAvatarWrap,
      h('span', { class: 'row-text' }, this.setName, this.setCompanionSub),
      icon('chevron', 'icon row-chevron'),
    );
    const modelRow = h(
      'button',
      { type: 'button', class: 'row-link', 'data-needs': 'snap', disabled: true, on: { click: () => this.openPage('model') } },
      h('span', { class: 'avatar avatar-icon' }, icon('link')),
      h('span', { class: 'row-text' }, h('b', { text: '模型连接' }), this.setModelText),
      icon('chevron', 'icon row-chevron'),
    );
    this.setResidentText = h('small', { text: '正在读取…' });
    const residentRow = h(
      'button',
      { type: 'button', class: 'row-link', on: { click: () => this.goResident() } },
      h('span', { class: 'avatar avatar-icon' }, icon('power')),
      h('span', { class: 'row-text' }, h('b', { text: '常驻伙伴' }), this.setResidentText),
      icon('chevron', 'icon row-chevron'),
    );
    const overlayRow = h(
      'button',
      { type: 'button', class: 'row-link', on: { click: () => this.goTab('abilities') } },
      h('span', { class: 'avatar avatar-icon' }, icon('overlay')),
      h('span', { class: 'row-text' }, h('b', { text: '悬浮窗与后台授权' }), h('small', { text: '在“能力”里按需授权或打开系统设置查看' })),
      icon('chevron', 'icon row-chevron'),
    );
    this.setResidentBlock = h(
      'section',
      { class: 'block', hidden: true },
      h('h2', { class: 'block-title', text: '常驻' }),
      h('div', { class: 'panel rows' }, residentRow, overlayRow),
    );
    this.libraryRow = h('button', { type: 'button', class: 'row-link', hidden: true, on: { click: () => this.openPage('library') } },
      h('span', { class: 'avatar avatar-icon' }, icon('chat')),
      h('span', { class: 'row-text' }, h('b', { text: '记忆与技能' }), h('small', { text: '查看、整理记忆与管理技能' })), icon('chevron', 'icon row-chevron'));
    this.mcpRow = h('button', {type:'button',class:'row-link',hidden:true,on:{click:()=>this.openPage('mcp')}},
      h('span',{class:'avatar avatar-icon'},icon('link')),h('span',{class:'row-text'},h('b',{text:'网络工具 · MCP'}),h('small',{text:'连接搜索、地图与其他网络服务'})),icon('chevron','icon row-chevron'));
    this.careRow = h('button',{type:'button',class:'row-link',hidden:true,on:{click:()=>this.openPage('care')}},h('span',{class:'avatar avatar-icon'},icon('bell')),h('span',{class:'row-text'},h('b',{text:'日常关怀'}),h('small',{text:'自然问候、自定义提醒与附近建议'})),icon('chevron','icon row-chevron'));
    this.backupRow = h('button',{type:'button',class:'row-link',hidden:true,on:{click:()=>this.openPage('backup')}},h('span',{class:'row-text'},h('b',{text:'数据迁移'}),h('small',{text:'加密导出、导入旧配置与恢复'})),icon('chevron','icon row-chevron'));
    this.permissionRow = h('button', { type:'button', class:'row-link', hidden:true, on:{click:()=>this.openPage('permissions')} }, h('span',{class:'row-text'},h('b',{text:'权限管理'}),h('small',{text:'全局模式、白名单与会话授权'})), icon('chevron','icon row-chevron'));
    this.feishuRow = h('button',{type:'button',class:'row-link',hidden:true,on:{click:()=>this.openPage('feishu')}},h('span',{class:'avatar avatar-icon'},icon('chat')),h('span',{class:'row-text'},h('b',{text:'飞书'}),h('small',{text:'机器人私聊、文档、日程与任务'})),icon('chevron','icon row-chevron'));
    return h(
      'section',
      { class: 'view view-settings', 'aria-labelledby': titleId, hidden: true },
      h('header', { class: 'view-head' }, h('h1', { id: titleId, text: '设置' })),
      h('section', { class: 'block' }, h('h2', { class: 'block-title', text: '伙伴' }), h('div', { class: 'panel rows' }, companionRow)),
      this.setResidentBlock,
      this.buildPetSettings(),
      h('section', { class: 'block' }, h('h2', { class: 'block-title', text: '对话' }), h('div', { class: 'panel rows' }, modelRow, this.libraryRow, this.careRow, this.mcpRow, this.feishuRow, this.permissionRow, this.backupRow)),
      this.buildVoiceSettings(),
      this.updateView.root,
      h(
        'section',
        { class: 'block' },
        h('h2', { class: 'block-title', text: '关于' }),
        h(
          'div',
          { class: 'panel about' },
          h('p', { class: 'about-name' }, h('span', { class: 'brand brand-s', 'aria-hidden': 'true', text: 'f.' }), '灵伴 · Familiar 移动版'),
          h('p', { text: '聊天记录、设置和密钥都由灵伴统一保管，这个界面本身不会另存任何内容。' }),
          this.setModeText,
        ),
      ),
    );
  }

  private buildDock(): HTMLElement {
    const item = (label: string, name: IconName, onClick: () => void, needsSnap = false) =>
      h(
        'button',
        { type: 'button', class: 'dock-item', 'data-needs': needsSnap ? 'snap' : undefined, disabled: needsSnap, on: { click: onClick } },
        icon(name),
        h('span', { class: 'dock-label', text: label }),
      );
    this.dockButtons = {
      home: item('小窝', 'home', () => this.goTab('home')),
      chat: item('聊天', 'chat', () => void this.openConversation(null), true),
      abilities: item('能力', 'phone', () => this.goTab('abilities')),
      settings: item('设置', 'sliders', () => this.goTab('settings')),
    };
    this.dockBadge = h('span', { class: 'dock-badge', hidden: true });
    this.dockButtons.abilities.append(this.dockBadge);
    return h(
      'nav',
      { class: 'dock', 'aria-label': '主导航' },
      this.dockButtons.home,
      this.dockButtons.chat,
      this.dockButtons.abilities,
      this.dockButtons.settings,
    );
  }

  private buildPetSettings(): HTMLElement {
    const check = (name: string, text: string) => h('label', { class: 'voice-check' }, h('input', { type: 'checkbox', name }), text);
    const number = (name: string, text: string, min: number, max: number, step = 1) => h('label', { class: 'field' }, h('span', { class: 'field-label', text }), h('input', { type: 'number', name, min: String(min), max: String(max), step: String(step), required: true }));
    this.petStatus = h('p', { class: 'block-hint' });
    this.petForm = h('form', { class: 'panel panel-form pet-form' },
      check('visible', '显示悬浮宠物'), check('quiet', '安静陪伴（减少主动说话）'),
      number('scale', '宠物大小（%）', 65, 160, 5), number('bubbleSeconds', '回复气泡停留（秒，0 表示手动收起）', 0, 300),
      h('button', { type: 'submit', class: 'primary', text: '保存宠物设置' }));
    this.dockForm = h('form', { class: 'panel panel-form pet-form' },
      h('h3', { text: '边缘停靠' }), check('snapToEdge', '拖动后自动吸附边缘'),
      check('hideWhenIdle', '停靠后闲置收成小脑袋'), number('delaySeconds', '闲置多久收起（秒）', 10, 300),
      h('p', { class: 'block-hint', text: '开启吸附后，松手停在最近的边缘，靠近角落会停在角落。继续向外滑可立即收起；轻点小脑袋或向内拖即可展开。有回复或待批准操作时保持展开。' }),
      h('button', { type: 'submit', class: 'primary', text: '保存停靠设置' }));
    this.petForm.addEventListener('input', () => { this.petDirty = true; });
    this.dockForm.addEventListener('input', () => { this.dockDirty = true; this.syncDockControls(); });
    this.petForm.addEventListener('submit', e => { e.preventDefault(); void this.savePet(false); });
    this.dockForm.addEventListener('submit', e => { e.preventDefault(); void this.savePet(true); });
    const action = (label: string, value: 'sleep' | 'recall' | 'reset-position') => h('button', { type: 'button', class: 'quiet', text: label, on: { click: () => {
      // 控制页内直接查看对话，避免召回的悬浮气泡立刻被前台去重隐藏。
      if (value === 'recall') { this.openPage('chat'); return; }
      void this.run('pet-action', () => this.bridge.request('pet.interact', { action: value }), '未能调整宠物');
    } } });
    this.petSettings = h('section', { class: 'block', hidden: true }, h('details', { class: 'voice-details pet-details' },
      h('summary', { text: '悬浮宠物与停靠' }), this.petStatus, this.petForm, this.dockForm,
      h('div', { class: 'pet-actions' }, action('休息 / 唤醒', 'sleep'), action('查看对话', 'recall'), action('重置悬浮位置', 'reset-position')),
      h('p', { class: 'block-hint', text: '隐藏宠物不会停止常驻。宠物上的长按菜单也可聊天、休息或查看上次回复。' })));
    return this.petSettings;
  }
  private syncDockControls(): void {
    const input = (name: string) => this.dockForm.elements.namedItem(name) as HTMLInputElement;
    input('hideWhenIdle').disabled = !input('snapToEdge').checked || this.busy('pet-dock');
    input('delaySeconds').disabled = !input('snapToEdge').checked || !input('hideWhenIdle').checked || this.busy('pet-dock');
  }
  private async savePet(dock: boolean): Promise<void> {
    const form = dock ? this.dockForm : this.petForm;
    const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const result = dock
      ? await this.run('pet-dock', () => this.bridge.request('pet.docking.save', { snapToEdge: input('snapToEdge').checked, hideWhenIdle: input('hideWhenIdle').checked, delaySeconds: Number(input('delaySeconds').value) }), '未能保存停靠设置')
      : await this.run('pet-save', () => this.bridge.request('pet.settings.save', { scale: Number(input('scale').value) / 100, visible: input('visible').checked, quiet: input('quiet').checked, bubbleSeconds: Number(input('bubbleSeconds').value) }), '未能保存宠物设置');
    if (result?.ok) { if (dock) this.dockDirty = false; else this.petDirty = false; this.toast(dock ? '停靠设置已保存' : '宠物设置已保存'); await this.loadSnapshot(); }
  }
  private renderPet(s: MobileSnapshot): void {
    const pet = s.pet; show(this.petSettings, Boolean(pet)); if (!pet) return;
    setText(this.petStatus, `当前：${pet.docking?.tucked ? '已收成小脑袋' : ({ idle: '陪伴中', greet: '打招呼', happy: '开心', think: '思考中', sleep: '休息中', drag: '移动中' })[pet.action]}`);
    if (!this.petDirty) {
      const input = (name: string) => this.petForm.elements.namedItem(name) as HTMLInputElement;
      input('visible').checked = pet.visible; input('quiet').checked = pet.quiet;
      input('scale').value = String(Math.round(pet.scale * 100)); input('bubbleSeconds').value = String(pet.bubbleSeconds);
    }
    show(this.dockForm, Boolean(pet.docking));
    if (pet.docking && !this.dockDirty) {
      const input = (name: string) => this.dockForm.elements.namedItem(name) as HTMLInputElement;
      input('snapToEdge').checked = pet.docking.snapToEdge; input('hideWhenIdle').checked = pet.docking.hideWhenIdle; input('delaySeconds').value = String(pet.docking.delaySeconds);
    }
    for (const [form, busy] of [[this.petForm, this.busy('pet-save')], [this.dockForm, this.busy('pet-dock')]] as const) form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(el => { el.disabled = busy; });
    this.syncDockControls();
  }
  private buildVoiceSettings(): HTMLElement {
    const field = (name: string, label: string, type = 'text') => h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), h('input', { name, type, autocomplete: type === 'password' ? 'new-password' : 'off', spellcheck: 'false', ...(type === 'number' ? { min: '0.5', max: '2', step: '0.1' } : {}) }));
    const profile = (slot: 'stt' | 'tts', title: string) => h('fieldset', { class: 'voice-profile' }, h('legend', { text: title }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: `${title}服务` }), h('select', { name: `${slot}-kind` }, h('option', { value: 'compatible', text: 'OpenAI 兼容服务' }), h('option', { value: 'openrouter', text: 'OpenRouter' }), ...(slot === 'tts' ? [h('option', { value: 'system', hidden: true, text: '设备本地朗读（无需 API）' })] : []))),
      field(`${slot}-baseUrl`, `${title}地址`, 'url'), field(`${slot}-model`, `${title}模型`), field(`${slot}-apiKey`, `${title}密钥`, 'password'),
      h('small', { class: 'voice-key-hint', 'data-slot': slot, text: '留空保留此地址的密钥。' }),
      h('label', { class: 'voice-check' }, h('input', { type: 'checkbox', name: `${slot}-clearApiKey` }), '清除此地址的密钥'),
      ...(slot === 'tts' ? [field('tts-voice', '朗读音色 ID'),
        h('div', { class: 'local-voice', hidden: true },
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: '设备音色' }), h('select', { name: 'tts-local-voice' }, h('option', { value: '', text: '跟随系统默认音色' }))),
          h('button', { type: 'button', class: 'quiet', text: '刷新设备音色', on: { click: () => void this.loadLocalVoices() } }),
          h('p', { class: 'block-hint local-voice-note', text: '刷新以查看系统已安装的本地音色。' })),
        field('tts-speed', '朗读速度', 'number'), h('label', { class: 'voice-check' }, h('input', { type: 'checkbox', name: 'tts-stream' }), '流式播放（服务需返回 PCM 采样率）')] : []));
    this.voiceForm = h('form', { class: 'panel panel-form voice-form' },
      h('p', { class: 'block-hint', text: '录音结束后交给识别服务；连续语音还会使用聊天模型和朗读服务。三者可分别配置。' }),
      profile('stt', '识别'), profile('tts', '朗读'),
      h('label', { class: 'voice-check' }, h('input', { type: 'checkbox', name: 'autoRead' }), '自动朗读文字回复'),
      h('label', { class: 'voice-check' }, h('input', { type: 'checkbox', name: 'continuous' }), '保持接话，直到手动停止'),
      h('button', { type: 'submit', class: 'primary', text: '保存语音设置' }),
      h('small', { text: '每段录音最长 90 秒。关闭持续接话后，空闲时结束。麦克风授权不会自动开始录音。' }));
    const edited = () => {
      this.voiceDirty = true;
      this.voiceForm.querySelectorAll('.voice-key-hint').forEach(el => { el.textContent = '保存时按填写的服务和地址匹配密钥，留空保留该地址的密钥。'; });
    };
    this.voiceForm.addEventListener('input', edited);
    this.voiceForm.addEventListener('change', edited);
    this.voiceForm.addEventListener('change', e => {
      const input = e.target as HTMLInputElement;
      if (input.name === 'tts-local-voice') this.localVoiceChoice = input.value;
      if (input.name === 'tts-kind') {
        if (input.value === 'system') {
          (this.voiceForm.elements.namedItem('tts-apiKey') as HTMLInputElement).value = '';
          (this.voiceForm.elements.namedItem('tts-clearApiKey') as HTMLInputElement).checked = false;
          if (!this.localVoices) void this.loadLocalVoices();
        }
        this.syncLocalVoice();
      }
    });
    this.voiceForm.addEventListener('submit', e => { e.preventDefault(); void this.saveVoice(); });
    this.liveForm = h('form', { class: 'panel panel-form live-form', hidden: true },
      h('h3', { text: '对话语音模式' }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '语音模式' }), h('select', { name: 'mode' }, h('option', { value: 'chained', text: '常规语音 · 识别、对话、朗读' }), h('option', { value: 'realtime', text: '实时语音 · Live' }))),
      h('p', { class: 'block-hint', text: '实时语音把麦克风音频流交给下方服务，由它听取并朗读。回答、记忆与工具审批仍使用当前聊天模型。切换模式或保存不会开始录音。录音转文字仍使用单独配置的识别服务。' }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '实时语音协议' }), h('select', { name: 'kind' }, h('option', { value: 'openai', text: 'OpenAI Realtime 兼容' }), h('option', { value: 'gemini', text: 'Gemini Live' }))),
      field('baseUrl', '实时服务地址', 'url'), field('model', '实时模型'), field('voice', '实时音色 ID'), field('apiKey', '实时语音密钥', 'password'),
      h('small', { class: 'live-key-hint', text: '留空保留此协议和地址的密钥。' }),
      h('label', { class: 'voice-check' }, h('input', { type: 'checkbox', name: 'clearApiKey' }), '清除此实时地址的密钥'),
      h('p', { class: 'live-status block-hint', role: 'status' }),
      h('button', { type: 'submit', class: 'primary', text: '保存语音模式' }));
    const liveEdited = () => { this.liveDirty = true; if (this.snap) { this.renderLive(this.snap); this.renderWake(this.snap); } };
    this.liveForm.addEventListener('input', liveEdited); this.liveForm.addEventListener('change', liveEdited);
    this.liveForm.addEventListener('submit', e => { e.preventDefault(); void this.saveLive(); });
    this.wakeForm = h('form', { class: 'panel panel-form wake-form', hidden: true },
      h('h3', { text: '离线语音唤醒' }),
      h('label', { class: 'voice-check' }, h('input', { type: 'checkbox', name: 'enabled' }), '允许使用唤醒待机'),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '唤醒词（每行一个）' }), h('textarea', { name: 'phrases', rows: '3', maxlength: '328', placeholder: '留空使用伙伴昵称' })),
      h('small', { text: '最多 8 条，每条 40 字；支持中文及词典中的英文。建议使用 2–6 个汉字，先呼唤，再说指令。' }),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '唤醒灵敏度（越高越容易触发）' }), h('input', { name: 'sensitivity', type: 'range', min: '0', max: '100', step: '1' })),
      h('p', { class: 'block-hint', text: '待机在本机检测。命中后，最多包含命中前 2 秒、合计 8 秒的音频会交给当前语音模式使用的服务，再进入语音对话。保存不会开始录音，重启后需手动开启。' }),
      h('button', { type: 'submit', class: 'quiet', text: '保存唤醒设置' }),
      h('p', { class: 'wake-status block-hint', role: 'status' }),
      h('button', { type: 'button', class: 'primary wake-start', text: '开启唤醒待机', on: { click: () => void this.startWake() } }),
      h('button', { type: 'button', class: 'quiet wake-stop', text: '停止待机与语音', on: { click: () => void this.voiceCommand('voice.stop') } }));
    this.wakeForm.addEventListener('input', () => { this.wakeDirty = true; if (this.snap) this.renderWake(this.snap); });
    this.wakeForm.addEventListener('submit', e => { e.preventDefault(); void this.saveWake(); });
    this.voiceSettings = h('section', { class: 'block', hidden: true }, h('details', { class: 'voice-details' }, h('summary', { text: '语音连接' }), this.liveForm, this.voiceForm, this.wakeForm));
    return this.voiceSettings;
  }

  private voiceBusy(): boolean { const v = this.snap?.voice?.state; return Boolean(this.snap?.voice?.wake?.armed || v && (v.active || !['off', 'sleeping', 'error'].includes(v.phase))); }
  private renderLive(s: MobileSnapshot): void {
    const live = s.voice?.live; show(this.liveForm, Boolean(live)); if (!live) return;
    const input = (name: string) => this.liveForm.elements.namedItem(name) as HTMLInputElement;
    if (!this.liveDirty && !this.busy('live-save')) {
      input('mode').value = live.mode;
      for (const name of ['kind', 'baseUrl', 'model', 'voice'] as const) input(name).value = live.profile[name];
    }
    setText(q(this.liveForm, '.live-status'), this.liveDirty ? '语音模式尚未保存。' : [live.summary, ...live.problems].join('；'));
    setText(q(this.liveForm, '.live-key-hint'), this.liveDirty ? '按填写的协议和地址匹配密钥，留空保留该地址的密钥。' : live.profile.keyConfigured ? '此协议和地址已保存密钥，留空保留。' : '此协议和地址尚未保存密钥。');
    for (const el of this.liveForm.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,select,button')) el.disabled = this.voiceBusy() || this.busy('live-save') || this.busy('voice-save');
  }
  private async saveLive(): Promise<void> {
    if (this.voiceBusy() || this.busy('live-save')) return;
    const input = (name: string) => this.liveForm.elements.namedItem(name) as HTMLInputElement;
    const draft = () => ({ mode: input('mode').value as 'chained' | 'realtime', kind: input('kind').value as 'openai' | 'gemini', baseUrl: input('baseUrl').value.trim(), model: input('model').value.trim(), voice: input('voice').value.trim(), ...(input('apiKey').value ? { apiKey: input('apiKey').value } : {}), ...(input('clearApiKey').checked ? { clearApiKey: true } : {}) });
    const saved = draft();
    const result = await this.run('live-save', () => this.bridge.request('voice.live.save', saved), '语音模式未能保存');
    if (result?.ok) {
      this.liveDirty = JSON.stringify(saved) !== JSON.stringify(draft());
      if (input('apiKey').value === saved.apiKey) input('apiKey').value = '';
      if (input('clearApiKey').checked === Boolean(saved.clearApiKey)) input('clearApiKey').checked = false;
      this.toast('语音模式已保存；开始语音后才会连接');
    }
    await this.loadSnapshot();
  }
  private renderWake(s: MobileSnapshot): void {
    const wake = s.voice?.wake; show(this.wakeForm, Boolean(wake)); if (!wake) return;
    const input = (name: string) => this.wakeForm.elements.namedItem(name) as HTMLInputElement;
    if (!this.wakeDirty && !this.busy('wake-save')) { input('enabled').checked = wake.enabled; input('phrases').value = wake.phrases.join('\n'); input('sensitivity').value = String(wake.sensitivity); }
    for (const el of this.wakeForm.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input,textarea,button[type="submit"]')) el.disabled = this.voiceBusy() || this.busy('wake-save') || this.busy('wake-start');
    setText(q(this.wakeForm, '.wake-status'), this.wakeDirty ? '唤醒设置尚未保存。' : wake.message);
    q<HTMLButtonElement>(this.wakeForm, '.wake-start').disabled = !wake.enabled || this.wakeDirty || this.voiceDirty || this.liveDirty || this.voiceBusy() || this.busy('wake-start') || this.busy('wake-save') || Boolean(s.activeReply);
    q<HTMLButtonElement>(this.wakeForm, '.wake-stop').disabled = !wake.armed && !s.voice?.state.active || this.busy('voice-stop');
  }
  private async saveWake(): Promise<void> {
    if (this.voiceBusy()) return;
    const input = (name: string) => this.wakeForm.elements.namedItem(name) as HTMLInputElement;
    const draft = { enabled: input('enabled').checked, phrases: input('phrases').value.split(/\r?\n/).map(v => v.trim()).filter(Boolean), sensitivity: Number(input('sensitivity').value) };
    const result = await this.run('wake-save', () => this.bridge.request('voice.wake.save', draft), '唤醒设置未能保存，请检查词语是否支持');
    if (result?.ok) { const current = { enabled: input('enabled').checked, phrases: input('phrases').value.split(/\r?\n/).map(v => v.trim()).filter(Boolean), sensitivity: Number(input('sensitivity').value) }; this.wakeDirty = JSON.stringify(current) !== JSON.stringify(draft); this.toast('唤醒设置已保存；开启待机后才会监听'); }
    await this.loadSnapshot();
  }
  private async startWake(): Promise<void> {
    const s = this.snap; if (!s?.voice?.wake?.enabled || this.voiceBusy() || this.wakeDirty || this.voiceDirty || this.liveDirty) return;
    if (!s.capabilities.some(c => c.id === 'microphone' && c.state === 'granted')) { await this.requestCapability('microphone'); this.toast('授权后，请再次点击开启唤醒待机'); return; }
    this.voiceConversation = true;
    const result = await this.run('wake-start', () => this.bridge.request('voice.wake.start', { conversationId: s.activeConversationId }), '未能开启唤醒，请检查语音连接和权限');
    if (result && !result.ok) this.voiceConversation = false;
    await this.loadSnapshot();
  }
  private syncLocalVoice(): void {
    const local = (this.voiceForm.elements.namedItem('tts-kind') as HTMLSelectElement).value === 'system';
    show(q(this.voiceForm, '.local-voice'), local);
    for (const name of ['baseUrl', 'model', 'apiKey', 'clearApiKey', 'voice', 'stream']) show((this.voiceForm.elements.namedItem(`tts-${name}`) as HTMLElement).closest('label')!, !local);
    show(q(this.voiceForm, '[data-slot="tts"]'), !local);
    const select = this.voiceForm.elements.namedItem('tts-local-voice') as HTMLSelectElement;
    const choices = this.localVoices?.voices ?? [];
    const missing = this.localVoiceChoice && !choices.some(v => v.id === this.localVoiceChoice) ? this.localVoiceChoice : '';
    const optionsKey = JSON.stringify([choices, missing]);
    if (optionsKey !== this.localVoiceOptionsKey) {
      select.replaceChildren(h('option', { value: '', text: '跟随系统默认音色' }), ...choices.map(v => h('option', { value: v.id, text: v.name })));
      if (missing) select.append(h('option', { value: missing, text: this.localVoices ? '原音色不可用，请重新选择' : '已保存音色（待刷新）' }));
      this.localVoiceOptionsKey = optionsKey;
    }
    if (select.value !== this.localVoiceChoice) select.value = this.localVoiceChoice;
    const control = q<HTMLButtonElement>(this.voiceForm, '.local-voice button'); control.disabled = this.voiceBusy() || this.busy('voice-save') || this.busy('voice-local');
  }
  private async loadLocalVoices(): Promise<void> {
    if (!this.snap?.voice?.localTts || this.voiceBusy()) return;
    const r = await this.run('voice-local', () => this.bridge.request('voice.local.catalog', undefined), '未能读取系统音色');
    if (r?.ok) { this.localVoices = r.value; setText(q(this.voiceForm, '.local-voice-note'), r.value.note); }
    this.syncLocalVoice();
  }
  private voiceLocked(): boolean { return (this.snap?.voice?.state.sessionMode === 'conversation' && this.voiceBusy()) || (this.voiceConversation && this.busy('voice')); }
  private renderVoice(s: MobileSnapshot): void {
    const v = s.voice; show(this.voiceSettings, Boolean(v)); show(this.voiceButtons, Boolean(v));
    show(this.voiceBar, Boolean(v) && (this.voiceBusy() || v?.state.phase === 'error'));
    if (!v) return;
    this.renderWake(s);
    this.renderLive(s);
    show(q(this.voiceButtons, '.system-speech'), v.systemInput === true);
    show(q(this.voiceButtons, '.system-speech-note'), v.systemInput === true);
    show(q(this.voiceForm, 'option[value="system"]'), Boolean(v.localTts));
    setText(this.voiceStatus, v.wake?.armed && !v.state.active ? v.wake.message : v.state.dictating && v.state.phase === 'recording' ? '录音中，最长 90 秒' : v.state.message);
    show(this.voiceFinish, v.state.dictating && v.state.phase === 'recording');
    this.voiceFinish.disabled = this.busy('voice'); this.voiceStop.disabled = this.busy('voice-stop');
    this.voiceButtons.querySelectorAll('button').forEach(b => { b.disabled = this.voiceBusy() || this.busy('voice') || this.busy('voice-system') || this.busy('send') || Boolean(s.activeReply); });
    this.voiceForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(el => { el.disabled = this.voiceBusy() || this.busy('voice-save') || this.busy('live-save'); });
    if (!this.voiceDirty && !this.busy('voice-save')) {
      const input = (name: string) => this.voiceForm.elements.namedItem(name) as HTMLInputElement;
      for (const slot of ['stt', 'tts'] as const) {
        for (const key of ['kind', 'baseUrl', 'model'] as const) input(`${slot}-${key}`).value = v.settings[slot][key];
        q(this.voiceForm, `[data-slot="${slot}"]`).textContent = v.settings[slot].keyConfigured ? '此地址已保存密钥，留空保留。' : '此地址尚未保存密钥。';
      }
      if (v.settings.tts.kind === 'system') this.localVoiceChoice = v.settings.tts.voice;
      else input('tts-voice').value = v.settings.tts.voice;
      input('tts-speed').value = String(v.settings.tts.speed);
      input('tts-stream').checked = v.settings.tts.stream !== false;
      input('autoRead').checked = v.settings.autoRead; input('continuous').checked = v.settings.continuous;
    }
    this.syncLocalVoice();
    const d = v.dictation;
    if (d && !this.dictationSeen.has(d.id)) {
      this.dictationSeen.add(d.id);
      this.appendDictation(d.conversationId, d.text);
    }
  }
  private appendDictation(conversationId: string | null, text: string): void {
      if (conversationId !== null && !this.snap?.conversations.some(c => c.id === conversationId)) return;
      const current = conversationId === this.chatConversationId;
      const old = current ? this.composer.value : this.drafts.get(conversationId) ?? '';
      const merged = `${old}${old ? '\n' : ''}${text}`;
      // 不截断识别结果；超长时先保留原稿，并把完整结果留在原会话草稿等待编辑。
      if (current) { this.composer.value = merged; this.autosizeComposer(); } else this.drafts.set(conversationId, merged);
      this.toast(current ? '识别结果已加入草稿，请确认后发送' : '识别结果已放回原会话草稿');
      this.updateSendState();
  }
  private async systemSpeech(): Promise<void> {
    const s = this.snap; if (!s?.voice?.systemInput || this.voiceBusy() || this.busy('voice-system')) return;
    const conversationId = s.activeConversationId;
    const result = await this.run('voice-system', () => this.bridge.request('voice.system.input', { conversationId }), '系统语音输入未完成');
    if (result?.ok && result.value.text) this.appendDictation(conversationId, result.value.text);
  }
  private async voiceCommand(method: 'voice.stop' | 'voice.finish'): Promise<void> {
    await this.run(method === 'voice.stop' ? 'voice-stop' : 'voice', () => this.bridge.request(method, undefined), '语音操作未完成');
    await this.loadSnapshot();
  }
  private async startVoice(mode: 'dictation' | 'conversation'): Promise<void> {
    const s = this.snap; if (!s?.voice || this.voiceBusy() || this.busy('voice')) return;
    if (this.voiceDirty || mode === 'conversation' && this.liveDirty) { this.toast('请先保存语音设置'); return; }
    if (!s.capabilities.some(c => c.id === 'microphone' && c.state === 'granted')) { await this.requestCapability('microphone'); this.toast('授权后，请再次点击开始录音'); return; }
    this.voiceConversation = mode === 'conversation';
    const result = await this.run('voice', () => this.bridge.request('voice.start', { mode, conversationId: s.activeConversationId }), '未能开始语音');
    if (result && !result.ok) this.voiceConversation = false;
    await this.loadSnapshot();
  }
  private async readMessage(messageId: string): Promise<void> {
    if (!this.snap?.activeConversationId || this.voiceBusy()) return;
    await this.run('voice', () => this.bridge.request('voice.read', { conversationId: this.snap!.activeConversationId!, messageId }), '未能朗读'); await this.loadSnapshot();
  }
  private async saveVoice(): Promise<void> {
    if (this.voiceBusy()) return;
    const input = (name: string) => this.voiceForm.elements.namedItem(name) as HTMLInputElement;
    const profile = (slot: 'stt' | 'tts') => ({ kind: input(`${slot}-kind`).value as 'compatible' | 'openrouter', baseUrl: input(`${slot}-baseUrl`).value.trim(), model: input(`${slot}-model`).value.trim(), ...(input(`${slot}-apiKey`).value ? { apiKey: input(`${slot}-apiKey`).value } : {}), ...(input(`${slot}-clearApiKey`).checked ? { clearApiKey: true } : {}) });
    const local = input('tts-kind').value === 'system';
    const tts: MobileCommands['voice.save']['params']['tts'] = local
      ? { kind: 'system', baseUrl: input('tts-baseUrl').value.trim(), model: input('tts-model').value.trim(), voice: this.localVoiceChoice, speed: Number(input('tts-speed').value), stream: false }
      : { ...profile('tts'), voice: input('tts-voice').value.trim(), speed: Number(input('tts-speed').value), stream: input('tts-stream').checked };
    const params: MobileCommands['voice.save']['params'] = { stt: profile('stt'), tts, autoRead: input('autoRead').checked, continuous: input('continuous').checked };
    const result = await this.run('voice-save', () => this.bridge.request('voice.save', params), '未能保存语音设置');
    for (const slot of ['stt', 'tts']) { input(`${slot}-apiKey`).value = ''; input(`${slot}-clearApiKey`).checked = false; }
    if (result?.ok) { this.voiceDirty = false; this.toast('语音设置已保存'); await this.loadSnapshot(); }
  }

  private backButton(): HTMLButtonElement {
    return h('button', { type: 'button', class: 'icon-btn', 'aria-label': '返回', on: { click: () => this.back() } }, icon('back'));
  }

  private buildChat(): { page: HTMLElement; heading: HTMLElement } {
    const titleId = `${this.uid}-chat-title`;
    const heading = h('h1', { id: titleId, tabindex: '-1', text: '新的对话' });
    this.chatAvatar = h('img', { alt: '' });
    this.chatAvatarWrap = h('span', { class: 'avatar avatar-s' }, this.chatAvatar);
    this.chatStatus = h('small');
    this.chatHistoryBtn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-label': '聊天记录', on: { click: () => this.openSheet('history') } },
      icon('list'),
    );
    this.chatNewBtn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-label': '开始新对话', on: { click: () => void this.newConversation(false) } },
      icon('plus'),
    );
    this.contextButton = h('button', {type:'button',class:'icon-btn','aria-label':'会话上下文',hidden:true,on:{click:()=>this.openPage('context')}},icon('info'));
    const bar = h(
      'header',
      { class: 'pagebar' },
      this.backButton(),
      h('div', { class: 'pagebar-title' }, this.chatAvatarWrap, h('div', { class: 'pagebar-text' }, heading, this.chatStatus)),
      this.chatHistoryBtn,
      this.contextButton,
      this.chatNewBtn,
    );

    this.chatEmptyStage = this.buildStage('mini');
    this.chatEmptyTitle = h('h2', { text: '说点什么吧' });
    const suggestions = h(
      'div',
      { class: 'suggestions', role: 'group', 'aria-label': '可以这样开头' },
      ...SUGGESTIONS.map((text) =>
        h('button', { type: 'button', class: 'suggestion', on: { click: () => this.useSuggestion(text) } }, text),
      ),
    );
    this.chatEmptyHint = h('p', { text: '想到什么就说什么。回车键换行，写好后点右下角发送。' });
    this.chatEmpty = h('div', { class: 'chat-empty' }, this.chatEmptyStage, this.chatEmptyTitle, this.chatEmptyHint, suggestions);
    this.msgList = h('div', { class: 'msg-list', role: 'log', 'aria-live': 'off', 'aria-label': '对话内容' });
    this.chatTasks = h('div', { class: 'task-list chat-tasks', 'aria-label': '这段对话里的任务' });
    this.chatScroll = h('div', { class: 'chat-scroll' }, this.chatEmpty, this.msgList, this.chatTasks);
    this.chatScroll.addEventListener('scroll', () => {
      this.chatPinned = this.isChatNearBottom();
      if (this.chatPinned) show(this.jumpBtn, false);
    }, { passive: true });

    this.jumpBtn = h(
      'button',
      { type: 'button', class: 'jump', hidden: true, on: { click: () => this.jumpToLatest() } },
      icon('down'),
      '回到最新',
    );

    this.composerNotice = h(
      'div',
      { class: 'composer-notice', hidden: true },
      h('span', { text: '还没有连接模型，暂时发不出消息。' }),
      h('button', { type: 'button', class: 'link-btn', on: { click: () => this.openPage('model') } }, '去连接'),
    );
    const inputId = `${this.uid}-composer`;
    this.composer = h('textarea', {
      id: inputId,
      class: 'composer-input',
      rows: '1',
      maxlength: '8000',
      placeholder: '想和它说点什么…',
      enterkeyhint: 'enter',
      autocomplete: 'off',
    });
    this.composer.addEventListener('input', () => {
      this.autosizeComposer();
      this.updateSendState();
    });
    this.composer.addEventListener('keydown', (e) => {
      // 回车默认换行；只有 Ctrl/⌘+Enter 才发送，且输入法组字时一律不发送。
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        void this.sendMessage();
      }
    });
    this.sendBtn = h(
      'button',
      { type: 'button', class: 'send-btn', 'aria-label': '发送', disabled: true, on: { click: () => void this.sendMessage() } },
      icon('send'),
    );
    this.stopBtn = h(
      'button',
      { type: 'button', class: 'stop-btn', 'aria-label': '停止回复', hidden: true, on: { click: () => void this.cancelReply() } },
      icon('stop'),
    );
    // 附件入口：只调用系统选择器导入到本地，点发送时才随消息交给模型。
    this.attachBtn = h(
      'button',
      {
        type: 'button',
        class: 'attach-btn',
        'aria-label': '添加图片或文本文件',
        hidden: true,
        on: { click: () => void this.chooseAttachments('files') },
      },
      icon('clip'),
    );
    // 拍照入口：调用系统相机，确认后的照片同样只进待发送托盘。
    this.cameraBtn = h(
      'button',
      {
        type: 'button',
        class: 'attach-btn camera-btn',
        'aria-label': '用系统相机拍照',
        hidden: true,
        on: { click: () => void this.chooseAttachments('camera') },
      },
      icon('camera'),
    );
    this.pasteBtn = h('button', {
      type: 'button', class: 'attach-btn paste-btn', 'aria-label': '粘贴剪贴板图片', title: '粘贴图片', hidden: true,
      on: { click: () => void this.chooseAttachments('clipboard') },
    }, icon('paste'));
    // 多个来源并排贴成一枚贴纸，仍保持各自完整的触摸区域。
    this.sourceGroup = h('div', { class: 'source-group', role: 'group', 'aria-label': '添加附件', hidden: true }, this.cameraBtn, this.attachBtn, this.pasteBtn);
    const trayTitle = `${this.uid}-tray`;
    this.trayCount = h('b', { id: trayTitle, class: 'tray-count' });
    this.trayList = h('ul', { class: 'tray-list', 'aria-labelledby': trayTitle });
    this.trayBox = h(
      'div',
      { class: 'tray', hidden: true },
      h('div', { class: 'tray-head' }, this.trayCount, h('span', { class: 'tray-hint', text: '只存在手机里，点发送后才交给模型' })),
      this.trayList,
    );
    const composer = h(
      'div',
      { class: 'composer' },
      this.composerNotice,
      this.voiceButtons = h('div', { class: 'voice-actions', hidden: true },
        h('button', { type: 'button', class: 'quiet', text: '录音转文字', on: { click: () => void this.startVoice('dictation') } }),
        h('button', { type: 'button', class: 'quiet', text: '连续语音', on: { click: () => void this.startVoice('conversation') } }),
        h('button', { type: 'button', class: 'quiet system-speech', hidden: true, text: '系统语音输入', on: { click: () => void this.systemSpeech() } }),
        h('small', { class: 'system-speech-note', hidden: true, text: '系统输入由识别应用处理，可能联网；结果只放入草稿。' }),
      ),
      this.trayBox,
      h(
        'div',
        { class: 'composer-row' },
        this.sourceGroup,
        h('label', { class: 'sr-only', for: inputId, text: '想说的话' }),
        this.composer,
        this.sendBtn,
        this.stopBtn,
      ),
    );

    const page = h(
      'section',
      { class: 'page page-chat', 'aria-labelledby': titleId, hidden: true },
      bar,
      h('div', { class: 'chat-body' }, this.chatScroll, this.jumpBtn),
      composer,
    );
    return { page, heading };
  }

  private buildCompanion(): { page: HTMLElement; heading: HTMLElement } {
    const titleId = `${this.uid}-comp-title`;
    const heading = h('h1', { id: titleId, tabindex: '-1', text: '伙伴' });
    const bar = h('header', { class: 'pagebar' }, this.backButton(), h('div', { class: 'pagebar-title' }, h('div', { class: 'pagebar-text' }, heading)));

    this.compStage = this.buildStage('mini');
    this.compStage.classList.add('stage-preview');
    this.compStageName = h('p', { class: 'preview-name' });
    this.compStageDesc = h('p', { class: 'preview-desc' });

    const legendId = `${this.uid}-char-legend`;
    this.charCount = h('span', { class: 'block-count' });
    // 形象数量由快照决定：手机上是一排可横向滑动的形象架，平板上自动换行成网格。
    this.charGrid = h('div', { class: 'char-grid', role: 'radiogroup', 'aria-labelledby': legendId });
    this.charGrid.addEventListener('change', () => {
      this.markEdited(this.companionForm, this.compStatus);
      this.updateCompanionPreview();
    });

    const nickId = `${this.uid}-nick`;
    this.nickInput = h('input', { id: nickId, type: 'text', maxlength: '40', autocomplete: 'off', enterkeyhint: 'next' });
    const personaId = `${this.uid}-persona`;
    const personaHintId = `${this.uid}-persona-hint`;
    this.personaInput = h('textarea', {
      id: personaId,
      rows: '5',
      maxlength: '2000',
      'aria-describedby': personaHintId,
      placeholder: '例如：说话温柔一点，偶尔开个小玩笑；我难过的时候先听我说完。',
    });
    this.personaCount = h('span', { class: 'counter' });
    for (const input of [this.nickInput, this.personaInput]) {
      input.addEventListener('input', () => {
        this.markEdited(this.companionForm, this.compStatus);
        this.updateCompanionPreview();
      });
    }

    this.compStatus = h('p', { class: 'form-status', role: 'status' });
    this.compSave = h('button', { type: 'submit', class: 'primary big' }, '保存');

    const body = h(
      'div',
      { class: 'page-body' },
      h('div', { class: 'preview' }, this.compStage, this.compStageName, this.compStageDesc),
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-title-row' },
          h('h2', { id: legendId, class: 'block-title', text: '选一个形象' }),
          this.charCount,
        ),
        this.charGrid,
      ),
      h(
        'section',
        { class: 'block panel panel-form' },
        h('label', { class: 'field', for: nickId }, h('span', { class: 'field-label', text: '怎么称呼它' }), this.nickInput),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field-label', for: personaId, text: '性格和说话方式' }),
          this.personaInput,
          h(
            'div',
            { class: 'field-foot' },
            h('small', { id: personaHintId, text: '只影响说话的语气和习惯，不会给它额外的手机权限。' }),
            this.personaCount,
          ),
        ),
      ),
    );
    const form = h(
      'form',
      {
        class: 'page-form',
        novalidate: true,
        on: {
          submit: (e: Event) => {
            e.preventDefault();
            void this.saveCompanion();
          },
        },
      },
      body,
      h('div', { class: 'page-foot' }, this.compStatus, this.compSave),
    );
    const page = h('section', { class: 'page', 'aria-labelledby': titleId, hidden: true }, bar, form);
    return { page, heading };
  }

  private buildModel(): { page: HTMLElement; heading: HTMLElement } {
    const titleId = `${this.uid}-model-title`;
    const heading = h('h1', { id: titleId, tabindex: '-1', text: '模型连接' });
    const bar = h('header', { class: 'pagebar' }, this.backButton(), h('div', { class: 'pagebar-title' }, h('div', { class: 'pagebar-text' }, heading)));

    this.modelCardTitle = h('b');
    this.modelCardText = h('span');
    this.modelCard = h(
      'div',
      { class: 'status-card', 'data-tone': 'warn' },
      icon('link', 'icon status-icon'),
      h('div', { class: 'status-text' }, this.modelCardTitle, this.modelCardText),
    );
    this.modelGuard = h('p', { class: 'notice form-guard', role: 'status', hidden: true });

    const kindTitleId = `${this.uid}-kind-title`;
    this.kindGrid = h('div', { class: 'kind-grid', role: 'radiogroup', 'aria-labelledby': kindTitleId });
    this.kindGrid.addEventListener('change', (e) => {
      const target = e.target;
      if (target instanceof HTMLInputElement && target.checked) this.switchKind(target.value as MobileProviderKind);
    });
    this.kindNote = h('p', { class: 'block-hint kind-note' });
    this.kindSection = h(
      'section',
      { class: 'block', 'aria-labelledby': kindTitleId, hidden: true },
      h('h2', { id: kindTitleId, class: 'block-title', text: '模型类型' }),
      this.kindNote,
      this.kindGrid,
    );

    const urlId = `${this.uid}-url`;
    const modelId = `${this.uid}-model`;
    const keyId = `${this.uid}-key`;
    const keyHintId = `${this.uid}-key-hint`;
    this.urlInput = h('input', {
      id: urlId,
      type: 'url',
      inputmode: 'url',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'next',
      placeholder: 'https://api.example.com/v1',
    });
    this.modelInput = h('input', {
      id: modelId,
      type: 'text',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'next',
      placeholder: '服务里的模型名称',
    });
    this.keyInput = h('input', {
      id: keyId,
      type: 'password',
      autocomplete: 'new-password',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'done',
      'aria-describedby': keyHintId,
    });
    this.keyToggle = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn field-btn',
        'aria-label': '显示密钥',
        'aria-pressed': 'false',
        'aria-controls': keyId,
        on: { click: () => this.toggleKeyVisibility() },
      },
      icon('eye'),
    );
    this.keyHint = h('small', { id: keyHintId });
    this.urlHelp = h('small');
    for (const input of [this.urlInput, this.modelInput]) {
      input.addEventListener('input', () => {
        this.markEdited(this.modelForm, this.modelStatus);
        // 地址一改，“已保存密钥”的说法就不再成立，提示要立即跟着变。
        if (this.snap) this.updateKeyHint(this.snap);
        this.modelTools?.edit();
      });
    }
    this.keyInput.addEventListener('input', () => { this.clearSuccess(this.modelStatus); this.modelTools?.edit(); });

    this.modelStatus = h('p', { class: 'form-status', role: 'status' });
    this.modelSave = h('button', { type: 'submit', class: 'primary big' }, '保存');
    this.clearKeyBtn = h(
      'button',
      { type: 'button', class: 'quiet danger', on: { click: () => this.askClearKey() } },
      '清除密钥',
    );
    this.clearKeyText = h('small');
    this.clearKeyRow = h(
      'div',
      { class: 'panel danger-row', hidden: true },
      h('span', { class: 'row-text' }, h('b', { text: '已保存的密钥' }), this.clearKeyText),
      this.clearKeyBtn,
    );

    const body = h(
      'div',
      { class: 'page-body' },
      this.modelCard,
      this.modelGuard,
      this.kindSection,
      h(
        'section',
        { class: 'block panel panel-form' },
        h(
          'label',
          { class: 'field', for: urlId },
          h('span', { class: 'field-label', text: '服务地址' }),
          this.urlInput,
          this.urlHelp,
        ),
        h('label', { class: 'field', for: modelId }, h('span', { class: 'field-label', text: '模型' }), this.modelInput),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field-label', for: keyId, text: 'API 密钥' }),
          h('div', { class: 'input-with-btn' }, this.keyInput, this.keyToggle),
          this.keyHint,
        ),
      ),
      this.clearKeyRow,
      h(
        'p',
        { class: 'footnote' },
        icon('info', 'icon icon-inline'),
        '密钥只在你点保存时交给灵伴，之后不会再显示出来。每种模型类型、每个服务地址的密钥都分开保存，换地址时不会把原来的密钥发给新地址。',
      ),
    );
    this.modelTools = new ModelTools(this.bridge, () => ({kind: this.modelKind ?? (this.snap ? activeKind(this.snap) : 'compatible'), baseUrl: this.urlInput.value.trim(), model: this.modelInput.value.trim()}),
      () => this.markEdited(this.modelForm, this.modelStatus), id => { this.modelInput.value = id; this.markEdited(this.modelForm, this.modelStatus); }, () => !!this.keyInput.value.trim(), () => { if (this.snap) this.updateKeyHint(this.snap); });
    this.clearKeyRow.before(this.modelTools.root);
    const form = h(
      'form',
      {
        class: 'page-form',
        novalidate: true,
        autocomplete: 'off',
        on: {
          submit: (e: Event) => {
            e.preventDefault();
            void this.saveModel();
          },
        },
      },
      body,
      h('div', { class: 'page-foot' }, this.modelStatus, this.modelSave),
    );
    const page = h('section', { class: 'page', 'aria-labelledby': titleId, hidden: true }, bar, form);
    return { page, heading };
  }

  private buildSheet(id: SheetId, title: string, body: Node[], options: { role?: string; closable?: boolean } = {}): HTMLElement {
    const titleId = `${this.uid}-${id}-title`;
    const heading = h('h2', { id: titleId, tabindex: '-1', class: 'sheet-title', text: title });
    this.sheetHeadings[id] = heading;
    const close =
      options.closable === false
        ? null
        : h('button', { type: 'button', class: 'icon-btn', 'aria-label': '关闭', on: { click: () => this.back() } }, icon('close'));
    return h(
      'div',
      { class: `sheet sheet-${id}`, role: options.role ?? 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, hidden: true },
      options.closable === false ? null : h('span', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      h('header', { class: 'sheet-head' }, heading, close),
      h('div', { class: 'sheet-body' }, ...body),
    );
  }

  private buildHistorySheet(): HTMLElement {
    this.historyNew = h(
      'button',
      { type: 'button', class: 'quiet wide', on: { click: () => void this.newConversation(true) } },
      icon('plus'),
      '开始新对话',
    );
    this.historyList = h('div', { class: 'history-list' });
    this.historyEmpty = h('p', { class: 'empty', text: '还没有聊天记录。' });
    return this.buildSheet('history', '聊天记录', [this.historyNew, this.historyList, this.historyEmpty]);
  }

  private buildCapabilitySheet(): HTMLElement {
    this.capSheetIcon = h('span', { class: 'cap-icon' });
    this.capSheetChip = h('span', { class: 'chip' });
    this.capSheetDesc = h('p', { class: 'cap-sheet-desc' });
    this.capSheetDetail = h('p', { class: 'detail-box' });
    this.capSheetExplain = h('p', { class: 'cap-sheet-explain' });
    this.capSheetNote = h('p', { class: 'cap-sheet-note' });
    this.capSheetAction = h('button', {
      type: 'button',
      class: 'primary wide',
      on: { click: () => this.capabilityId && void this.requestCapability(this.capabilityId) },
    });
    return this.buildSheet('capability', '能力详情', [
      h('div', { class: 'cap-sheet-head' }, this.capSheetIcon, this.capSheetChip),
      this.capSheetDesc,
      this.capSheetDetail,
      this.capSheetNote,
      this.capSheetExplain,
      this.capSheetAction,
    ]);
  }

  /** 附件预览：图片用 data URL，文本只按纯文本显示；都没有时只列名称和类型。 */
  private buildMediaSheet(): HTMLElement {
    this.mediaMeta = h('p', { class: 'media-meta' });
    this.mediaImg = h('img', { class: 'media-img', alt: '', draggable: 'false', hidden: true });
    this.mediaImg.addEventListener('error', () => {
      const m = this.mediaView;
      if (m && m.status === 'ready') {
        m.status = 'none';
        this.renderMediaSheet();
      }
    });
    this.mediaText = h('pre', { class: 'media-text', tabindex: '0', hidden: true });
    this.mediaStateText = h('p');
    this.mediaRetry = h(
      'button',
      { type: 'button', class: 'quiet', hidden: true, on: { click: () => void this.loadMediaPreview() } },
      '再试一次',
    );
    this.mediaState = h('div', { class: 'media-state', role: 'status' }, h('span', { class: 'media-state-icon' }), this.mediaStateText, this.mediaRetry);
    this.mediaStage = h('div', { class: 'media-stage' }, this.mediaImg, this.mediaText, this.mediaState);
    this.mediaNote = h('p', { class: 'footnote media-note' });
    this.mediaRemove = h(
      'button',
      { type: 'button', class: 'quiet danger wide media-remove', hidden: true, on: { click: () => this.removeFromPreview() } },
      icon('trash'),
      '不发送这个附件',
    );
    return this.buildSheet('media', '附件', [this.mediaMeta, this.mediaStage, this.mediaNote, this.mediaRemove]);
  }

  private buildConfirmDialog(): HTMLElement {
    this.confirmBody = h('p', { class: 'confirm-body' });
    this.confirmError = h('p', { class: 'form-status', 'data-tone': 'bad', role: 'alert', hidden: true });
    this.confirmCancel = h('button', { type: 'button', class: 'quiet', on: { click: () => this.back() } }, '取消');
    this.confirmOk = h('button', { type: 'button', class: 'primary danger-fill', on: { click: () => void this.runConfirm() } });
    return this.buildSheet(
      'confirm',
      '确认',
      [this.confirmBody, this.confirmError, h('div', { class: 'confirm-actions' }, this.confirmCancel, this.confirmOk)],
      { role: 'alertdialog', closable: false },
    );
  }

  /* ---------- 导航：标签、页面、弹层与系统返回键 ---------- */

  private currentTab(): Tab {
    for (const layer of this.layers) if (layer.kind === 'tab') return layer.tab;
    return 'home';
  }

  private isPageOpen(page: PageId): boolean {
    return this.layers.some((l) => l.kind === 'page' && l.page === page);
  }

  private topLayer(): Layer | undefined {
    return this.layers[this.layers.length - 1];
  }

  private push(layer: Layer): void {
    this.layers.push(layer);
    try {
      history.pushState({ familiarDepth: this.layers.length }, '');
    } catch {
      /* 某些宿主禁用了历史记录；仍可用界面上的返回按钮 */
    }
    this.applyLayers();
  }

  private back(): void {
    if (!this.layers.length) return;
    const depth = this.layers.length;
    window.clearTimeout(this.popFallback);
    try {
      history.back();
    } catch {
      /* 交给下面的兜底 */
    }
    // 宿主没有派发 popstate 时自行关闭，避免返回按钮失灵。
    this.popFallback = window.setTimeout(() => {
      if (!this.disposed && this.layers.length === depth) this.popTo(depth - 1);
    }, 350);
  }

  private onPopState(e: PopStateEvent): void {
    window.clearTimeout(this.popFallback);
    const state = e.state as { familiarDepth?: unknown } | null;
    const depth = state && typeof state.familiarDepth === 'number' ? state.familiarDepth : 0;
    if (depth < this.layers.length) this.popTo(depth);
  }

  private popTo(depth: number): void {
    const popped: Layer[] = [];
    while (this.layers.length > depth) {
      const layer = this.layers.pop();
      if (!layer) break;
      popped.push(layer);
      this.onLayerClosed(layer);
    }
    if (!popped.length) return;
    this.applyLayers();
    const jump = this.focusAfterPop;
    this.focusAfterPop = null;
    const target = jump?.el ?? popped[popped.length - 1].returnFocus;
    if (target && target.isConnected && !target.closest('[hidden],[inert]') && !(target as HTMLButtonElement).disabled) {
      target.focus({ preventScroll: true });
      if (jump?.scroll && target === jump.el) target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } else {
      const top = this.topLayer();
      if (top?.kind === 'page') this.pageHeadings[top.page].focus({ preventScroll: true });
      else if (top?.kind === 'sheet') this.sheetHeadings[top.sheet]?.focus({ preventScroll: true });
    }
    this.schedule();
  }

  private goTab(tab: Tab): void {
    if (this.layers.some((l) => l.kind !== 'tab')) return;
    const current = this.currentTab();
    if (tab === current) {
      this.views[tab].scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      return;
    }
    if (tab === 'home') {
      this.back();
      return;
    }
    const first = this.layers[0];
    if (first && first.kind === 'tab') {
      // 能力 ↔ 设置之间切换不叠加历史，返回键始终先回到小窝。
      this.layers[0] = { kind: 'tab', tab, returnFocus: null };
      this.applyLayers();
    } else {
      this.push({ kind: 'tab', tab, returnFocus: null });
    }
    this.schedule();
  }

  private openPage(page: PageId): void {
    if (!this.snap || this.disposed || this.isPageOpen(page)) return;
    const returnFocus = activeElement();
    this.push({ kind: 'page', page, returnFocus });
    this.onPageOpened(page);
    this.pageHeadings[page].focus({ preventScroll: true });
  }

  private openSheet(sheet: SheetId): void {
    if (!this.snap || this.disposed || this.layers.some((l) => l.kind === 'sheet' && l.sheet === sheet)) return;
    const returnFocus = activeElement();
    this.push({ kind: 'sheet', sheet, returnFocus });
    this.render();
    if (sheet === 'confirm') this.confirmCancel.focus({ preventScroll: true });
    else this.sheetHeadings[sheet]?.focus({ preventScroll: true });
  }

  private closeSheet(sheet: SheetId): void {
    const top = this.topLayer();
    if (top?.kind === 'sheet' && top.sheet === sheet) this.back();
  }

  private onPageOpened(page: PageId): void {
    if (page === 'backup') { this.backupView.open();
    } else if (page === 'permissions') { this.permissionView.open();
    } else if (page === 'feishu') {
      this.feishuView.open();
    } else if (page === 'care') {
      this.careView.open();
    } else if (page === 'mcp') {
      this.mcpView.open();
    } else if (page === 'context') {
      if (this.snap?.activeConversationId) this.contextView.open(this.snap.activeConversationId);
    } else if (page === 'library') {
      this.libraryView.open();
    } else if (page === 'chat') {
      this.chatPinned = true;
      this.render();
      this.scrollChatToBottom();
    } else if (page === 'companion') {
      this.companionForm.dirty = false;
      this.companionForm.floor = -1;
      this.companionForm.token += 1;
      this.shelfScrollPending = true;
      this.setFormStatus(this.compStatus, null, '');
      this.render();
    } else {
      this.modelTools.reset();
      this.modelForm.dirty = false;
      this.modelForm.floor = -1;
      this.modelForm.token += 1;
      // 打开时停在正在使用的类型上；旧宿主没有类型列表时不区分类型。
      const s = this.snap;
      const options = s ? providerOptions(s) : [];
      this.modelKind = s && options.length ? (providerOption(s, activeKind(s))?.id ?? options[0].id) : null;
      this.kindDrafts.clear();
      this.keyInput.value = '';
      this.setKeyVisible(false);
      this.setFormStatus(this.modelStatus, null, '');
      this.render();
    }
  }

  private onLayerClosed(layer: Layer): void {
    if (layer.kind === 'page') {
      if (layer.page === 'backup') { this.backupView.close();
      } else if (layer.page === 'permissions') { this.permissionView.close();
      } else if (layer.page === 'feishu') {
        this.feishuView.close();
      } else if (layer.page === 'care') {
        this.careView.close();
      } else if (layer.page === 'mcp') {
        this.mcpView.close();
      } else if (layer.page === 'context') {
        this.contextView.close();
      } else if (layer.page === 'library') {
        this.libraryView.close();
      } else if (layer.page === 'model') {
        this.modelTools.close();
        this.modelForm.token += 1;
        this.modelForm.dirty = false;
        this.modelKind = null;
        this.kindDrafts.clear();
        this.keyInput.value = '';
        this.setKeyVisible(false);
        this.setFormStatus(this.modelStatus, null, '');
      } else if (layer.page === 'companion') {
        this.companionForm.token += 1;
        this.companionForm.dirty = false;
        this.shelfScrollPending = false;
        this.setFormStatus(this.compStatus, null, '');
      }
    } else if (layer.kind === 'sheet') {
      if (layer.sheet === 'confirm') {
        this.confirmSpec = null;
        this.confirmToken += 1;
        show(this.confirmError, false);
      } else if (layer.sheet === 'capability') {
        this.capabilityId = null;
      } else if (layer.sheet === 'media') {
        // 关闭即作废还在路上的预览结果，并释放图片。
        this.mediaView = null;
        this.mediaToken += 1;
        this.mediaImg.removeAttribute('src');
        this.mediaText.textContent = '';
      }
    }
  }

  private applyLayers(): void {
    const tab = this.currentTab();
    for (const t of ['home', 'abilities', 'settings'] as const) {
      show(this.views[t], t === tab);
      setCurrent(this.dockButtons[t], t === tab);
    }
    const overlays = this.layers.filter((l) => l.kind !== 'tab');
    const topIndex = overlays.length - 1;
    for (const id of Object.keys(this.pages) as PageId[]) {
      const index = overlays.findIndex((l) => l.kind === 'page' && l.page === id);
      const el = this.pages[id];
      show(el, index >= 0);
      el.style.zIndex = index >= 0 ? String(20 + index * 2) : '';
      el.toggleAttribute('inert', index >= 0 && index !== topIndex);
    }
    let topSheet = -1;
    for (const id of ['history', 'capability', 'media', 'confirm'] as const) {
      const index = overlays.findIndex((l) => l.kind === 'sheet' && l.sheet === id);
      const el = this.sheets[id];
      show(el, index >= 0);
      el.style.zIndex = index >= 0 ? String(20 + index * 2) : '';
      el.toggleAttribute('inert', index >= 0 && index !== topIndex);
      if (index > topSheet) topSheet = index;
    }
    show(this.scrim, topSheet >= 0);
    this.scrim.style.zIndex = topSheet >= 0 ? String(19 + topSheet * 2) : '';
    this.shell.toggleAttribute('inert', overlays.length > 0);
    const top = overlays[topIndex];
    this.root.dataset.overlay = top ? (top.kind === 'page' ? top.page : top.kind === 'sheet' ? top.sheet : 'none') : 'none';
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.isComposing) return;
    const top = this.topLayer();
    if (top && top.kind !== 'tab') {
      e.preventDefault();
      this.back();
    }
  }

  /* ---------- 渲染 ---------- */

  private render(): void {
    if (this.disposed) return;
    const s = this.snap;
    if (!s) {
      this.renderBoot();
      return;
    }
    if (!this.booted) {
      this.booted = true;
      this.root.dataset.ready = 'true';
      this.root.querySelectorAll<HTMLButtonElement>('[data-needs="snap"]').forEach((b) => (b.disabled = false));
    }
    this.root.dataset.mode = s.mode;
    this.root.dataset.character = safeCharacterId(s.companion.characterId);
    show(this.ribbon, s.mode === 'preview');
    show(this.retryCard, false);

    this.renderPets(s);
    this.renderHome(s);
    this.renderResident(s);
    this.renderAbilities(s);
    this.renderSettings(s);
    this.renderChat(s);
    this.renderVoice(s);
    this.renderHistory(s);
    this.renderCapabilitySheet(s);
    this.renderMediaSheet();
    this.renderConfirm();
    this.syncCompanionForm(s);
    this.syncModelForm(s);
  }

  private renderBoot(): void {
    setText(this.homeStatus, this.fatal ? '还没连上…' : '正在唤醒灵伴…');
    this.homeDot.dataset.tone = this.fatal ? 'bad' : 'busy';
    show(this.retryCard, Boolean(this.fatal));
    setText(this.retryText, this.fatal ?? '');
    setDisabled(this.retryBtn, this.loading);
    setText(this.retryBtn, this.loading ? '正在连接…' : '重新连接');
  }

  private renderPets(s: MobileSnapshot): void {
    const id = s.companion.characterId;
    const src = imageOf(s, id);
    const replying = Boolean(s.activeReply);
    for (const img of [q<HTMLImageElement>(this.homeStage, '.pet'), q<HTMLImageElement>(this.chatEmptyStage, '.pet'), this.chatAvatar, this.setAvatar]) {
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    }
    this.homeStage.dataset.state = replying ? 'think' : 'idle';
    this.chatEmptyStage.dataset.state = replying ? 'think' : 'idle';
  }

  private renderHome(s: MobileSnapshot): void {
    const name = petName(s);
    setText(this.homeName, name);
    this.homePetBtn.setAttribute('aria-label', `摸摸${name}`);
    const configured = isConfigured(s);
    const attention = attentionTasks(s);
    let status: string;
    let tone: Tone;
    if (s.activeReply) {
      status = '正在认真回复你…';
      tone = 'busy';
    } else if (!configured) {
      status = '还没连接模型，先帮它接上吧';
      tone = 'warn';
    } else if (attention.length) {
      status = `有 ${attention.length} 件事等你处理`;
      tone = 'warn';
    } else {
      status = `${greeting()}，我在这儿陪着你`;
      tone = 'ok';
    }
    setText(this.homeStatus, status);
    this.homeDot.dataset.tone = tone;
    show(this.setupNotice, !configured);

    show(this.attentionSection, attention.length > 0);
    reconcile(
      this.attentionList,
      attention,
      (t) => t.id,
      (t) => this.createTaskCard(t, 'home'),
      (el, t) => this.updateTaskCard(el, t, 'home'),
      this.caches.homeTasks,
    );

    const conv = activeConversation(s) ?? sortedConversations(s)[0] ?? null;
    const last = conv?.messages[conv.messages.length - 1];
    if (conv && last) {
      this.continueId = conv.id;
      setText(this.continueKicker, `上次聊到 · ${relativeTime(conv.updatedAt)}`);
      setText(this.continueTitle, conversationTitle(conv));
      setText(this.continueText, `${last.role === 'user' ? '你：' : `${name}：`}${messageSummary(last).slice(0, 120)}`);
    } else {
      this.continueId = conv?.id ?? null;
      setText(this.continueKicker, '聊天');
      setText(this.continueTitle, '还没有开始聊天');
      setText(this.continueText, `和${name}打个招呼吧`);
    }

    // 能力变多后首页只放按状态汇总的小标签，详情去“能力”页看。
    const counts = CAP_STATE_ORDER.map((state) => ({ state, n: s.capabilities.filter((c) => capStateInfo(c) === CAP_STATE[state]).length }))
      .filter((x) => x.n > 0);
    const signature = counts.map((x) => `${x.state}:${x.n}`).join('|');
    if (signature !== this.capsSignature) {
      this.capsSignature = signature;
      this.capsChips.replaceChildren(
        ...(counts.length
          ? counts.map((x) => h('span', { class: 'chip', 'data-tone': CAP_STATE[x.state].tone }, `${CAP_STATE[x.state].label} ${x.n} 项`))
          : [h('span', { class: 'card-text', text: '暂时没有可用的手机能力' })]),
      );
    }

    const count = attention.length;
    show(this.dockBadge, count > 0);
    setText(this.dockBadge, count > 9 ? '9+' : String(count));
    this.dockButtons.abilities.setAttribute('aria-label', count ? `能力，${count} 件事等你处理` : '能力');
  }

  private renderAbilities(s: MobileSnapshot): void {
    // 按用途分组；核心以后新增、界面还不认识的能力放进“其他”，仍按快照显示。
    for (const g of CAP_GROUPS) {
      const group = this.capGroups[g.id];
      const items = s.capabilities.filter((c) => (capGuide(c.id)?.group ?? 'other') === g.id);
      reconcile(
        group.list,
        items,
        (c) => c.id,
        (c) => this.createCapCard(c),
        (el, c) => this.updateCapCard(el, c),
        group.cache,
      );
      show(group.section, items.length > 0);
    }
    setText(this.capEmpty, '暂时没有可显示的能力。');
    show(this.capEmpty, s.capabilities.length === 0);
    // 快照里没有的能力不显示卡片，也不假装能开启，只在末尾说明这个版本还没提供。
    const missing = (Object.keys(CAP_GUIDE) as CapabilityId[]).filter((id) => !s.capabilities.some((c) => c.id === id));
    setText(this.capMissing, missing.length ? `这个版本还没有提供：${missing.map((id) => CAP_GUIDE[id].name).join('、')}。` : '');
    show(this.capMissing, missing.length > 0 && s.capabilities.length > 0);
    reconcile(
      this.taskList,
      s.tasks,
      (t) => t.id,
      (t) => this.createTaskCard(t, 'list'),
      (el, t) => this.updateTaskCard(el, t, 'list'),
      this.caches.allTasks,
    );
    show(this.taskEmpty, s.tasks.length === 0);
  }

  private renderSettings(s: MobileSnapshot): void {
    this.updateView.sync(s.update);
    this.homeUpdateView.sync(s.update);
    this.homeUpdateView.root.hidden = !s.update?.assetName;
    this.renderPet(s);
    show(this.permissionRow, Boolean(s.permissionManagement));
    show(this.backupRow, Boolean(s.backupManagement));
    this.libraryView.sync(s);
    show(this.libraryRow, Boolean(s.library?.memory || s.library?.skills));
    show(this.mcpRow, Boolean(s.mcpManagement));
    this.mcpView.supportGithubAuth(Boolean(s.githubAuth));
    show(this.careRow, Boolean(s.careManagement));
    show(this.feishuRow, Boolean(s.feishuChannel));
    const character = characterOf(s, s.companion.characterId);
    setText(this.setName, petName(s));
    setText(this.setCompanionSub, `${character?.name ?? '伙伴'} · 形象、昵称和性格`);
    this.setAvatarWrap.dataset.character = safeCharacterId(s.companion.characterId);
    const kindLabel = providerOptions(s).length ? `${providerName(s, activeKind(s))} · ` : '';
    setText(this.setModelText, isConfigured(s) ? `${kindLabel}${s.provider.model}` : '还没连接，点这里设置');
    setText(
      this.setModeText,
      s.mode === 'preview' ? '当前是预览模式，页面里展示的是示例数据。' : '已连接到灵伴，所有改动都会实际生效。',
    );
    const r = s.runtime;
    show(this.setResidentBlock, Boolean(r));
    if (r) {
      const view = residentView(r, petName(s));
      setText(this.setResidentText, `${view.label} · 悬浮窗${r.overlayVisible ? '显示中' : '未显示'}`);
    }
  }

  /** 常驻卡片。旧版快照没有 runtime 时整块隐藏，其它功能照常。 */
  private renderResident(s: MobileSnapshot): void {
    const r = s.runtime;
    show(this.resCard, Boolean(r));
    show(this.stageBadge, Boolean(r && r.running && r.engine === 'ready'));
    if (!r) {
      this.clearRuntimeIntent();
      return;
    }
    show(this.startupBox, Boolean(s.startup));
    if (s.startup) {
      this.startupToggle.checked = s.startup.enabled;
      setDisabled(this.startupToggle, this.busy('startup') || !s.startup.overlayGranted && !s.startup.enabled);
      setText(this.startupStatus, (s.startup.overlayGranted ? '' : '请先允许悬浮窗。') + s.startup.detail + (s.startup.enabled ? ' 小米等手机还需在系统设置中允许自启动。' : ''));
    }
    const name = petName(s);
    const intent = this.runtimeIntent;
    if (intent && s.revision > intent.revision && (intent.enabled ? runtimeOn(r) || r.engine === 'failed' : !r.running)) {
      this.clearRuntimeIntent();
    }

    const view = residentView(r, name);
    const sig = `${r.running}|${r.engine}|${r.overlayVisible}`;
    if (sig !== this.runtimeSig) {
      // 实际状态变化时朗读一次；“手机暂时没有回应”的提示也随之作废。
      if (this.runtimeSig !== null) {
        this.runtimeSlow = false;
        this.announce(`常驻伙伴：${view.label}，悬浮窗${r.overlayVisible ? '显示中' : '未显示'}`);
      }
      this.runtimeSig = sig;
    }
    setText(this.resChip, view.label);
    this.resChip.dataset.tone = view.tone;
    setText(this.resLead, view.lead);
    this.resCard.dataset.tone = view.tone;

    const setFact = (key: 'service' | 'engine' | 'overlay', text: string, tone: Tone) => {
      setText(this.resFacts[key].text, text);
      this.resFacts[key].dot.dataset.tone = tone;
    };
    setFact('service', r.running ? '运行中' : '已停止', r.running ? 'ok' : 'muted');
    const engine = ENGINE_STATE[r.engine] ?? ENGINE_STATE.stopped;
    setFact('engine', engine.label, engine.tone);
    const overlayCap = s.capabilities.find((c) => c.id === 'overlay');
    if (r.overlayVisible) setFact('overlay', '显示中', 'ok');
    else if (overlayCap && overlayCap.state !== 'granted') setFact('overlay', `未显示 · ${capStateInfo(overlayCap).label}`, capStateInfo(overlayCap).tone);
    else setFact('overlay', '未显示', 'muted');

    setText(this.resDetail, r.detail);
    show(this.resDetail, Boolean(r.detail.trim()));

    for (const [id, row] of this.resHints) {
      const cap = s.capabilities.find((c) => c.id === id);
      show(row, Boolean(cap && (cap.state === 'notGranted' || cap.state === 'disconnected')));
      if (cap) q(row, '.link-btn').setAttribute('aria-label', `${cap.title}：查看授权说明`);
    }

    const on = runtimeOn(r);
    const waiting = Boolean(this.runtimeIntent);
    const pending = this.busy('runtime') || waiting;
    const target = this.runtimeIntent?.enabled ?? this.runtimeTarget;
    const cls = on && !(pending && target) ? 'quiet danger big wide' : 'primary big wide';
    if (this.resToggle.className !== cls) this.resToggle.className = cls;
    setText(
      this.resToggle,
      pending ? (target ? '正在开启…' : '正在停止…') : on ? '停止常驻' : r.engine === 'failed' ? '重新开启' : '开启常驻',
    );
    setDisabled(this.resToggle, pending || this.busy('confirm'));
    this.resCard.setAttribute('aria-busy', pending ? 'true' : 'false');

    const note = waiting
      ? '已经告诉手机了，正在等它确认…'
      : this.runtimeSlow
        ? '手机暂时没有回应，上面显示的是目前的实际状态。'
        : '';
    setText(this.resNote, note);
    show(this.resNote, Boolean(note));

    setText(
      this.resFoot,
      on
        ? '停止常驻会让它离开后台、收起悬浮窗，正在进行的回复、等你批准的事和后台任务也会一起停下。'
        : '常驻和悬浮窗分开管理：不授权悬浮窗也可以常驻，只是不会出现在桌面上。',
    );
  }

  private renderChat(s: MobileSnapshot): void {
    show(this.contextButton, Boolean(s.contextManagement && s.activeConversationId));
    const conv = activeConversation(s);
    const convId = conv?.id ?? null;
    const name = petName(s);
    if (convId !== this.chatConversationId) {
      const prev = this.chatConversationId;
      const adopted = prev === null && convId !== null && Boolean(this.adoptFrom && !this.adoptFrom.has(convId));
      this.adoptFrom = null;
      if (adopted) {
        // 核心为刚发出的话新建了会话：输入框里正在写的下一句和待发送附件跟过去，
        // 发送归属、正在打开的选择器归属也随之改到新会话。
        if (this.outgoing && this.outgoing.key === null) this.outgoing.key = convId;
        if (this.chooseOrigin && this.chooseOrigin.key === null) this.chooseOrigin.key = convId;
      } else {
        this.swapDraft(prev, convId);
      }
      this.chatConversationId = convId;
      this.caches.messages.clear();
      this.msgList.replaceChildren();
      this.chatPinned = true;
    }
    const replyingHere = Boolean(s.activeReply && s.activeReply.conversationId === convId);
    setText(this.pageHeadings.chat, conversationTitle(conv));
    setText(
      this.chatStatus,
      replyingHere
        ? `${name}正在回复…`
        : s.activeReply
          ? '另一段对话正在回复'
          : conv && conv.messages.length
            ? `和${name} · ${relativeTime(conv.updatedAt)}`
            : `和${name}的新对话`,
    );
    this.chatAvatarWrap.dataset.character = safeCharacterId(s.companion.characterId);

    const messages = conv?.messages ?? [];
    show(this.chatEmpty, messages.length === 0);
    setText(this.chatEmptyTitle, `和${name}说点什么吧`);

    const lastMsg = messages[messages.length - 1];
    let retryId: string | null = null;
    let retryFrom: MobileMessage | null = null;
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.status === 'error') {
      for (let i = messages.length - 2; i >= 0; i -= 1) {
        if (messages[i].role === 'user') {
          if (messages[i].text.trim() || attachmentsOf(messages[i]).length) {
            retryId = lastMsg.id;
            retryFrom = messages[i];
          }
          break;
        }
      }
    }

    const before = this.chatScroll.scrollHeight;
    reconcile(
      this.msgList,
      messages,
      (m) => m.id,
      (m) => this.createMessage(m),
      (el, m) => this.updateMessage(el, m, m.id === retryId ? retryFrom : null, name, s),
      this.caches.messages,
    );
    const tasks = convId ? s.tasks.filter((t) => t.conversationId === convId) : [];
    reconcile(
      this.chatTasks,
      tasks,
      (t) => t.id,
      (t) => this.createTaskCard(t, 'chat'),
      (el, t) => this.updateTaskCard(el, t, 'chat'),
      this.caches.chatTasks,
    );
    show(this.chatTasks, tasks.length > 0);

    if (this.isPageOpen('chat')) {
      if (this.chatPinned) this.scrollChatToBottom();
      else if (this.chatScroll.scrollHeight > before) show(this.jumpBtn, true);
    }

    const ended = this.reply;
    const next = s.activeReply;
    if (ended && (!next || next.conversationId !== ended.conversationId || next.messageId !== ended.messageId)) {
      this.announce(this.replyEndText(s, ended, name));
    }
    this.reply = next ? { conversationId: next.conversationId, messageId: next.messageId } : null;

    this.updateComposer(s);
    setDisabled(this.chatNewBtn, this.busy('create'));
  }

  /** 按回复消息最终的 status 朗读结果，停止或失败不会被说成“回复好了”。 */
  private replyEndText(s: MobileSnapshot, ended: { conversationId: string; messageId: string }, name: string): string {
    const conv = s.conversations.find((c) => c.id === ended.conversationId);
    const status = conv?.messages.find((m) => m.id === ended.messageId)?.status;
    if (status === 'complete') return `${name}回复好了`;
    if (status === 'stopped') return `${name}的回复已停止，没有说完`;
    if (status === 'error') return `${name}的回复没有完成`;
    return `${name}的回复结束了，请在对话里查看结果`;
  }

  /** 切换会话：把输入框和待发送附件存为原会话草稿，再换上目标会话的。只在会话 id 变化时调用，连续快照不碰输入框。 */
  private swapDraft(prev: string | null | undefined, next: string | null): void {
    if (prev !== undefined) {
      const text = this.composer.value;
      if (text) this.drafts.set(prev, text);
      else this.drafts.delete(prev);
      if (this.tray.length) this.trayDrafts.set(prev, this.tray);
      else this.trayDrafts.delete(prev);
    }
    const restored = this.drafts.get(next) ?? '';
    this.drafts.delete(next);
    if (this.composer.value !== restored) {
      this.composer.value = restored;
      this.autosizeComposer();
    }
    this.tray = this.trayDrafts.get(next) ?? [];
    this.trayDrafts.delete(next);
    this.renderTray();
  }

  /** 发送失败时把原话和原附件放回它所属会话的草稿。文字：那里已经有新内容（输入框或已存草稿）就不覆盖；
      附件：和那里新加的合并，按 id 去重，总数不超过上限。 */
  private restoreDraft(key: string | null, text: string, files: MobileAttachment[]): void {
    const current = key === this.chatConversationId;
    if (text) {
      if (current) {
        if (this.composer.value === '') {
          this.composer.value = text;
          this.autosizeComposer();
        }
      } else if (!this.drafts.get(key)) {
        this.drafts.set(key, text);
      }
    }
    if (files.length) {
      const existing = current ? this.tray : this.trayDrafts.get(key) ?? [];
      // 发送期间新加的在前保留，原附件补在后面；放不下的一定是原附件，提示才说得准。
      const merged = this.mergeAttachments(existing, files);
      if (current) {
        this.tray = merged.list;
        this.renderTray();
      } else {
        this.trayDrafts.set(key, merged.list);
      }
      if (merged.dropped) this.toast(`待发送最多 ${mediaLimits(this.snap).max} 个附件，有 ${merged.dropped} 个没能放回。`, 'error');
    }
  }

  /** 按顺序合并，前面的优先；按 id 去重，超过上限的丢弃并计数。 */
  private mergeAttachments(first: MobileAttachment[], second: MobileAttachment[]): { list: MobileAttachment[]; dropped: number } {
    const max = mediaLimits(this.snap).max;
    const seen = new Set<string>();
    const list: MobileAttachment[] = [];
    let dropped = 0;
    for (const a of [...first, ...second]) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      if (list.length >= max) dropped += 1;
      else list.push(a);
    }
    return { list, dropped };
  }

  private updateComposer(s: MobileSnapshot): void {
    const replying = Boolean(s.activeReply);
    const focusSend = document.activeElement === this.sendBtn;
    const focusStop = document.activeElement === this.stopBtn;
    show(this.sendBtn, !replying);
    show(this.stopBtn, replying);
    setDisabled(this.stopBtn, this.busy('cancel'));
    if (replying && focusSend) this.stopBtn.focus({ preventScroll: true });
    if (!replying && focusStop) this.sendBtn.focus({ preventScroll: true });
    show(this.composerNotice, !isConfigured(s));
    const files = canChoose(s);
    const camera = canCamera(s);
    const extra =
      files && camera
        ? '也可以点左下角的相机拍张照，或点回形针附上图片、文本文件。'
        : files
          ? s.media?.documents ? '回形针可添加图片、文本、PDF 或 Word（DOCX）。文档只提取文字，选好后点击发送。' : '也可以点左下角的回形针附上图片或文本文件。'
          : camera
            ? '也可以点左下角的相机拍张照。'
            : '';
    setText(this.chatEmptyHint, `想到什么就说什么${extra ? `，${extra}` : '。'}回车键换行，写好后点右下角发送。`);
    this.renderTray();
  }

  private updateSendState(): void {
    const s = this.snap;
    const hasContent = Boolean(this.composer.value.trim()) || this.tray.length > 0;
    const can = Boolean(s && isConfigured(s) && !s.activeReply && !this.busy('send') && !this.voiceLocked() && this.composer.value.length <= 8000 && hasContent);
    setDisabled(this.sendBtn, !can);
    const placeholder = this.tray.length ? '可以只发附件，也可以再说点什么…' : '想和它说点什么…';
    if (this.composer.placeholder !== placeholder) this.composer.placeholder = placeholder;
  }

  /* ---------- 待发送附件托盘 ---------- */

  /** 托盘与添加按钮。任何改动 tray 的地方都调用它；节点按 id 复用。 */
  private renderTray(): void {
    const s = this.snap;
    const lim = mediaLimits(s);
    reconcile(
      this.trayList,
      this.tray,
      (a) => a.id,
      (a) => this.createTrayItem(a),
      (el, a) => this.updateTrayItem(el, a),
      this.caches.tray,
    );
    show(this.trayBox, this.tray.length > 0);
    setText(this.trayCount, `待发送 ${this.tray.length}/${lim.max}`);

    // 文件、相机和粘贴共用选择锁，只有当前来源显示进行中。
    const choosing = this.busy('choose');
    const source = choosing ? this.chooseOrigin?.source ?? null : null;
    const full = this.tray.length >= lim.max;
    const locked = choosing || full || this.chatConversationId === undefined;
    const files = canChoose(s);
    const camera = canCamera(s);
    const paste = s?.media?.paste === true;
    show(this.attachBtn, files);
    show(this.cameraBtn, camera);
    show(this.pasteBtn, paste);
    show(this.sourceGroup, files || camera || paste);
    this.sourceGroup.dataset.count = String(Number(files) + Number(camera) + Number(paste));
    setDisabled(this.attachBtn, locked);
    setDisabled(this.cameraBtn, locked);
    setDisabled(this.pasteBtn, locked);
    this.attachBtn.setAttribute('aria-busy', source === 'files' ? 'true' : 'false');
    this.cameraBtn.setAttribute('aria-busy', source === 'camera' ? 'true' : 'false');
    this.pasteBtn.setAttribute('aria-busy', source === 'clipboard' ? 'true' : 'false');
    this.pasteBtn.setAttribute('aria-label', source === 'clipboard' ? '正在读取剪贴板图片…' : full ? `已经选了 ${lim.max} 个附件，先移除一些再粘贴` : '粘贴剪贴板图片');
    this.attachBtn.setAttribute(
      'aria-label',
      source === 'files' ? '正在选择或读取附件…' : full ? `已经选了 ${lim.max} 个附件，先移除一些再添加` : s?.media?.documents ? '添加图片、文本或文档' : '添加图片或文本文件',
    );
    this.cameraBtn.setAttribute(
      'aria-label',
      source === 'camera' ? '正在打开系统相机…' : full ? `已经选了 ${lim.max} 个附件，先移除一些再拍照` : '用系统相机拍照',
    );
    this.updateSendState();
  }

  private createTrayItem(a: MobileAttachment): HTMLElement {
    const item = h('li', { class: 'tray-item' });
    item.dataset.id = a.id;
    const open = h(
      'button',
      { type: 'button', class: 'file-chip tray-open', on: { click: () => this.openTrayItem(item.dataset.id ?? '', open) } },
      h('span', { class: 'file-thumb' }),
      h('span', { class: 'file-text' }, h('b', { class: 'file-name' }), h('small', { class: 'file-meta' })),
    );
    const remove = h(
      'button',
      { type: 'button', class: 'icon-btn tray-remove', on: { click: () => this.removeTrayItem(item.dataset.id ?? '') } },
      icon('close'),
    );
    item.append(open, remove);
    if (a.kind === 'image') void this.ensureThumb(a.id);
    return item;
  }

  private updateTrayItem(el: HTMLElement, a: MobileAttachment): void {
    const name = fileName(a);
    el.dataset.kind = a.kind;
    setText(q(el, '.file-name'), name);
    setText(q(el, '.file-meta'), fileMeta(a));
    q(el, '.tray-open').setAttribute('aria-label', `预览 ${name}，${fileMeta(a)}`);
    q(el, '.tray-remove').setAttribute('aria-label', `移除 ${name}`);
    this.fillThumb(q(el, '.file-thumb'), a, true);
  }

  /** 缩略位：托盘里的图片用已载入的预览，其余（包括聊天记录里的附件）只放类型图标，点开才加载。 */
  private fillThumb(box: HTMLElement, a: MobileAttachment, usePreview: boolean): void {
    const src = usePreview && a.kind === 'image' ? safeDataUrl(this.previewCache.get(a.id)?.dataUrl) : null;
    const want = src ? `img:${a.id}` : `icon:${a.kind}`;
    if (box.dataset.fill === want) return;
    box.dataset.fill = want;
    box.dataset.kind = a.kind;
    if (src) {
      const img = h('img', { alt: '', draggable: 'false' });
      img.src = src;
      box.replaceChildren(img);
    } else {
      box.replaceChildren(icon(a.kind === 'image' ? 'image' : 'note'));
    }
  }

  /** 只为托盘里的图片取一次缩略图；失败就保持图标，不打扰用户。 */
  private async ensureThumb(id: string): Promise<void> {
    if (!this.snap?.media || this.previewCache.has(id)) return;
    try {
      await this.fetchPreview(id);
    } catch {
      return;
    }
    if (!this.disposed && this.tray.some((a) => a.id === id)) this.renderTray();
  }

  private removeTrayItem(id: string): void {
    const index = this.tray.findIndex((a) => a.id === id);
    if (index < 0) return;
    const removed = this.tray[index];
    this.tray = this.tray.filter((a) => a.id !== id);
    this.renderTray();
    // 焦点落到下一个（或上一个）附件的移除按钮；托盘空了就回到输入框。
    const next = this.tray[index] ?? this.tray[index - 1];
    const target = next ? this.caches.tray.get(next.id)?.querySelector<HTMLElement>('.tray-remove') : null;
    if (target) target.focus({ preventScroll: true });
    else if (this.isPageOpen('chat') && this.topLayer()?.kind === 'page') this.composer.focus({ preventScroll: true });
    this.announce(`已移除 ${fileName(removed)}`);
  }

  private openTrayItem(id: string, from: HTMLElement): void {
    const a = this.tray.find((x) => x.id === id);
    if (!a) return;
    from.focus({ preventScroll: true });
    this.openMedia(a, this.chatConversationId);
  }

  /** 附件来源共用选择锁，结果只进入点击时的会话托盘；发送后才交给模型。 */
  private async chooseAttachments(source: MediaSource): Promise<void> {
    const s = this.snap;
    if (!s || this.busy('choose')) return;
    if (source === 'files' ? !canChoose(s) : source === 'camera' ? !canCamera(s) : s.media?.paste !== true) return;
    const key = this.chatConversationId;
    if (key === undefined) return;
    const lim = mediaLimits(s);
    if (this.tray.length >= lim.max) {
      this.toast(`最多 ${lim.max} 个附件，先移除一些再${source === 'camera' ? '拍照' : '添加'}。`);
      return;
    }
    const origin = { key, source };
    this.chooseOrigin = origin;
    const result = await this.run('choose', () =>
      this.bridge.request(source === 'camera' ? 'media.camera' : source === 'clipboard' ? 'media.paste' : 'media.choose', undefined),
    );
    if (this.chooseOrigin === origin) this.chooseOrigin = null;
    if (!result || this.disposed) return;
    if (!result.ok) {
      // 失败只提示，已有的文字草稿、待发送附件和进行中的回复都不动。
      const code = result.error && typeof result.error === 'object' && 'code' in result.error ? String((result.error as { code: unknown }).code) : '';
      let text: string;
      if (source === 'clipboard') {
        text = code === 'NOT_FOUND' ? '剪贴板里没有可粘贴的图片。请先复制图片；文字可在输入框长按粘贴。'
          : code === 'INVALID_INPUT' ? `没能粘贴图片：支持 PNG、JPEG、WebP 或 GIF，每张不超过 ${formatBytes(lim.image)}，一次最多 8 张。`
          : code === 'BUSY' ? '附件还在读取，请稍后再粘贴。'
          : '暂时无法读取图片。请保持聊天页面在前台，重新复制图片后再试。';
      } else if (source === 'camera') {
        text =
          code === 'INVALID_INPUT'
            ? `没能加入照片：照片需要是图片，且不超过 ${formatBytes(lim.image)}。`
            : errorText(result.error, '没能拍照');
      } else {
        text =
          code === 'INVALID_DOCUMENT' ? '没能添加附件：文档无法解析，请检查 PDF 或 DOCX 文件。'
          : code === 'LIMIT' ? `文档超过解析上限：PDF 最多 100 页，提取文字最多 ${formatBytes(lim.text)}，请拆分后再添加。`
          : code === 'INVALID_INPUT'
            ? s.media?.documents ? `没能添加附件：支持图片、文本、PDF 和 DOCX；图片及文档不超过 ${formatBytes(lim.image)}，文本不超过 ${formatBytes(lim.text)}。` : `没能添加附件：只能选图片或文本文件，图片不超过 ${formatBytes(lim.image)}，文本文件不超过 ${formatBytes(lim.text)}。`
            : errorText(result.error, '没能添加附件');
      }
      this.toast(text, 'error');
      return;
    }
    // 取消选择或取消拍照返回空数组：什么都不动。
    const picked = Array.isArray(result.value) ? result.value.filter(isAttachment) : [];
    if (!picked.length) return;
    const now = this.snap ?? s;
    if (origin.key !== null && !now.conversations.some((c) => c.id === origin.key)) {
      this.toast(source === 'camera' ? '那段对话已经不在了，拍好的照片没有加上。' : '那段对话已经不在了，选好的附件没有加上。', 'error');
      return;
    }
    this.addAttachments(origin.key, picked, source);
    if (document.activeElement === document.body && this.topLayer()?.kind === 'page' && this.isPageOpen('chat')) {
      const btn = source === 'camera' ? this.cameraBtn : source === 'clipboard' ? this.pasteBtn : this.attachBtn;
      const target = !btn.disabled && !btn.hidden ? btn : this.composer;
      target.focus({ preventScroll: true });
    }
  }

  /** 把选好的附件放进某段会话的待发送：先剔除超过大小限制的，再去重、截到上限，并说明结果。 */
  private addAttachments(key: string | null, picked: MobileAttachment[], source: MediaSource = 'files'): void {
    const lim = mediaLimits(this.snap);
    const tooBig = picked.filter((a) => overLimit(a, lim));
    const fit = picked.filter((a) => !overLimit(a, lim));
    const current = key === this.chatConversationId;
    const existing = current ? this.tray : this.trayDrafts.get(key) ?? [];
    const before = new Set(existing.map((a) => a.id));
    const merged = this.mergeAttachments(existing, fit);
    const added = merged.list.filter((a) => !before.has(a.id)).length;
    if (current) {
      this.tray = merged.list;
      this.renderTray();
    } else {
      this.trayDrafts.set(key, merged.list);
    }

    const notes: string[] = [];
    if (tooBig.length) {
      const limitText = `图片不超过 ${formatBytes(lim.image)}，文本文件不超过 ${formatBytes(lim.text)}`;
      notes.push(
        tooBig.length === 1 ? `「${fileName(tooBig[0])}」太大了，没有加上（${limitText}）` : `${tooBig.length} 个文件太大，没有加上（${limitText}）`,
      );
    }
    if (merged.dropped) notes.push(`最多 ${lim.max} 个附件，多出的 ${merged.dropped} 个没有加上`);
    if (notes.length) this.toast(`${notes.join('；')}。`, 'error');
    if (added) {
      const what = source === 'camera' ? `${added} 张照片` : `${added} 个附件`;
      if (!current) this.toast(`已把 ${what}放进原来那段对话的待发送里。`);
      else this.announce(`已加入 ${what}，点发送后才会交给模型`);
    }
  }

  /* ---------- 附件预览 ---------- */

  private fetchPreview(id: string): Promise<MobileMediaPreview> {
    const hit = this.previewCache.get(id);
    if (hit) return Promise.resolve(hit);
    let pending = this.previewInflight.get(id);
    if (!pending) {
      pending = this.bridge
        .request('media.preview', { id })
        .then((p) => {
          const clean: MobileMediaPreview = {
            attachment: p && isAttachment(p.attachment) ? p.attachment : ({ id } as MobileAttachment),
            dataUrl: safeDataUrl(p?.dataUrl) ?? undefined,
            text: typeof p?.text === 'string' ? p.text : undefined,
          };
          if (!this.disposed) {
            this.previewCache.set(id, clean);
            // 只留最近的几项，避免大图长期占内存。
            while (this.previewCache.size > 24) {
              const oldest = this.previewCache.keys().next().value;
              if (oldest === undefined) break;
              this.previewCache.delete(oldest);
            }
          }
          return clean;
        })
        .finally(() => this.previewInflight.delete(id));
      this.previewInflight.set(id, pending);
    }
    return pending;
  }

  /** 打开预览弹层；trayKey 不是 undefined 时表示从待发送托盘打开，可以在里面移除。 */
  private openMedia(a: MobileAttachment, trayKey: string | null | undefined): void {
    if (!this.snap || this.layers.some((l) => l.kind === 'sheet' && l.sheet === 'media')) return;
    this.mediaView = { att: a, trayKey, status: 'loading', preview: null, error: '' };
    this.mediaImg.removeAttribute('src');
    this.mediaText.textContent = '';
    this.openSheet('media');
    void this.loadMediaPreview();
  }

  private async loadMediaPreview(): Promise<void> {
    const view = this.mediaView;
    if (!view || this.disposed) return;
    if (!this.snap?.media && !this.previewCache.has(view.att.id)) {
      view.status = 'unsupported';
      this.renderMediaSheet();
      return;
    }
    const token = ++this.mediaToken;
    view.status = 'loading';
    view.error = '';
    this.renderMediaSheet();
    try {
      const p = await this.fetchPreview(view.att.id);
      if (this.disposed || token !== this.mediaToken || this.mediaView !== view) return;
      view.preview = p;
      view.status = p.dataUrl || p.text !== undefined ? 'ready' : 'none';
    } catch (error) {
      if (this.disposed || token !== this.mediaToken || this.mediaView !== view) return;
      view.status = 'error';
      view.error = errorText(error, '没能打开预览');
    }
    this.renderMediaSheet();
  }

  private renderMediaSheet(): void {
    const view = this.mediaView;
    if (!view) return;
    const a = view.att;
    const heading = this.sheetHeadings.media;
    if (heading) setText(heading, fileName(a));
    const mime = a.mimeType && a.mimeType.trim() ? ` · ${a.mimeType.trim()}` : '';
    setText(this.mediaMeta, `${fileMeta(a)}${mime}`);

    const p = view.status === 'ready' ? view.preview : null;
    const src = p ? safeDataUrl(p.dataUrl) : null;
    const text = p && !src && typeof p.text === 'string' ? p.text : null;
    if (src) {
      if (this.mediaImg.getAttribute('src') !== src) this.mediaImg.src = src;
      this.mediaImg.alt = `${fileName(a)}的预览`;
    } else if (this.mediaImg.hasAttribute('src')) {
      this.mediaImg.removeAttribute('src');
    }
    show(this.mediaImg, Boolean(src));
    if (text !== null) setText(this.mediaText, text);
    show(this.mediaText, text !== null);
    this.mediaText.setAttribute('aria-label', `${fileName(a)}的文本预览`);
    this.mediaStage.dataset.view = src ? 'image' : text !== null ? 'text' : 'state';

    let stateText = '';
    if (view.status === 'loading') stateText = '正在读取预览…';
    else if (view.status === 'error') stateText = view.error;
    else if (view.status === 'unsupported') stateText = '这个版本暂时不能预览附件。';
    else if (!src && text === null) stateText = '这个附件没有可显示的预览。';
    show(this.mediaState, stateText !== '');
    setText(this.mediaStateText, stateText);
    this.mediaState.dataset.tone = view.status === 'error' ? 'bad' : view.status === 'loading' ? 'busy' : 'muted';
    const stateIcon = q(this.mediaState, '.media-state-icon');
    if (stateIcon.dataset.kind !== a.kind) {
      stateIcon.dataset.kind = a.kind;
      stateIcon.replaceChildren(icon(a.kind === 'image' ? 'image' : 'note'));
    }
    show(this.mediaRetry, view.status === 'error');

    const inTray = view.trayKey !== undefined;
    const note = src
      ? '大图可能显示的是缩小后的预览。'
      : text !== null
        ? '预览可能只包含开头一部分。'
        : '';
    const where = inTray ? '附件只存在手机里，点发送后才会随消息交给当前模型。' : '这是这段对话里发过的附件。';
    setText(this.mediaNote, note ? `${note}${where}` : where);

    const removable = inTray && view.trayKey === this.chatConversationId && this.tray.some((x) => x.id === a.id);
    show(this.mediaRemove, removable);
  }

  private removeFromPreview(): void {
    const view = this.mediaView;
    if (!view || view.trayKey === undefined || view.trayKey !== this.chatConversationId) return;
    const id = view.att.id;
    const index = this.tray.findIndex((a) => a.id === id);
    if (index < 0) return;
    const removed = this.tray[index];
    this.tray = this.tray.filter((a) => a.id !== id);
    this.renderTray();
    const next = this.tray[index] ?? this.tray[index - 1];
    const target = next ? this.caches.tray.get(next.id)?.querySelector<HTMLElement>('.tray-open') : null;
    const usable = (b: HTMLButtonElement) => !b.hidden && !b.disabled;
    const fallback = usable(this.attachBtn) ? this.attachBtn : usable(this.cameraBtn) ? this.cameraBtn : this.composer;
    this.focusAfterPop = { el: target ?? fallback, scroll: false };
    this.announce(`已移除 ${fileName(removed)}`);
    this.closeSheet('media');
  }

  private autosizeComposer(): void {
    this.composer.style.height = 'auto';
    const max = 168;
    this.composer.style.height = `${Math.min(this.composer.scrollHeight + 2, max)}px`;
    this.composer.style.overflowY = this.composer.scrollHeight > max ? 'auto' : 'hidden';
  }

  private isChatNearBottom(): boolean {
    const el = this.chatScroll;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 72;
  }

  private scrollChatToBottom(): void {
    this.chatScroll.scrollTop = this.chatScroll.scrollHeight;
    show(this.jumpBtn, false);
  }

  private jumpToLatest(): void {
    this.chatPinned = true;
    this.chatScroll.scrollTo({ top: this.chatScroll.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    show(this.jumpBtn, false);
  }

  private createMessage(m: MobileMessage): HTMLElement {
    const el = h(
      'article',
      { class: `msg ${m.role === 'user' ? 'msg-user' : 'msg-assistant'}` },
      h(
        'div',
        { class: 'msg-bubble' },
        h('span', { class: 'sr-only msg-who' }),
        h('ul', { class: 'msg-files', hidden: true }),
        h('p', { class: 'msg-text' }),
        h('span', { class: 'typing', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      ),
      h(
        'div',
        { class: 'msg-meta' },
        h('time', { class: 'msg-time' }),
        h('span', { class: 'msg-state' }),
        h('button', { type: 'button', class: 'link-btn msg-retry', hidden: true, text: '再发一次' }),
        h('button', { type: 'button', class: 'link-btn msg-read', hidden: true, text: '朗读', on: { click: () => void this.readMessage(m.id) } }),
      ),
    );
    el.dataset.id = m.id;
    q(el, '.msg-retry').addEventListener('click', () => {
      // 按点击时的快照找回那句用户消息，连同它的附件一起重新发送。
      const id = el.dataset.retry;
      const s = this.snap;
      const conv = s ? activeConversation(s) : null;
      const from = id ? conv?.messages.find((x) => x.id === id) : undefined;
      if (from) void this.sendMessage({ text: from.text, attachments: attachmentsOf(from) });
    });
    return el;
  }

  private updateMessage(el: HTMLElement, m: MobileMessage, retryFrom: MobileMessage | null, name: string, s: MobileSnapshot): void {
    if (el.dataset.status !== m.status) el.dataset.status = m.status;
    setText(q(el, '.msg-who'), m.role === 'user' ? '你说：' : `${name}说：`);
    const files = attachmentsOf(m);
    const box = q(el, '.msg-files');
    // 附件按 id、名称和大小比较，没变就不重建，流式快照不会让附件闪动。
    const sig = files.map((f) => `${f.id}\u0000${f.name}\u0000${f.kind}\u0000${f.bytes}`).join('\u0001');
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.replaceChildren(...files.map((f) => this.createMessageFile(f)));
    }
    show(box, files.length > 0);
    const textEl = q(el, '.msg-text');
    setText(textEl, m.text);
    // 只有附件、没有文字的消息不留一行空白。
    show(textEl, Boolean(m.text) || files.length === 0 || m.status === 'streaming');
    el.classList.toggle('is-typing', m.status === 'streaming' && !m.text);
    const time = q(el, '.msg-time');
    setText(time, clockTime(m.createdAt));
    if (time.getAttribute('datetime') !== m.createdAt) time.setAttribute('datetime', m.createdAt);
    const stateText =
      m.status === 'streaming' ? '正在输入…' : m.status === 'stopped' ? '已停止' : m.status === 'error' ? '这条回复没有完成' : '';
    setText(q(el, '.msg-state'), stateText);
    const read = q<HTMLButtonElement>(el, '.msg-read');
    show(read, Boolean(s.voice) && m.role === 'assistant' && m.status === 'complete' && Boolean(m.text.trim()));
    read.disabled = this.voiceBusy() || this.busy('voice');
    const retry = q<HTMLButtonElement>(el, '.msg-retry');
    show(retry, retryFrom !== null);
    el.dataset.retry = retryFrom?.id ?? '';
    setDisabled(retry, this.busy('send') || Boolean(s.activeReply) || !isConfigured(s));
  }

  /** 聊天记录里的附件：只放类型图标、名称和大小，点开才按需读取预览。 */
  private createMessageFile(a: MobileAttachment): HTMLElement {
    const name = fileName(a);
    const thumb = h('span', { class: 'file-thumb' });
    this.fillThumb(thumb, a, false);
    const btn = h(
      'button',
      { type: 'button', class: 'file-chip msg-file', 'aria-label': `预览 ${name}，${fileMeta(a)}` },
      thumb,
      h('span', { class: 'file-text' }, h('b', { class: 'file-name', text: name }), h('small', { class: 'file-meta', text: fileMeta(a) })),
    );
    btn.addEventListener('click', () => this.openMedia(a, undefined));
    return h('li', { 'data-kind': a.kind }, btn);
  }

  private createTaskCard(t: MobileTask, ctx: TaskContext): HTMLElement {
    const el = h('article', { class: 'task panel' });
    el.dataset.id = t.id;
    const titleId = `${this.uid}-task-${ctx}-${Math.random().toString(36).slice(2, 8)}`;
    el.setAttribute('aria-labelledby', titleId);
    const approve = h(
      'button',
      { type: 'button', class: 'primary task-approve', on: { click: () => void this.respondTask(el.dataset.id ?? '', 'approve') } },
      icon('check'),
      '允许一次',
    );
    const stop = h('button', {
      type: 'button',
      class: 'quiet task-stop',
      on: { click: () => void this.respondTask(el.dataset.id ?? '', 'stop') },
    });
    const open =
      ctx === 'chat'
        ? null
        : h(
            'button',
            { type: 'button', class: 'quiet task-open', on: { click: () => void this.openConversation(el.dataset.conversation ?? null) } },
            '查看对话',
          );
    el.append(
      h('div', { class: 'task-head' }, h('span', { class: 'task-kind' }), h('span', { class: 'chip task-state' })),
      h('h3', { class: 'task-title', id: titleId }),
      h('div', { class: 'task-preview' }, h('span', { class: 'task-preview-label' }), h('p', { class: 'task-detail' })),
      h('p', { class: 'task-note' }),
      h('div', { class: 'task-actions' }, open, stop, approve, h('button',{type:'button',class:'quiet task-whitelist',on:{click:()=>void this.respondTask(el.dataset.id ?? '', 'approve', 'whitelist')}},'添加白名单'), h('button',{type:'button',class:'quiet task-session',on:{click:()=>void this.respondTask(el.dataset.id ?? '', 'approve', 'session')}},'允许当前会话全部')),
    );
    return el;
  }

  private updateTaskCard(el: HTMLElement, t: MobileTask, ctx: TaskContext): void {
    const s = this.snap;
    const info = TASK_STATUS[t.status] ?? TASK_STATUS.unknown;
    // 界面还不认识的新种类按通用工具处理，批准和停止仍交给核心。
    const spec = taskKind(t.kind);
    if (el.dataset.status !== t.status) el.dataset.status = t.status;
    el.dataset.conversation = t.conversationId;
    if (el.dataset.kind !== t.kind) {
      el.dataset.kind = t.kind;
      q(el, '.task-kind').replaceChildren(icon(spec.icon), document.createTextNode(spec.label));
    }
    const chip = q(el, '.task-state');
    setText(chip, info.label);
    chip.dataset.tone = info.tone;
    const title = t.title.trim() || `${spec.label}任务`;
    setText(q(el, '.task-title'), title);
    const preview = q(el, '.task-preview');
    show(preview, Boolean(t.detail.trim()));
    setText(q(el, '.task-preview-label'), t.status === 'awaitingApproval' ? spec.preview : '内容');
    setText(q(el, '.task-detail'), t.detail);
    const note = q(el, '.task-note');
    const noteText = spec.notes[t.status] ?? '';
    setText(note, noteText);
    show(note, Boolean(noteText));

    const busy = this.busy(`task:${t.id}`);
    el.setAttribute('aria-busy', busy ? 'true' : 'false');
    for (const choice of ['session','whitelist'] as const) { const b = q<HTMLButtonElement>(el, '.task-' + choice); show(b, t.status === 'awaitingApproval' && t.choices?.includes(choice) === true); setDisabled(b, busy); }
    const approve = q<HTMLButtonElement>(el, '.task-approve');
    show(approve, t.status === 'awaitingApproval');
    setDisabled(approve, busy);
    approve.setAttribute('aria-label', `批准：${title}`);
    const stop = q<HTMLButtonElement>(el, '.task-stop');
    const stopLabel = STOP_LABEL[t.status];
    show(stop, Boolean(stopLabel));
    setText(stop, stopLabel ?? '');
    if (stopLabel) stop.setAttribute('aria-label', `${stopLabel}：${title}`);
    setDisabled(stop, busy);
    if (ctx !== 'chat') {
      const open = q<HTMLButtonElement>(el, '.task-open');
      const exists = Boolean(s?.conversations.some((c) => c.id === t.conversationId));
      show(open, exists);
      setDisabled(open, this.busy('select'));
    }
    const actions = q(el, '.task-actions');
    show(actions, Array.from(actions.children).some((c) => !(c as HTMLElement).hidden));
  }

  private createCapCard(c: MobileCapability): HTMLElement {
    const el = h('article', { class: 'cap panel' });
    el.dataset.id = c.id;
    const titleId = `${this.uid}-cap-${safeCharacterId(c.id)}`;
    el.setAttribute('aria-labelledby', titleId);
    const detailBtn = h('button', {
      type: 'button',
      class: 'quiet cap-detail',
      on: { click: () => this.openCapability(el.dataset.id as CapabilityId) },
    }, '详情');
    const action = h('button', {
      type: 'button',
      class: 'primary cap-action',
      on: { click: () => void this.requestCapability(el.dataset.id as CapabilityId) },
    });
    el.append(
      h(
        'div',
        { class: 'cap-main' },
        h('span', { class: 'cap-icon', 'data-cap': c.id }, icon(capIcon(c.id))),
        h('div', { class: 'cap-text' }, h('h3', { class: 'cap-title', id: titleId }), h('p', { class: 'cap-desc' })),
      ),
      h('p', { class: 'cap-detail-text' }),
      h('div', { class: 'cap-foot' }, h('span', { class: 'chip cap-state' }), h('span', { class: 'spacer' }), detailBtn, action),
    );
    return el;
  }

  private updateCapCard(el: HTMLElement, c: MobileCapability): void {
    const info = capStateInfo(c);
    const spec = capAction(c);
    if (el.dataset.state !== c.state) el.dataset.state = c.state;
    setText(q(el, '.cap-title'), c.title);
    setText(q(el, '.cap-desc'), c.description);
    const detail = q(el, '.cap-detail-text');
    setText(detail, c.detail);
    show(detail, Boolean(c.detail.trim()));
    const chip = q(el, '.cap-state');
    setText(chip, info.label);
    chip.dataset.tone = info.tone;
    q(el, '.cap-detail').setAttribute('aria-label', `${c.title}：授权说明与详情`);
    const action = q<HTMLButtonElement>(el, '.cap-action');
    show(action, Boolean(spec));
    // 已授权时“系统设置”只是查看入口，用次要按钮，避免看起来像还要再授权一次。
    const cls = spec?.manage ? 'quiet cap-action' : 'primary cap-action';
    if (action.className !== cls) action.className = cls;
    const busy = this.busy(`cap:${c.id}`);
    setText(action, busy ? '请稍候…' : spec?.label ?? '');
    action.setAttribute('aria-label', `${c.title}：${spec?.sheetLabel ?? ''}`);
    setDisabled(action, busy || (c.id === 'accessibility' && this.busy('confirm')));
  }

  private renderHistory(s: MobileSnapshot): void {
    const list = sortedConversations(s);
    reconcile(
      this.historyList,
      list,
      (c) => c.id,
      (c) => this.createHistoryRow(c),
      (el, c) => this.updateHistoryRow(el, c, s),
      this.caches.history,
    );
    show(this.historyEmpty, list.length === 0);
    setDisabled(this.historyNew, this.busy('create'));
  }

  private createHistoryRow(c: MobileConversation): HTMLElement {
    const row = h('div', { class: 'history-row' });
    row.dataset.id = c.id;
    const open = h(
      'button',
      { type: 'button', class: 'history-open', on: { click: () => void this.selectConversation(row.dataset.id ?? '') } },
      h('span', { class: 'history-top' }, h('b', { class: 'history-title' }), h('small', { class: 'history-time' })),
      h('span', { class: 'history-preview' }),
    );
    const del = h(
      'button',
      { type: 'button', class: 'icon-btn history-delete', on: { click: () => this.askDelete(row.dataset.id ?? '') } },
      icon('trash'),
    );
    row.append(open, del);
    return row;
  }

  private updateHistoryRow(row: HTMLElement, c: MobileConversation, s: MobileSnapshot): void {
    const title = conversationTitle(c);
    const active = c.id === s.activeConversationId;
    row.classList.toggle('active', active);
    const open = q<HTMLButtonElement>(row, '.history-open');
    if (active) open.setAttribute('aria-current', 'true');
    else open.removeAttribute('aria-current');
    setText(q(row, '.history-title'), title);
    setText(q(row, '.history-time'), relativeTime(c.updatedAt));
    const last = c.messages[c.messages.length - 1];
    setText(q(row, '.history-preview'), last ? messageSummary(last).slice(0, 80) || '（空消息）' : '还没有消息');
    setDisabled(open, this.busy('select'));
    const del = q<HTMLButtonElement>(row, '.history-delete');
    const replying = s.activeReply?.conversationId === c.id;
    del.setAttribute('aria-label', replying ? `「${title}」正在回复，暂时不能删除` : `删除「${title}」`);
    setDisabled(del, replying || this.busy('confirm'));
  }

  private renderCapabilitySheet(s: MobileSnapshot): void {
    if (!this.capabilityId) return;
    const heading = this.sheetHeadings.capability;
    const c = s.capabilities.find((x) => x.id === this.capabilityId);
    if (!c) {
      if (heading) setText(heading, '能力详情');
      setText(this.capSheetDesc, '这项能力的信息暂时不可用。');
      for (const el of [this.capSheetChip, this.capSheetDetail, this.capSheetNote, this.capSheetExplain, this.capSheetAction]) show(el, false);
      return;
    }
    const info = capStateInfo(c);
    const spec = capAction(c);
    if (heading) setText(heading, c.title);
    if (this.capSheetIcon.dataset.cap !== c.id) {
      this.capSheetIcon.dataset.cap = c.id;
      this.capSheetIcon.replaceChildren(icon(capIcon(c.id)));
    }
    show(this.capSheetChip, true);
    setText(this.capSheetChip, info.label);
    this.capSheetChip.dataset.tone = info.tone;
    setText(this.capSheetDesc, c.description);
    setText(this.capSheetDetail, c.detail);
    show(this.capSheetDetail, Boolean(c.detail.trim()));
    const note = capGuide(c.id)?.note ?? '';
    setText(this.capSheetNote, note);
    show(this.capSheetNote, Boolean(note));
    if (c.id === 'accessibility') this.capSheetNote.dataset.tone = 'warn';
    else delete this.capSheetNote.dataset.tone;
    setText(this.capSheetExplain, capExplain(c));
    show(this.capSheetExplain, true);
    const busy = this.busy(`cap:${c.id}`);
    show(this.capSheetAction, Boolean(spec));
    const cls = spec?.manage ? 'quiet wide' : 'primary wide';
    if (this.capSheetAction.className !== cls) this.capSheetAction.className = cls;
    setText(this.capSheetAction, busy ? '请稍候…' : spec?.sheetLabel ?? '');
    setDisabled(this.capSheetAction, busy || this.busy('confirm'));
  }

  private renderConfirm(): void {
    const spec = this.confirmSpec;
    if (!spec) return;
    const heading = this.sheetHeadings.confirm;
    if (heading) setText(heading, spec.title);
    setText(this.confirmBody, spec.body);
    const busy = this.busy('confirm');
    const cls = spec.tone === 'primary' ? 'primary' : 'primary danger-fill';
    if (this.confirmOk.className !== cls) this.confirmOk.className = cls;
    setText(this.confirmOk, busy ? '处理中…' : spec.confirmLabel);
    setDisabled(this.confirmOk, busy);
  }

  /* ---------- 表单 ---------- */

  private markEdited(form: FormState, status: HTMLElement): void {
    form.dirty = true;
    form.edits += 1;
    this.clearSuccess(status);
  }

  private clearSuccess(status: HTMLElement): void {
    if (status.dataset.tone === 'ok' || status.dataset.tone === 'bad') this.setFormStatus(status, null, '');
  }

  private setFormStatus(el: HTMLElement, tone: Tone | null, text: string): void {
    if (tone) el.dataset.tone = tone;
    else delete el.dataset.tone;
    setText(el, text);
  }

  private syncCompanionForm(s: MobileSnapshot): void {
    reconcile(
      this.charGrid,
      s.characters,
      (c) => c.id,
      (c) => this.createCharOption(c),
      (el, c) => {
        setText(q(el, '.char-name'), c.name.trim() || '伙伴');
        setText(q(el, '.char-desc'), c.description);
        const img = q<HTMLImageElement>(el, '.char-pic img');
        const src = characterImage(c.id, c.image);
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
        el.classList.toggle('is-current', c.id === s.companion.characterId);
      },
      this.caches.chars,
    );
    setText(this.charCount, s.characters.length ? `共 ${s.characters.length} 位` : '');
    const busy = this.busy('companion');
    setDisabled(this.compSave, busy);
    setText(this.compSave, busy ? '保存中…' : '保存');
    if (!this.isPageOpen('companion')) return;
    const form = this.companionForm;
    if (!form.dirty && s.revision > form.floor) {
      form.floor = s.revision;
      this.charGrid.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((input) => {
        input.checked = input.value === s.companion.characterId;
      });
      if (this.nickInput.value !== s.companion.nickname) this.nickInput.value = s.companion.nickname;
      if (this.personaInput.value !== s.companion.persona) this.personaInput.value = s.companion.persona;
    }
    if (this.shelfScrollPending) {
      this.shelfScrollPending = false;
      // 只在打开页面后滚一次，之后用户自己滑动形象架时不再打扰。
      const checked = this.charGrid.querySelector('input:checked')?.closest<HTMLElement>('.char-option');
      if (checked) this.charGrid.scrollLeft = Math.max(0, checked.offsetLeft - (this.charGrid.clientWidth - checked.offsetWidth) / 2);
    }
    this.updateCompanionPreview();
  }

  private createCharOption(c: MobileCharacter): HTMLElement {
    const descId = `${this.uid}-char-desc-${safeCharacterId(c.id)}`;
    return h(
      'label',
      { class: 'char-option', 'data-character': safeCharacterId(c.id) },
      h('input', { type: 'radio', name: `${this.uid}-character`, value: c.id, 'aria-describedby': descId }),
      h('span', { class: 'char-pic' }, h('img', { alt: '', draggable: 'false' })),
      h('b', { class: 'char-name' }),
      h('span', { class: 'char-now', 'aria-hidden': 'true', text: '现在' }),
      h('small', { class: 'sr-only char-desc', id: descId }),
    );
  }

  private selectedCharacter(s: MobileSnapshot): string {
    return this.charGrid.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value ?? s.companion.characterId;
  }

  private updateCompanionPreview(): void {
    const s = this.snap;
    if (!s) return;
    const id = this.selectedCharacter(s);
    const character = characterOf(s, id);
    this.compStage.dataset.character = safeCharacterId(id);
    const img = q<HTMLImageElement>(this.compStage, '.pet');
    const src = imageOf(s, id);
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    const nick = this.nickInput.value.trim();
    setText(this.compStageName, nick || character?.name || '伙伴');
    // 形象架上只放名字，完整介绍放在预览下面，七个形象也不会挤成一团。
    const desc = character ? (nick && nick !== character.name ? `${character.name} · ${character.description}` : character.description) : '';
    setText(this.compStageDesc, desc.trim());
    show(this.compStageDesc, Boolean(desc.trim()));
    this.nickInput.placeholder = character?.name ?? '';
    setText(this.personaCount, `${this.personaInput.value.length}/2000`);
  }

  private async saveCompanion(): Promise<void> {
    const s = this.snap;
    if (!s || this.busy('companion')) return;
    const characterId = this.selectedCharacter(s);
    if (!characterOf(s, characterId)) {
      this.setFormStatus(this.compStatus, 'bad', '请先选一个形象。');
      return;
    }
    const form = this.companionForm;
    const token = form.token;
    const edits = form.edits;
    const revision = s.revision;
    this.setFormStatus(this.compStatus, 'busy', '正在保存…');
    const result = await this.run('companion', () =>
      this.bridge.request('companion.save', {
        characterId: characterId as CharacterId,
        nickname: this.nickInput.value.trim(),
        persona: this.personaInput.value.trim(),
      }),
    );
    if (!result || this.disposed || token !== form.token) return;
    if (result.ok) {
      if (edits === form.edits) {
        form.dirty = false;
        form.floor = revision;
      }
      this.setFormStatus(this.compStatus, 'ok', '已保存，从下一句话开始生效。');
    } else {
      this.setFormStatus(this.compStatus, 'bad', errorText(result.error, '没能保存'));
    }
    this.schedule();
  }

  /** 模型页正在查看的那一种类型的已保存连接（不含密钥）。旧宿主没有类型列表时就是当前连接。 */
  private selectedProfile(s: MobileSnapshot): ProviderSettings {
    const option = providerOption(s, this.modelKind);
    if (option) return option.profile;
    return s.provider;
  }

  /** 正在查看的是不是当前使用中的类型；旧宿主只有一种，恒为 true。 */
  private viewingActive(s: MobileSnapshot): boolean {
    return this.modelKind === null || this.modelKind === activeKind(s);
  }

  private syncModelForm(s: MobileSnapshot): void {
    const options = providerOptions(s);
    const hasKinds = options.length > 0;
    const configured = isConfigured(s);
    const active = activeKind(s);
    const activeName = providerName(s, active);
    this.modelCard.dataset.tone = configured ? 'ok' : 'warn';
    setText(this.modelCardTitle, configured ? `正在使用${hasKinds ? `：${activeName}` : '的模型连接'}` : '还没有连接模型');
    const activeNeedsKey = providerOption(s, active)?.requiresKey;
    setText(
      this.modelCardText,
      configured
        ? `${s.provider.model} · ${
            s.provider.keyConfigured ? '已保存密钥' : activeNeedsKey === false ? '不需要密钥' : '未保存密钥'
          }`
        : hasKinds
          ? '选一种模型类型，填好服务地址和模型名称后，就能开始聊天。'
          : '填写服务地址和模型名称后，就能开始聊天。',
    );

    const open = this.isPageOpen('model');
    if (open && hasKinds && !providerOption(s, this.modelKind)) {
      // 正在看的类型从快照里消失了：回到正在使用的类型，地址、模型和密钥都不沿用。
      this.modelKind = providerOption(s, active)?.id ?? options[0].id;
      this.keyInput.value = '';
      this.setKeyVisible(false);
      this.modelForm.dirty = this.kindDrafts.has(this.modelKind);
      this.modelForm.floor = -1;
    } else if (open && !hasKinds && this.modelKind !== null) {
      this.modelKind = null;
      this.kindDrafts.clear();
      this.modelForm.dirty = false;
      this.modelForm.floor = -1;
    }

    const busy = this.busy('model');
    const replying = Boolean(s.activeReply);
    show(this.kindSection, hasKinds);
    reconcile(
      this.kindGrid,
      options,
      (p) => p.id,
      (p) => this.createKindOption(p),
      (el, p) => this.updateKindOption(el, p, s, busy),
      this.caches.kinds,
    );
    setText(
      this.kindNote,
      this.viewingActive(s)
        ? '每种类型的地址、模型和密钥分开保存，切换时会显示它自己的设置。'
        : `现在仍在使用${activeName}。点下方“保存并改用”后才会换成${providerName(s, this.modelKind)}。`,
    );

    const option = providerOption(s, this.modelKind);
    setText(
      this.urlHelp,
      !hasKinds || this.modelKind === 'compatible'
        ? '填写兼容 OpenAI 格式的接口地址，通常以 /v1 结尾。'
        : option && !option.requiresKey
          ? '填写手机能访问到的服务地址，例如同一网络里的电脑或手机上的本地服务。'
          : `已填好${option?.name ?? '这个服务'}的常用地址，一般不用改；使用代理或自建转发时再修改。`,
    );

    // 清除密钥只针对正在使用的那一种、它已保存的地址；改用其他类型前先保存。
    const profile = this.selectedProfile(s);
    const canClear = this.viewingActive(s) && profile.keyConfigured;
    show(this.clearKeyRow, canClear);
    if (canClear) {
      setText(
        this.clearKeyText,
        `${hasKinds ? `${activeName} · ` : ''}${profile.baseUrl || '当前地址'}。清除后，需要密钥的服务要重新填写才能使用。`,
      );
    }
    setDisabled(this.clearKeyBtn, busy || replying || this.busy('confirm'));

    const guard = replying && open ? '正在回复中，等这句说完或停止后再保存连接设置。' : '';
    setText(this.modelGuard, guard);
    show(this.modelGuard, Boolean(guard));
    setDisabled(this.modelSave, busy || replying);
    setText(this.modelSave, busy ? '保存中…' : this.viewingActive(s) ? '保存' : '保存并改用');

    if (!open) return;
    const form = this.modelForm;
    if (!form.dirty && s.revision > form.floor) {
      form.floor = s.revision;
      if (this.urlInput.value !== profile.baseUrl) this.urlInput.value = profile.baseUrl;
      if (this.modelInput.value !== profile.model) this.modelInput.value = profile.model;
    }
    this.updateKeyHint(s);
    this.modelTools.sync(s, profile, open, busy || replying || this.voiceLocked());
  }

  private createKindOption(p: MobileProviderOption): HTMLElement {
    return h(
      'label',
      { class: 'kind-option', 'data-kind': p.id },
      h('input', { type: 'radio', name: `${this.uid}-kind`, value: p.id }),
      h('span', { class: 'kind-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'kind-text' }, h('b', { class: 'kind-name' }), h('small', { class: 'kind-sub' })),
      h('span', { class: 'kind-tag', hidden: true, text: '使用中' }),
    );
  }

  private updateKindOption(el: HTMLElement, p: MobileProviderOption, s: MobileSnapshot, busy: boolean): void {
    const name = p.name.trim() || p.id;
    const inUse = p.id === activeKind(s);
    setText(q(el, '.kind-mark'), kindMark(name));
    setText(q(el, '.kind-name'), name);
    // 小字只描述这一种类型已保存的情况，不暗示换地址后还有密钥。
    const sub = !p.requiresKey ? '可以不填密钥' : p.profile.keyConfigured ? '已保存密钥' : '需要密钥';
    setText(q(el, '.kind-sub'), sub);
    show(q(el, '.kind-tag'), inUse);
    const input = q<HTMLInputElement>(el, 'input');
    const checked = p.id === this.modelKind;
    if (input.checked !== checked) input.checked = checked;
    setDisabled(input, busy);
    input.setAttribute('aria-label', `${name}，${sub}${inUse ? '，使用中' : ''}`);
  }

  /** 切换类型：载入该类型自己的已保存连接（或本次打开期间的未保存修改），密钥输入一律清空。 */
  private switchKind(kind: MobileProviderKind): void {
    const s = this.snap;
    if (!s || kind === this.modelKind || !providerOption(s, kind)) return;
    if (this.busy('model')) {
      // 保存进行中不换类型，单选框退回原处。
      this.schedule();
      return;
    }
    const form = this.modelForm;
    const prev = this.modelKind;
    if (prev) {
      if (form.dirty) this.kindDrafts.set(prev, { baseUrl: this.urlInput.value, model: this.modelInput.value });
      else this.kindDrafts.delete(prev);
    }
    this.modelKind = kind;
    this.keyInput.value = '';
    this.setKeyVisible(false);
    const draft = this.kindDrafts.get(kind);
    const profile = this.selectedProfile(s);
    this.urlInput.value = draft?.baseUrl ?? profile.baseUrl;
    this.modelInput.value = draft?.model ?? profile.model;
    form.dirty = Boolean(draft);
    form.floor = s.revision;
    form.edits += 1;
    this.setFormStatus(this.modelStatus, null, '');
    this.render();
  }

  /** 密钥提示只针对当前类型、当前填写的地址：地址和已保存的不同，就明确说新地址还没有密钥。 */
  private updateKeyHint(s: MobileSnapshot): void {
    const profile = this.selectedProfile(s);
    const option = providerOption(s, this.modelKind);
    const requiresKey = option?.requiresKey;
    const urlChanged = !sameUrl(this.urlInput.value, profile.baseUrl);
    const knownKey = this.modelTools?.knownKey();
    let hint: string;
    let placeholder: string;
    if (knownKey === true) {
      hint = '这个地址已经保存过密钥。留空表示继续使用原来的密钥。';
      placeholder = '已保存，留空则不修改';
    } else if (knownKey === false) {
      hint = requiresKey === true ? '这个地址还没有保存过密钥，请填写后再保存。' : '这个地址还没有保存过密钥，本地服务通常可以不填。';
      placeholder = requiresKey === false ? '可以不填' : '粘贴 API 密钥';
    } else if (urlChanged && profile.keyConfigured) {
      hint =
        '换了服务地址，新地址还没有保存过密钥。密钥按类型和地址分开保存，原地址的密钥不会发给新地址' +
        (requiresKey === false ? '；本地服务通常可以不填。' : '，请为新地址重新填写。');
      placeholder = requiresKey === false ? '可以不填' : '为新地址填写密钥';
    } else if (urlChanged) {
      hint = requiresKey === true ? '这个地址还没有保存过密钥，请填写后再保存。' : '这个地址还没有保存过密钥，本地服务通常可以不填。';
      placeholder = requiresKey === false ? '可以不填' : '粘贴 API 密钥';
    } else if (profile.keyConfigured) {
      hint = '这个地址已经保存过密钥。留空表示继续使用原来的密钥。';
      placeholder = '已保存，留空则不修改';
    } else if (requiresKey === true) {
      hint = '这个服务需要密钥，填写后点保存。';
      placeholder = '粘贴 API 密钥';
    } else {
      hint = '还没有保存密钥。本地服务通常可以不填。';
      placeholder = requiresKey === false ? '可以不填' : '粘贴 API 密钥';
    }
    setText(this.keyHint, hint);
    if (this.keyInput.placeholder !== placeholder) this.keyInput.placeholder = placeholder;
  }

  private toggleKeyVisibility(): void {
    this.setKeyVisible(this.keyInput.type === 'password');
  }

  private setKeyVisible(visible: boolean): void {
    this.keyInput.type = visible ? 'text' : 'password';
    this.keyToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
    this.keyToggle.replaceChildren(icon(visible ? 'eyeOff' : 'eye'));
  }

  private async saveModel(): Promise<void> {
    const s = this.snap;
    if (!s || this.busy('model')) return;
    if (s.activeReply) {
      this.setFormStatus(this.modelStatus, 'bad', '正在回复中，等这句说完或停止后再保存。');
      return;
    }
    const kind = this.modelKind;
    const option = providerOption(s, kind);
    if (providerOptions(s).length && !option) {
      this.setFormStatus(this.modelStatus, 'bad', '这个模型类型暂时不可用，请换一种。');
      return;
    }
    const baseUrl = this.urlInput.value.trim();
    const model = this.modelInput.value.trim();
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
      this.setFormStatus(this.modelStatus, 'bad', '服务地址需要以 http:// 或 https:// 开头。');
      this.urlInput.focus();
      return;
    }
    if (!model) {
      this.setFormStatus(this.modelStatus, 'bad', '请填写模型名称。');
      this.modelInput.focus();
      return;
    }
    // 新地址不会沿用旧密钥：需要密钥的服务换了地址又没填密钥，就先请用户填写，不提交。
    const profile = this.selectedProfile(s);
    const keyReusable = this.modelTools.knownKey() ?? (profile.keyConfigured && sameUrl(baseUrl, profile.baseUrl));
    if (option?.requiresKey && !keyReusable && !this.keyInput.value.trim()) {
      this.setFormStatus(
        this.modelStatus,
        'bad',
        profile.keyConfigured ? '换了服务地址，需要为新地址重新填写密钥。' : `${option.name}需要密钥，请先填写。`,
      );
      this.keyInput.focus();
      return;
    }
    // 密钥只取一次、立即清空输入框；不回填、不保存在界面状态里。
    const typedKey = this.keyInput.value.trim();
    this.keyInput.value = '';
    this.setKeyVisible(false);
    const hadKey = typedKey.length > 0;
    const params: MobileCommands['provider.save']['params'] = { baseUrl, model };
    const advanced = this.modelTools.read();
    if (advanced) params.advanced = advanced;
    if (kind) params.kind = kind;
    if (hadKey) params.apiKey = typedKey;
    const switching = !this.viewingActive(s);
    const name = providerName(s, kind);
    const form = this.modelForm;
    const token = form.token;
    const edits = form.edits;
    const revision = s.revision;
    this.setFormStatus(this.modelStatus, 'busy', '正在保存…');
    const result = await this.run('model', () => this.bridge.request('provider.save', params));
    if (!result || this.disposed || token !== form.token) return;
    if (result.ok) {
      this.modelTools.saved(kind ?? activeKind(s), advanced);
      if (edits === form.edits) {
        form.dirty = false;
        form.floor = revision;
      }
      if (kind) {
        // 已保存的修改不再当作草稿；切走之后又改过的不动。
        const draft = this.kindDrafts.get(kind);
        if (draft && draft.baseUrl.trim() === baseUrl && draft.model.trim() === model) this.kindDrafts.delete(kind);
      }
      const what = switching ? `已保存，之后改用${name}聊天。` : '已保存。';
      this.setFormStatus(this.modelStatus, 'ok', hadKey ? `${what}密钥已交给灵伴保管。` : what);
    } else {
      // 通信超时等情况下核心可能已经写入、只是结果没传回来，所以不断言成败，也不自动重试。
      this.setFormStatus(
        this.modelStatus,
        'bad',
        `${errorText(result.error, '没能确认是否保存成功')} 请先看看上方的连接状态${
          hadKey ? '（密钥可能已经保存，也可能没有）' : ''
        }，确认后再决定是否重新保存${hadKey ? '，需要时请重新填写密钥' : ''}。`,
      );
    }
    this.schedule();
  }

  /** 只清除正在使用的那一种类型、它已保存地址上的密钥；地址和模型沿用核心当前值，不用表单里未保存的修改。 */
  private askClearKey(): void {
    const s = this.snap;
    if (!s || s.activeReply || !this.viewingActive(s)) return;
    const hasKinds = providerOptions(s).length > 0;
    const kind = hasKinds ? activeKind(s) : null;
    const target = `${hasKinds ? `${providerName(s, kind)}在` : ''}「${s.provider.baseUrl || '当前地址'}」`;
    this.openConfirm({
      title: '清除已保存的密钥？',
      body: `会清除${target}保存的密钥，其他类型和地址的密钥不受影响。清除后，需要密钥的服务要重新填写才能使用。`,
      confirmLabel: '清除',
      done: '已清除保存的密钥',
      action: () => {
        const current = this.snap;
        if (!current) return Promise.reject(new Error('no snapshot'));
        if (current.activeReply) return Promise.reject(Object.assign(new Error('replying'), { code: 'BUSY' }));
        const params: { kind?: MobileProviderKind; baseUrl: string; model: string; clearApiKey: true } = {
          baseUrl: current.provider.baseUrl,
          model: current.provider.model,
          clearApiKey: true,
        };
        // 确认期间正在使用的类型变了就不清除，免得清错一种。
        if (kind) {
          if (activeKind(current) !== kind) return Promise.reject(Object.assign(new Error('kind changed'), { code: 'NOT_FOUND' }));
          params.kind = kind;
        }
        return this.bridge.request('provider.save', params);
      },
    });
  }

  /* ---------- 对话动作 ---------- */

  private useSuggestion(text: string): void {
    this.composer.value = text;
    this.autosizeComposer();
    this.updateSendState();
    this.composer.focus();
    this.composer.setSelectionRange(text.length, text.length);
  }

  /** 不带参数时发送输入框和待发送附件；“再发一次”传入原消息的文字和附件。 */
  private async sendMessage(preset?: { text: string; attachments: MobileAttachment[] }): Promise<void> {
    const s = this.snap;
    if (!s || this.busy('send') || s.activeReply || !isConfigured(s) || this.voiceLocked()) return;
    // 新快照已到但界面还没换到那段会话时不发，免得把眼前这段的输入发进另一段。
    const shown = this.chatConversationId;
    if (shown === undefined || (activeConversation(s)?.id ?? null) !== shown) return;
    // 请求归属在点击这一刻定死；null 表示由核心原子新建会话再发送。
    const conversationId = s.activeConversationId;
    const fromComposer = preset === undefined;
    const value = (preset ? preset.text : this.composer.value).trim();
    if (value.length > 8000) { this.toast('草稿超过 8000 字，请分段发送'); return; }
    // 附件同样在点击这一刻定下；之后再加的附件留在托盘里，发送成功也不会被清掉。
    const files = preset ? preset.attachments.slice(0, mediaLimits(s).max) : [...this.tray];
    if (!value && !files.length) return;
    if (fromComposer) {
      this.composer.value = '';
      this.autosizeComposer();
      this.tray = [];
      this.renderTray();
    }
    const params: { text: string; conversationId: string | null; attachments?: string[] } = { text: value, conversationId };
    if (files.length) params.attachments = files.map((a) => a.id);
    const origin = { key: shown };
    this.outgoing = origin;
    this.adoptFrom = conversationId === null ? new Set(s.conversations.map((c) => c.id)) : null;
    this.chatPinned = true;
    const result = await this.run('send', () => this.bridge.request('message.send', params), '没有发出去');
    if (this.outgoing === origin) this.outgoing = null;
    if (result && !result.ok && !this.disposed) {
      if (origin.key === null) this.adoptFrom = null;
      // 失败时把原话和原附件放回它所属会话的草稿，不管现在看的是哪段。
      if (fromComposer) this.restoreDraft(origin.key, value, files);
    }
    this.updateSendState();
  }

  private async cancelReply(): Promise<void> {
    await this.run('cancel', () => this.bridge.request('reply.cancel', undefined), '没能停下来');
  }

  private async newConversation(fromSheet: boolean): Promise<void> {
    if (this.voiceLocked()) { this.toast('请先停止连续语音，再开始新对话'); return; }
    const s = this.snap;
    if (!s) return;
    const current = activeConversation(s);
    if (current && current.messages.length === 0) {
      // 当前已经是空白对话，不再新建一段空的。
      if (fromSheet) this.closeSheet('history');
      else this.toast('现在就是一段新对话');
      return;
    }
    // 主动新建的会话不是发送带出来的，切过去时输入框要按草稿切换，不能被“延续”。
    this.adoptFrom = null;
    const result = await this.run(
      'create',
      async () => {
        const { id } = await this.bridge.request('conversation.create', undefined);
        await this.bridge.request('conversation.select', { id });
      },
      '没能开始新对话',
    );
    if (result?.ok) {
      this.chatPinned = true;
      if (fromSheet) this.closeSheet('history');
    }
  }

  private async selectConversation(id: string): Promise<void> {
    if (this.voiceLocked()) { this.toast('请先停止连续语音，再切换会话'); return; }
    const s = this.snap;
    if (!s || !id) return;
    if (id === s.activeConversationId) {
      this.closeSheet('history');
      return;
    }
    const result = await this.run('select', () => this.bridge.request('conversation.select', { id }), '没能打开这段对话');
    if (result?.ok) {
      this.chatPinned = true;
      this.closeSheet('history');
    }
  }

  /** 进入聊天；需要时先切换到指定对话。等待期间用户离开了就不再弹出页面。 */
  private async openConversation(id: string | null): Promise<void> {
    const s = this.snap;
    if (!s) return;
    if (id && id !== s.activeConversationId && s.conversations.some((c) => c.id === id)) {
      const depth = this.layers.length;
      const result = await this.run('select', () => this.bridge.request('conversation.select', { id }), '没能打开这段对话');
      if (!result?.ok || this.layers.length !== depth || this.disposed) return;
    }
    if (this.layers.some((l) => l.kind !== 'tab')) return;
    this.openPage('chat');
  }

  private askDelete(id: string): void {
    if (this.voiceLocked()) { this.toast('请先停止连续语音，再删除会话'); return; }
    const s = this.snap;
    const conv = s?.conversations.find((c) => c.id === id);
    if (!conv) return;
    this.openConfirm({
      title: '删除这段对话？',
      body: `「${conversationTitle(conv)}」会被删除，删除后无法恢复。`,
      confirmLabel: '删除',
      done: '已删除这段对话',
      action: async () => {
        await this.bridge.request('conversation.delete', { id });
        this.drafts.delete(id);
        this.trayDrafts.delete(id);
      },
    });
  }

  private openConfirm(spec: ConfirmSpec): void {
    if (this.layers.some((l) => l.kind === 'sheet' && l.sheet === 'confirm')) return;
    this.confirmSpec = spec;
    this.confirmToken += 1;
    show(this.confirmError, false);
    this.renderConfirm();
    this.openSheet('confirm');
  }

  private async runConfirm(): Promise<void> {
    const spec = this.confirmSpec;
    if (!spec) return;
    const token = this.confirmToken;
    show(this.confirmError, false);
    const result = await this.run('confirm', spec.action);
    if (!result || this.disposed || token !== this.confirmToken) return;
    if (result.ok) {
      this.closeSheet('confirm');
      if (spec.done) this.toast(spec.done);
    } else {
      setText(this.confirmError, errorText(result.error, '没有完成'));
      show(this.confirmError, true);
    }
  }

  /* ---------- 能力与任务 ---------- */

  private openCapability(id: CapabilityId): void {
    this.capabilityId = id;
    this.openSheet('capability');
  }

  /** 按核心状态发起：未授权 / 已断开是申请，无障碍先单独确认，真正授权在系统设置页完成；
      已授权只是请宿主打开对应的系统设置页，界面不认为这会改变授权，结果以之后的快照为准。 */
  private async requestCapability(id: CapabilityId): Promise<void> {
    const c = this.snap?.capabilities.find((x) => x.id === id);
    const spec = c ? capAction(c) : null;
    if (!c || !spec) return;
    if (id === 'accessibility' && !spec.manage) {
      this.askAccessibility(c);
      return;
    }
    await this.run(
      `cap:${id}`,
      () => this.bridge.request('capability.request', { id }),
      spec.manage ? '没能打开系统设置' : '没能发起授权',
    );
  }

  private askAccessibility(c: MobileCapability): void {
    const s = this.snap;
    const name = s ? petName(s) : '灵伴';
    this.openConfirm({
      title: c.state === 'disconnected' ? '重新打开无障碍服务？' : '开启无障碍服务？',
      body:
        `开启后，${name}能读取你手机当前屏幕上显示的内容，并可以代你点击、输入和滑动；` +
        '某一步经你批准后，还可以采集当前应用的画面交给你选的模型来看，不会在后台持续录屏。' +
        '接下来会打开手机的系统设置页，需要你在那里亲自打开灵伴的无障碍服务；不想开可以直接返回，不需要时也能随时在系统设置里关闭。',
      confirmLabel: '去系统设置',
      tone: 'primary',
      done: '',
      action: () => this.bridge.request('capability.request', { id: 'accessibility' }),
    });
  }

  /* ---------- 常驻伙伴 ---------- */

  private toggleRuntime(): void {
    const s = this.snap;
    const r = s?.runtime;
    if (!s || !r || this.busy('runtime') || this.runtimeIntent) return;
    if (!runtimeOn(r)) {
      void this.setRuntime(true);
      return;
    }
    const work = backgroundWork(s);
    if (work.replying || work.approvals || work.tasks) this.askStopRuntime(s, work);
    else void this.setRuntime(false);
  }

  private async setStartup(enabled: boolean): Promise<void> {
    if (!this.snap?.startup) return;
    this.startupToggle.checked = this.snap.startup.enabled;
    await this.run('startup', async () => {
      await this.bridge.request('runtime.startup.save', { enabled });
      await this.loadSnapshot();
    }, '未能保存开机设置，请检查悬浮窗权限后重试');
  }

  private async setRuntime(enabled: boolean): Promise<void> {
    const s = this.snap;
    if (!s) return;
    const revision = s.revision;
    this.runtimeSlow = false;
    this.runtimeTarget = enabled;
    const result = await this.run(
      'runtime',
      () => this.bridge.request('runtime.set', { enabled }),
      enabled ? '没能开启常驻' : '没能停止常驻',
    );
    this.runtimeTarget = null;
    if (result?.ok) this.awaitRuntime(enabled, revision);
  }

  /** 停止时如果还有回复、待批准或进行中的任务，先说明会一起停下，再由用户确认。 */
  private askStopRuntime(s: MobileSnapshot, work: BackgroundWork): void {
    const parts: string[] = [];
    if (work.replying) parts.push('正在进行的回复会中断');
    if (work.approvals) parts.push(`${work.approvals} 件等你批准的事会取消`);
    if (work.tasks) parts.push(`${work.tasks} 件正在执行或等你操作的任务会停止`);
    this.openConfirm({
      title: '停止常驻伙伴？',
      body: `停止后，${petName(s)}会离开后台，悬浮窗也会收起。${parts.join('，')}。需要时可以再开启。`,
      confirmLabel: '停止常驻',
      done: '',
      action: async () => {
        const revision = this.snap?.revision ?? 0;
        this.runtimeSlow = false;
        await this.bridge.request('runtime.set', { enabled: false });
        this.awaitRuntime(false, revision);
      },
    });
  }

  /** 请求被接受后只记下目标，等更新的快照体现出来；超时也不自行宣布结果。 */
  private awaitRuntime(enabled: boolean, revision: number): void {
    if (this.disposed) return;
    this.clearRuntimeIntent();
    const timer = this.later(() => {
      if (this.runtimeIntent?.timer !== timer) return;
      this.runtimeIntent = null;
      this.runtimeSlow = true;
      this.schedule();
    }, 15000);
    this.runtimeIntent = { enabled, revision, timer };
    this.schedule();
  }

  private clearRuntimeIntent(): void {
    if (!this.runtimeIntent) return;
    this.cancelLater(this.runtimeIntent.timer);
    this.runtimeIntent = null;
  }

  /** 从设置跳到小窝里的常驻卡片。 */
  private goResident(): void {
    const title = q(this.resCard, '.res-title');
    if (this.currentTab() === 'home') {
      title.focus({ preventScroll: true });
      title.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      return;
    }
    this.focusAfterPop = { el: title, scroll: true };
    this.goTab('home');
  }

  private async respondTask(id: string, action: 'approve' | 'stop', choice: ApprovalChoice = 'once'): Promise<void> {
    if (!id) return;
    await this.run(
      `task:${id}`,
      () => this.bridge.request('task.respond', { id, action, choice }),
      action === 'approve' ? '没能批准' : '没能停止',
    );
  }

  /* ---------- 互动与提示 ---------- */

  private petReact(): void {
    const s = this.snap;
    if (!s) return;
    if (s.mode === 'live' && s.pet) void this.run('pet-action', () => this.bridge.request('pet.interact', { action: 'click' }), '未能与宠物互动');
    const stage = this.homeStage;
    stage.classList.remove('hop');
    void stage.offsetWidth;
    stage.classList.add('hop');
    this.later(() => stage.classList.remove('hop'), 700);
    const heart = h('span', { class: 'heart', 'aria-hidden': 'true', text: '♥' });
    heart.style.left = `${38 + Math.random() * 24}%`;
    stage.append(heart);
    this.later(() => heart.remove(), 1200);

    const line = PET_LINES[this.petTaps % PET_LINES.length].replace('{name}', petName(s));
    this.petTaps += 1;
    setText(this.petBubble, line);
    show(this.petBubble, true);
    this.cancelLater(this.bubbleTimer);
    this.bubbleTimer = this.later(() => show(this.petBubble, false), 2400);
  }

  private toast(text: string, tone: 'info' | 'error' = 'info'): void {
    const item = h('div', { class: `toast toast-${tone}`, role: tone === 'error' ? 'alert' : undefined }, h('span', { text }));
    const close = h(
      'button',
      { type: 'button', class: 'icon-btn toast-close', 'aria-label': '关闭提示', on: { click: () => item.remove() } },
      icon('close'),
    );
    item.append(close);
    this.toasts.append(item);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    this.later(() => item.remove(), tone === 'error' ? 6000 : 3200);
  }

  private announce(text: string): void {
    setText(this.announcer, '');
    this.later(() => setText(this.announcer, text), 60);
  }
}

/* ---------- 跨应用悬浮审批 ----------
   原生悬浮窗里的一张小卡片（约 336×420，最窄 280）：一次只摆一件等你批准的事和剩下几件。
   只用 MobileApprovalBridge 的 subscribe / respond / close，与 mountApp 互不相干；任务字符串一律按纯文本显示。 */

/** 换上一件新任务后，按钮先锁这么久，免得落在下层应用上的一次点击或连点误批了新任务。 */
const APPROVAL_SETTLE_MS = 600;
/** 回应已被接受、但快照迟迟没有移除这件任务时，多久后放开按钮。 */
const APPROVAL_WAIT_MS = 15000;

export function mountApproval(bridge: MobileApprovalBridge): () => void {
  const card = new ApprovalCard(bridge);
  card.start();
  return () => card.destroy();
}

class ApprovalCard {
  private readonly bridge: MobileApprovalBridge;
  private readonly root: HTMLElement;
  private readonly ownsRoot: boolean;
  private readonly priorClass: string;
  private readonly uid = `fam-ap-${Math.random().toString(36).slice(2, 8)}`;

  private snap: MobileApprovalSnapshot | null = null;
  private fatal: string | null = null;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private readonly timers = new Set<number>();
  private rafId = 0;

  /** 卡片上正在摆的任务；它还在等批准就一直摆它，不因顺序变化跳到别的任务。 */
  private shownId: string | null = null;
  private hadTask = false;
  /** 正在提交的回应。 */
  private sending: { id: string; action: 'approve' | 'stop' } | null = null;
  /** 核心已接受、等快照把它移走的任务。 */
  private waiting: { id: string; timer: number } | null = null;
  private slow = false;
  private error: string | null = null;
  private settleTimer = 0;

  private card!: HTMLElement;
  private countText!: HTMLElement;
  private taskBox!: HTMLElement;
  private kindIcon!: HTMLElement;
  private kindLabel!: HTMLElement;
  private titleEl!: HTMLElement;
  private previewLabel!: HTMLElement;
  private detailEl!: HTMLElement;
  private noteEl!: HTMLElement;
  private idleBox!: HTMLElement;
  private idleTitle!: HTMLElement;
  private idleText!: HTMLElement;
  private body!: HTMLElement;
  private statusEl!: HTMLElement;
  private actions!: HTMLElement;
  private approveBtn!: HTMLButtonElement;
  private approveLabel!: HTMLElement;
  private stopBtn!: HTMLButtonElement;
  private stopLabel!: HTMLElement;
  private sessionBtn!: HTMLButtonElement;
  private whitelistBtn!: HTMLButtonElement;
  private announcer!: HTMLElement;

  constructor(bridge: MobileApprovalBridge) {
    this.bridge = bridge;
    const existing = document.getElementById('familiar-root');
    this.ownsRoot = !existing;
    this.root = existing ?? document.body.appendChild(h('div', { id: 'familiar-root' }));
    this.priorClass = this.root.className;
  }

  start(): void {
    // 不套主界面的全屏外框：换掉 .app，只用卡片自己的样式。
    this.root.className = 'approval';
    document.documentElement.dataset.surface = 'approval';
    this.build();
    this.render();
    try {
      this.unsubscribe = this.bridge.subscribe((s) => this.accept(s));
    } catch {
      this.fatal = '暂时连不上灵伴，请稍后再打开看看。';
      this.schedule();
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.unsubscribe?.();
    } catch {
      /* 取消订阅失败不影响卸载 */
    }
    this.unsubscribe = null;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    delete document.documentElement.dataset.surface;
    if (this.ownsRoot) this.root.remove();
    else {
      this.root.replaceChildren();
      this.root.className = this.priorClass;
      for (const key of Object.keys(this.root.dataset)) delete this.root.dataset[key];
    }
  }

  private later(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private cancelLater(id: number): void {
    if (!id) return;
    window.clearTimeout(id);
    this.timers.delete(id);
  }

  private schedule(): void {
    if (this.rafId || this.disposed) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.render();
    });
  }

  private accept(s: MobileApprovalSnapshot): void {
    if (this.disposed || !s || typeof s !== 'object') return;
    if (s.protocolVersion !== 1) {
      if (!this.snap) this.fatal = '灵伴核心和这张卡片的版本不一致，请更新应用后再试。';
      this.schedule();
      return;
    }
    if (this.snap && s.revision <= this.snap.revision) return;
    this.snap = s;
    this.fatal = null;
    this.schedule();
  }

  /* ---------- 骨架 ---------- */

  private build(): void {
    const titleId = `${this.uid}-title`;
    this.countText = h('small', { class: 'ap-count', text: '正在读取…' });
    const closeBtn = h(
      'button',
      {
        type: 'button',
        class: 'ap-close',
        'aria-label': '收起卡片，不批准也不拒绝',
        on: { click: () => this.close() },
      },
      h('span', { text: '收起' }),
      icon('collapse'),
    );
    const head = h(
      'header',
      { class: 'ap-head' },
      h('span', { class: 'brand brand-s', 'aria-hidden': 'true', text: 'f.' }),
      h('span', { class: 'ap-head-text' }, h('b', { id: titleId, text: '灵伴想请你确认' }), this.countText),
      closeBtn,
    );

    this.kindIcon = h('span', { class: 'ap-kind-icon' });
    this.kindLabel = h('span');
    this.titleEl = h('h2', { class: 'ap-title' });
    this.previewLabel = h('p', { class: 'ap-label' });
    this.detailEl = h('p', { class: 'ap-detail' });
    this.noteEl = h('p', { class: 'ap-note' });
    this.taskBox = h(
      'div',
      { class: 'ap-task', hidden: true },
      h(
        'p',
        { class: 'ap-kind' },
        this.kindIcon,
        this.kindLabel,
        h('span', { class: 'chip', 'data-tone': 'warn', text: '等你确认' }),
      ),
      this.titleEl,
      this.previewLabel,
      this.detailEl,
      this.noteEl,
      h('p', { class: 'ap-foot', text: '收起不会批准，也不会拒绝，这一步会继续等你；点一下桌面上的伙伴可以再打开。' }),
    );

    this.idleTitle = h('b', { class: 'ap-idle-title', text: '正在读取…' });
    this.idleText = h('p', { class: 'ap-idle-text' });
    this.idleBox = h(
      'div',
      { class: 'ap-idle' },
      h('span', { class: 'ap-idle-mark', 'aria-hidden': 'true' }, icon('check')),
      this.idleTitle,
      this.idleText,
      h('button', { type: 'button', class: 'quiet wide', on: { click: () => this.close() } }, '收起'),
    );

    this.body = h(
      'div',
      { class: 'ap-body', tabindex: '0', role: 'region', 'aria-label': '任务内容' },
      this.taskBox,
      this.idleBox,
    );

    this.statusEl = h('p', { class: 'ap-status', role: 'status' });
    this.stopLabel = h('span', { text: '拒绝这一步' });
    this.stopBtn = h(
      'button',
      { type: 'button', class: 'quiet danger', on: { click: () => void this.respond('stop') } },
      icon('close'),
      this.stopLabel,
    );
    this.approveLabel = h('span', { text: '允许一次' });
    this.approveBtn = h(
      'button',
      { type: 'button', class: 'primary', on: { click: () => void this.respond('approve') } },
      icon('check'),
      this.approveLabel,
    );
    this.sessionBtn = h('button', { type: 'button', class: 'quiet', on: { click: () => void this.respond('approve', 'session') } }, '允许当前会话全部');
    this.whitelistBtn = h('button', { type: 'button', class: 'quiet', on: { click: () => void this.respond('approve', 'whitelist') } }, '添加白名单');
    this.actions = h(
      'footer',
      { class: 'ap-actions', hidden: true },
      this.statusEl,
      h('div', { class: 'ap-buttons' }, this.stopBtn, this.approveBtn, this.whitelistBtn, this.sessionBtn),
    );

    this.announcer = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    this.card = h('section', { class: 'ap-card', 'aria-labelledby': titleId }, head, this.body, this.actions);
    this.root.replaceChildren(this.card, this.announcer);
  }

  /* ---------- 渲染 ---------- */

  private pendingTasks(): MobileTask[] {
    const tasks = this.snap && Array.isArray(this.snap.tasks) ? this.snap.tasks : [];
    return tasks.filter((t) => t && typeof t.id === 'string' && t.id && t.status === 'awaitingApproval');
  }

  private render(): void {
    if (this.disposed) return;
    this.root.dataset.ready = this.snap ? 'true' : 'false';
    const pending = this.pendingTasks();

    if (this.waiting && !pending.some((t) => t.id === this.waiting?.id)) this.clearWaiting();

    const current = pending.find((t) => t.id === this.shownId) ?? pending[0] ?? null;
    const nextId = current?.id ?? null;
    if (nextId !== this.shownId) this.switchTo(current);

    const others = Math.max(0, pending.length - 1);
    if (!this.snap) setText(this.countText, this.fatal ? '暂时连不上' : '正在读取…');
    else if (!current) setText(this.countText, '没有等你确认的事');
    else setText(this.countText, others > 0 ? `还有 ${others} 件在后面排队` : '只有这一件');

    show(this.taskBox, Boolean(current));
    show(this.actions, Boolean(current));
    show(this.idleBox, !current);
    this.root.dataset.state = current ? 'task' : this.fatal ? 'error' : this.snap ? 'idle' : 'loading';

    if (!current) {
      if (this.fatal && !this.snap) {
        setText(this.idleTitle, '没有连上灵伴');
        setText(this.idleText, this.fatal);
      } else if (!this.snap) {
        setText(this.idleTitle, '正在读取…');
        setText(this.idleText, '');
      } else {
        setText(this.idleTitle, '都处理好了');
        setText(this.idleText, this.hadTask ? '这一步已经处理好了，现在没有别的事等你确认。' : '现在没有等你确认的事。');
      }
      return;
    }

    const spec = taskKind(current.kind);
    if (this.kindIcon.dataset.icon !== spec.icon) {
      this.kindIcon.dataset.icon = spec.icon;
      this.kindIcon.replaceChildren(icon(spec.icon));
    }
    this.kindIcon.dataset.kind = current.kind;
    setText(this.kindLabel, spec.label);
    setText(this.titleEl, current.title.trim() || '它想做一件事');
    setText(this.previewLabel, spec.preview);
    // 详情原样显示（只按文本），不省略也不改写参数；空白时才给一句说明。
    const hasDetail = typeof current.detail === 'string' && current.detail.trim() !== '';
    setText(this.detailEl, hasDetail ? current.detail : '没有附带更多内容。');
    this.detailEl.classList.toggle('ap-detail-empty', !hasDetail);
    setText(this.noteEl, spec.notes.awaitingApproval ?? '看看它打算做什么，允许后才会执行。');

    const sendingThis = this.sending?.id === current.id ? this.sending : null;
    const waitingThis = this.waiting?.id === current.id;
    const locked = Boolean(this.sending) || waitingThis || this.settleTimer !== 0;
    setDisabled(this.sessionBtn, locked);
    setDisabled(this.whitelistBtn, locked);
    show(this.sessionBtn, current.choices?.includes('session') === true);
    show(this.whitelistBtn, current.choices?.includes('whitelist') === true);
    setDisabled(this.approveBtn, locked);
    setDisabled(this.stopBtn, locked);
    this.card.setAttribute('aria-busy', sendingThis || waitingThis ? 'true' : 'false');
    setText(this.approveLabel, sendingThis?.action === 'approve' ? '正在允许…' : '允许一次');
    setText(this.stopLabel, sendingThis?.action === 'stop' ? '正在拒绝…' : '拒绝这一步');
    const title = current.title.trim() || spec.label;
    this.approveBtn.setAttribute('aria-label', `允许一次：${title}`);
    this.stopBtn.setAttribute('aria-label', `拒绝这一步：${title}`);

    let status = '';
    let tone = '';
    if (waitingThis) status = '已经告诉灵伴了，正在等它确认…';
    else if (this.error) {
      status = this.error;
      tone = 'bad';
    } else if (this.slow) {
      status = '暂时没有收到确认，这一步仍在等你决定，可以再选一次。';
      tone = 'warn';
    }
    setText(this.statusEl, status);
    show(this.statusEl, status !== '');
    if (tone) this.statusEl.dataset.tone = tone;
    else delete this.statusEl.dataset.tone;
  }

  /** 换任务：清掉上一件的错误和等待，按钮短暂锁住，并把内容滚回顶部。 */
  private switchTo(task: MobileTask | null): void {
    this.shownId = task?.id ?? null;
    this.error = null;
    this.slow = false;
    this.cancelLater(this.settleTimer);
    this.settleTimer = 0;
    this.body.scrollTop = 0;
    if (task) {
      this.hadTask = true;
      this.settleTimer = this.later(() => {
        this.settleTimer = 0;
        this.schedule();
      }, APPROVAL_SETTLE_MS);
      this.taskBox.classList.remove('ap-enter');
      void this.taskBox.offsetWidth;
      this.taskBox.classList.add('ap-enter');
      this.announce(`灵伴想请你确认：${task.title.trim() || taskKind(task.kind).label}`);
    } else if (this.hadTask) {
      this.announce('都处理好了');
    }
  }

  /* ---------- 动作 ---------- */

  private async respond(action: 'approve' | 'stop', choice: ApprovalChoice = 'once'): Promise<void> {
    const id = this.shownId;
    if (!id || this.disposed || this.sending || this.waiting?.id === id || this.settleTimer) return;
    this.sending = { id, action };
    this.error = null;
    this.slow = false;
    this.schedule();
    try {
      await this.bridge.respond(id, action, choice);
      if (this.disposed) return;
      this.sending = null;
      // 快照可能已经先一步把它移走；还在的话，等新快照确认，不自行宣布成功。
      if (this.pendingTasks().some((t) => t.id === id)) {
        const timer = this.later(() => {
          if (this.waiting?.timer !== timer) return;
          this.waiting = null;
          this.slow = true;
          this.schedule();
        }, APPROVAL_WAIT_MS);
        this.waiting = { id, timer };
      }
    } catch (error) {
      if (this.disposed) return;
      this.sending = null;
      if (this.shownId === id) {
        const code =
          error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
        this.error =
          code === 'NOT_FOUND'
            ? '这一步可能已经在灵伴里处理过了。'
            : errorText(error, action === 'approve' ? '没能允许这一步' : '没能拒绝这一步');
      }
    } finally {
      if (!this.disposed) this.schedule();
    }
  }

  private clearWaiting(): void {
    if (!this.waiting) return;
    this.cancelLater(this.waiting.timer);
    this.waiting = null;
  }

  /** 只是收起卡片：不批准也不拒绝，待办继续等待。 */
  private close(): void {
    if (this.disposed) return;
    try {
      this.bridge.close();
    } catch {
      /* 收起失败时卡片保持原样，用户仍可选择允许或拒绝 */
    }
  }

  private announce(text: string): void {
    setText(this.announcer, '');
    this.later(() => setText(this.announcer, text), 60);
  }
}
