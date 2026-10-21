/** Android 前端与 Familiar 核心的版本化边界；不含宿主实现与密钥回填。 */
import type { MobileLibraryCommands } from "./library.ts";
import type { MobileMcpCommands } from "./mcp.ts";
import type { MobileGithubCommands } from "./github.ts";
import type { MobileBackupCommands } from "./backup.ts";
export * from "./backup.ts";
import type { ToolPolicy, ApprovalChoice } from "../contracts/agent.ts";
export type { ToolPolicy, ApprovalChoice } from "../contracts/agent.ts";
export * from './github.ts';
import type { MobileCareCommands } from "./care.ts";
import type { MobileFeishuCommands } from "./feishu.ts";
import type { MobileStartup } from "./startup.ts";
export * from "./startup.ts";
export * from "./feishu.ts";
export * from "./care.ts";
export * from "./mcp.ts";
import type { MobileModelCommands, MobileProviderAdvanced } from "./model.ts";
export * from "./model.ts";
export * from "./library.ts";
export const MOBILE_PROTOCOL_VERSION = 1 as const;
export const MOBILE_CHARACTER_IDS = [
  "mori",
  "youzi",
  "luna",
  "diandian",
  "fangfang",
  "lili",
  "mianmian",
] as const;
export type CharacterId = (typeof MOBILE_CHARACTER_IDS)[number];
export const MOBILE_PROVIDER_KINDS = [
  "compatible",
  "openai",
  "deepseek",
  "gemini",
  "claude",
  "openrouter",
  "llamacpp",
] as const;
export type MobileProviderKind = (typeof MOBILE_PROVIDER_KINDS)[number];
export interface MobileCharacter {
  id: CharacterId;
  name: string;
  description: string;
  image: string;
}
export interface MobileMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "complete" | "streaming" | "stopped" | "error";
  createdAt: string;
  attachments?: MobileAttachment[];
}
/** 已导入本地媒体库的引用；文件路径、URI 和原始文件内容不进入快照。 */
export interface MobileAttachment {
  id: string;
  name: string;
  kind: "image" | "text";
  mimeType: string;
  bytes: number;
}
export interface MobileMediaPreview {
  attachment: MobileAttachment;
  /** 仅 PNG/JPEG/WebP/GIF 的 data URL，可能是缩略图；缺少时仍可发送原附件。 */
  dataUrl?: string;
  /** 限长文本预览，不是完整附件。 */
  text?: string;
}
export interface MobileVoiceProfile {
  kind: "compatible" | "openrouter";
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
}
export interface MobileVoiceSettings {
  stt: MobileVoiceProfile;
  tts: Omit<MobileVoiceProfile, "kind"> & { kind: MobileVoiceProfile["kind"] | "system"; voice: string; speed: number; stream?: boolean };
  autoRead: boolean;
  continuous: boolean;
}
export interface MobileVoice {
  localTts?: boolean;
  /** 已安装一次听写界面；识别应用可能联网，结果只回到草稿。 */
  systemInput?: boolean;
  live?: { mode: "chained" | "realtime"; profile: { kind: "openai" | "gemini"; baseUrl: string; model: string; voice: string; keyConfigured: boolean }; configured: boolean; problems: string[]; summary: string };
  wake?: { enabled: boolean; phrases: string[]; sensitivity: number; armed: boolean; listening: boolean; message: string };
  settings: MobileVoiceSettings;
  state: {
    phase: "off" | "sleeping" | "connecting" | "listening" | "recording" | "thinking" | "speaking" | "error";
    active: boolean;
    dictating: boolean;
    sessionMode?: "dictation" | "conversation";
    message: string;
    error?: string;
  };
  /** 本轮识别结果只属于开始录音时的会话；UI 按 id 消费一次，不自动发送。 */
  dictation?: { id: string; text: string; conversationId: string | null };
  maxRecordingSeconds: number;
}
export interface MobileConversation {
  id: string;
  title: string;
  updatedAt: string;
  messages: MobileMessage[];
}
export interface ProviderSettings {
  /** 旧宿主缺少时按 compatible 展示。 */
  kind?: MobileProviderKind;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  advanced?: MobileProviderAdvanced;
}
export interface MobileProviderOption {
  id: MobileProviderKind;
  name: string;
  requiresKey: boolean;
  /** 此供应商已保存的连接，未保存时为核心提供的默认地址；不包含密钥。 */
  profile: ProviderSettings;
}
export type CapabilityId =
  | "calendar"
  | "notes"
  | "accessibility"
  | "overlay"
  | "notifications"
  | "battery"
  | "microphone"
  | "location"
  | "files"
  /** camera 的 granted 表示存在系统相机处理器，不表示本应用获得 CAMERA 权限。 */
  | "camera";
export interface MobileCapability {
  id: CapabilityId;
  title: string;
  description: string;
  state: "unavailable" | "notGranted" | "granted" | "disconnected";
  detail: string;
}
export interface MobileTask {
  id: string;
  kind: "calendar" | "notes" | "accessibility" | "tool";
  title: string;
  detail: string;
  status:
    | "awaitingApproval"
    | "running"
    | "requiresUserAction"
    | "completed"
    | "stopped"
    | "failed"
    | "unknown";
  conversationId: string;
  choices?: ApprovalChoice[];
}
/** 独立悬浮审批表面，只接收待批准任务，不接收聊天记录或模型配置。 */
export interface MobileApprovalSnapshot {
  protocolVersion: 1;
  revision: number;
  tasks: MobileTask[];
}
export interface MobileApprovalBridge {
  subscribe(listener: (snapshot: MobileApprovalSnapshot) => void): () => void;
  /** 仅批准这一项；stop 拒绝这一项，仍由核心决定后续回复。 */
  respond(id: string, action: "approve" | "stop", choice?: ApprovalChoice): Promise<void>;
  /** 收起卡片，不批准也不拒绝；点击宠物可再次展开。 */
  close(): void;
}
export interface MobileSnapshot {
  protocolVersion: 1;
  revision: number;
  mode: "preview" | "live";
  characters: MobileCharacter[];
  companion: { characterId: CharacterId; nickname: string; persona: string };
  provider: ProviderSettings;
  providers?: MobileProviderOption[];
  conversations: MobileConversation[];
  activeConversationId: string | null;
  activeReply: { conversationId: string; messageId: string } | null;
  capabilities: MobileCapability[];
  tasks: MobileTask[];
  /** 共享核心提供的管理能力；旧宿主缺少时不显示入口。 */
  library?: { memory: boolean; skills: boolean };
  modelManagement?: boolean;
  contextManagement?: boolean;
  mcpManagement?: boolean;
  permissionManagement?: boolean;
  backupManagement?: boolean;
  githubAuth?: boolean;
  careManagement?: boolean;
  feishuChannel?: boolean;
  startup?: MobileStartup;
  /** 缺少时不显示可用附件入口；选择与预览只在本地，点击发送后交给所选模型。 */
  media?: { choose: boolean; camera?: boolean; paste?: boolean; documents?: boolean; maxAttachments: number; maxBytes: number; maxTextBytes: number };
  /** 缺少时隐藏语音操作；系统麦克风授权仍由 capabilities 提供。 */
  voice?: MobileVoice;
  pet?: { scale: number; visible: boolean; quiet: boolean; bubbleSeconds: number; action: "idle" | "greet" | "happy" | "think" | "sleep" | "drag";
    docking?: { snapToEdge: boolean; hideWhenIdle: boolean; delaySeconds: number; tucked: boolean } };
  /** 可选以兼容前端演示；Android 宿主必须提供实际服务状态。 */
  runtime?: {
    running: boolean;
    overlayVisible: boolean;
    engine: "starting" | "ready" | "stopped" | "failed";
    detail: string;
  };
}
export interface MobileCommands extends MobileLibraryCommands, MobileModelCommands, MobileMcpCommands, MobileCareCommands, MobileFeishuCommands, MobileGithubCommands, MobileBackupCommands {
  "policy.get": { params: undefined; result: ToolPolicy };
  "policy.set": { params: ToolPolicy; result: ToolPolicy };
  "policy.resetSession": { params: undefined; result: void };
  "pet.settings.save": { params: { scale: number; visible: boolean; quiet: boolean; bubbleSeconds: number }; result: void };
  "pet.docking.save": { params: { snapToEdge: boolean; hideWhenIdle: boolean; delaySeconds: number }; result: void };
  "runtime.startup.save": { params: { enabled: boolean }; result: MobileStartup };
  "pet.interact": { params: { action: "click" | "sleep" | "recall" | "reset-position" }; result: void };
  "snapshot.get": { params: undefined; result: MobileSnapshot };
  "companion.save": {
    params: { characterId: CharacterId; nickname: string; persona: string };
    result: void;
  };
  /** 保存并启用所选类型；未传 kind 时沿用当前类型。后台有回复时返回 BUSY。 */
  "provider.save": {
    params: {
      kind?: MobileProviderKind;
      baseUrl: string;
      model: string;
      apiKey?: string;
      clearApiKey?: boolean;
      advanced?: MobileProviderAdvanced;
    };
    result: void;
  };
  "conversation.create": { params: undefined; result: { id: string } };
  "conversation.select": { params: { id: string }; result: void };
  "conversation.delete": { params: { id: string }; result: void };
  /** 绑定发送时的会话；null 必须原子创建、选中并发送，单次发布新状态，不能先发布未选中的新会话。 */
  "message.send": {
    params: { text: string; conversationId: string | null; attachments?: string[] };
    result: void;
  };
  /** 系统选择器；取消返回 []，一次最多 8 个；不等于发送。 */
  "media.choose": { params: undefined; result: MobileAttachment[] };
  "media.paste": { params: undefined; result: MobileAttachment[] };
  /** 调用系统相机，确认后导入一张照片；系统返回取消（含相机拒绝授权后取消）为 []。
   * 无处理器/启动或导入失败报错，不等于发送，也不请求本应用 CAMERA 权限。 */
  "media.camera": { params: undefined; result: MobileAttachment[] };
  "media.preview": { params: { id: string }; result: MobileMediaPreview };
  /** 密钥按 stt/tts、类型和地址分别保存，不回填，不复用聊天模型密钥。 */
  "voice.save": {
    params: {
      stt: Omit<MobileVoiceProfile, "keyConfigured"> & { apiKey?: string; clearApiKey?: boolean };
      tts: Omit<MobileVoiceSettings["tts"], "keyConfigured"> & { apiKey?: string; clearApiKey?: boolean };
      autoRead: boolean;
      continuous: boolean;
    };
    result: void;
  };
  /** 必须用户显式开始。dictation 转写后放入原会话草稿；conversation 连续对话可发送识别文字。 */
  "voice.start": { params: { mode: "dictation" | "conversation"; conversationId: string | null }; result: void };
  "voice.finish": { params: undefined; result: void };
  /** 停止录音、转写、播放及语音触发的回复，迟到结果不能重新开启。 */
  "voice.stop": { params: undefined; result: void };
  "voice.read": { params: { conversationId: string; messageId: string }; result: void };
  "voice.local.catalog": { params: undefined; result: { voices: { id: string; name: string }[]; note: string } };
  "voice.system.input": { params: { conversationId: string | null }; result: { text: string | null } };
  "voice.live.save": { params: { mode: "chained" | "realtime"; kind: "openai" | "gemini"; baseUrl: string; model: string; voice: string; apiKey?: string; clearApiKey?: boolean }; result: void };
  "voice.wake.save": { params: { enabled: boolean; phrases: string[]; sensitivity: number }; result: void };
  /** 仅前台显式点击启动；重启不自动监听，命中后可向已配置的识别服务发送有界片段。 */
  "voice.wake.start": { params: { conversationId: string | null }; result: void };
  "reply.cancel": { params: undefined; result: void };
  /** 用户显式启动或停止后台伙伴；停止取消当前回复及其等待批准的任务，并释放后台表面。 */
  "runtime.set": { params: { enabled: boolean }; result: void };
  /** 未授权时申请；已授权的系统权限打开设置供查看/撤回。notes/files 不使用此入口。 */
  "capability.request": { params: { id: CapabilityId }; result: void };
  "task.respond": {
    params: { id: string; action: "approve" | "stop"; choice?: ApprovalChoice };
    result: void;
  };
}
export type MobileCommand = keyof MobileCommands;
export interface MobileBridge {
  request<K extends MobileCommand>(
    method: K,
    params: MobileCommands[K]["params"],
  ): Promise<MobileCommands[K]["result"]>;
  /** 每次提供完整快照，返回取消订阅函数；UI 不修改快照、不自行持久化。 */
  subscribe(listener: (snapshot: MobileSnapshot) => void): () => void;
}

export class MobileBridgeError extends Error {
  constructor(
    public readonly code:
      | "UNAVAILABLE"
      | "INVALID_INPUT"
      | "BUSY"
      | "NOT_FOUND"
      | "STORAGE"
      | "PROVIDER"
      | "CONFLICT"
      | "LIMIT"
      | "INVALID_DOCUMENT"
      | "DOCUMENT_EMPTY"
      | "DOCUMENT_PASSWORD"
      | "DOCUMENT_TIMEOUT"
      | "CANCELLED",
    message: string,
  ) {
    super(message);
    this.name = "MobileBridgeError";
  }
}
