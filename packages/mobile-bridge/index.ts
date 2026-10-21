import {
  MOBILE_PROTOCOL_VERSION,
  MobileBridgeError,
  MOBILE_CHARACTER_IDS,
  MOBILE_PROVIDER_KINDS,
  type MobileBridge,
  type MobileCommand,
  type MobileCommands,
  type MobileSnapshot,
  type MobileAttachment,
  type MobileMediaPreview,
} from "../mobile-contracts/index.ts";
import { projectBackup } from "./backup.ts";
import { projectPolicy } from "./policy.ts";
import { projectLibraryResult } from "./library.ts";
import { projectMcpResult } from "./mcp.ts";
import { projectGithubAuth } from './github.ts';
import { projectCareResult } from "./care.ts";
import { projectFeishuResult } from "./feishu.ts";
import { validStartup, projectStartup } from "./startup.ts";
import { projectModelResult, validAdvanced, projectAdvanced } from "./model.ts";

export interface MobileRequest {
  protocolVersion: 1;
  id: string;
  /** media.import 仅供原生选择器经私有 IPC 使用，插件公开命令拒绝此方法。 */
  method: MobileCommand | "media.import" | "voice.host" | "voice.wake.host" | "pet.host" | "pet.chat.state" | "pet.chat.send" | "pet.chat.cancel";
  params: unknown;
}
export interface MobileResponse {
  protocolVersion: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string };
}
/** 原生宿主负责实现传输、权限和业务；WebView 不持有宿主凭据。 */
export interface MobileTransport {
  invoke(request: MobileRequest): Promise<MobileResponse>;
  listen(listener: (snapshot: unknown) => void): () => void;
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const oneOf = (v: unknown, values: readonly string[]) =>
  text(v) && values.includes(v);
const list = (v: unknown, check: (item: unknown) => boolean) =>
  Array.isArray(v) && v.every(check);
const characters = MOBILE_CHARACTER_IDS;
const profile = (v: unknown) =>
  object(v) &&
  (v.kind === undefined || oneOf(v.kind, MOBILE_PROVIDER_KINDS)) &&
  text(v.baseUrl) &&
  text(v.model) &&
  typeof v.keyConfigured === "boolean" &&
  (v.advanced === undefined || validAdvanced(v.advanced)) &&
  Object.keys(v).every((key) =>
    ["kind", "baseUrl", "model", "keyConfigured", "advanced"].includes(key),
  );
const capabilities = [
  "calendar",
  "notes",
  "accessibility",
  "overlay",
  "notifications",
  "battery",
  "microphone",
  "location",
  "files",
  "camera",
];
const attachment = (v: unknown): v is MobileAttachment => object(v) && text(v.id) && /^[a-f0-9-]{36}$/.test(v.id)
  && text(v.name) && v.name.length <= 160 && oneOf(v.kind, ["image", "text"])
  && oneOf(v.mimeType, ["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"])
  && (v.kind === "text" ? v.mimeType === "text/plain" : v.mimeType !== "text/plain")
  && Number.isSafeInteger(v.bytes) && (v.bytes as number) > 0 && (v.bytes as number) <= 12 * 1024 * 1024;
const projectAttachment = ({ id, name, kind, mimeType, bytes }: MobileAttachment): MobileAttachment => ({ id, name, kind, mimeType, bytes });
const voiceProfile = (v: unknown, local = false) => object(v) && oneOf(v.kind, local ? ["compatible", "openrouter", "system"] : ["compatible", "openrouter"]) && text(v.baseUrl) && text(v.model) && typeof v.keyConfigured === "boolean";

/** 拒绝不兼容的宿主数据，避免半更新页面和意外原始错误泄露。 */
export function isMobileSnapshot(v: unknown): v is MobileSnapshot {
  if (
    !object(v) ||
    v.protocolVersion !== 1 ||
    !Number.isSafeInteger(v.revision) ||
    (v.revision as number) < 0 ||
    !oneOf(v.mode, ["preview", "live"]) ||
    !object(v.companion) ||
    !object(v.provider)
  )
    return false;
  if (
    v.runtime !== undefined &&
    (!object(v.runtime) ||
      typeof v.runtime.running !== "boolean" ||
      typeof v.runtime.overlayVisible !== "boolean" ||
      !oneOf(v.runtime.engine, ["starting", "ready", "stopped", "failed"]) ||
      !text(v.runtime.detail))
  )
    return false;
  if (v.media !== undefined && (!object(v.media) || typeof v.media.choose !== "boolean" || (v.media.camera !== undefined && typeof v.media.camera !== "boolean") || (v.media.paste !== undefined && typeof v.media.paste !== "boolean") || (v.media.documents !== undefined && typeof v.media.documents !== "boolean") ||
    ![v.media.maxAttachments, v.media.maxBytes, v.media.maxTextBytes].every(x => Number.isSafeInteger(x) && (x as number) > 0))) return false;
  if (v.library !== undefined && (!object(v.library) || typeof v.library.memory !== "boolean" || typeof v.library.skills !== "boolean")) return false;
  if (v.modelManagement !== undefined && typeof v.modelManagement !== 'boolean' || v.contextManagement !== undefined && typeof v.contextManagement !== 'boolean' || v.mcpManagement !== undefined && typeof v.mcpManagement !== 'boolean' || v.githubAuth !== undefined && typeof v.githubAuth !== 'boolean' || v.careManagement !== undefined && typeof v.careManagement !== 'boolean' || v.feishuChannel !== undefined && typeof v.feishuChannel !== 'boolean') return false;
  if (v.backupManagement !== undefined && typeof v.backupManagement !== 'boolean') return false;
  if (v.permissionManagement !== undefined && typeof v.permissionManagement !== 'boolean') return false;
  if (v.startup !== undefined && !validStartup(v.startup)) return false;
  if (v.pet !== undefined && (!object(v.pet) || typeof v.pet.visible !== "boolean" || typeof v.pet.quiet !== "boolean" || typeof v.pet.scale !== "number" || !Number.isFinite(v.pet.scale) || v.pet.scale < .65 || v.pet.scale > 1.6 || !Number.isInteger(v.pet.bubbleSeconds) || (v.pet.bubbleSeconds as number) < 0 || (v.pet.bubbleSeconds as number) > 300 || !oneOf(v.pet.action, ["idle", "greet", "happy", "think", "sleep", "drag"]))) return false;
  if (object(v.pet) && v.pet.docking !== undefined) {
    const d = v.pet.docking;
    if (!object(d) || typeof d.snapToEdge !== "boolean" || typeof d.hideWhenIdle !== "boolean" || typeof d.tucked !== "boolean" || !Number.isInteger(d.delaySeconds) || Number(d.delaySeconds) < 10 || Number(d.delaySeconds) > 300) return false;
  }
  if (v.voice !== undefined) {
    const a = v.voice;
    if (object(a) && object(a.settings) && object(a.settings.tts) && a.settings.tts.stream !== undefined && typeof a.settings.tts.stream !== "boolean") return false;
    if (object(a) && object(a.state) && a.state.sessionMode !== undefined && !oneOf(a.state.sessionMode, ["dictation", "conversation"])) return false;
    if (!object(a) || !object(a.settings) || !voiceProfile(a.settings.stt) || !voiceProfile(a.settings.tts, true) || !object(a.settings.tts) || !text(a.settings.tts.voice) || typeof a.settings.tts.speed !== "number" || a.settings.tts.speed < 0.5 || a.settings.tts.speed > 2 || !Number.isFinite(a.settings.tts.speed) || typeof a.settings.autoRead !== "boolean" || typeof a.settings.continuous !== "boolean" || !object(a.state) || !oneOf(a.state.phase, ["off", "sleeping", "connecting", "listening", "recording", "thinking", "speaking", "error"]) || typeof a.state.active !== "boolean" || typeof a.state.dictating !== "boolean" || !text(a.state.message) || (a.state.error !== undefined && !text(a.state.error)) || a.maxRecordingSeconds !== 90) return false;
    if (a.localTts !== undefined && typeof a.localTts !== "boolean") return false;
    if (a.systemInput !== undefined && typeof a.systemInput !== "boolean") return false;
    if (a.live !== undefined) {
      const l = a.live;
      if (!object(l) || !oneOf(l.mode, ['chained', 'realtime']) || !object(l.profile) || !oneOf(l.profile.kind, ['openai', 'gemini']) || !text(l.profile.baseUrl) || !text(l.profile.model) || !text(l.profile.voice) || typeof l.profile.keyConfigured !== 'boolean' || typeof l.configured !== 'boolean' || !text(l.summary) || !Array.isArray(l.problems) || l.problems.length > 20 || l.problems.some((p: unknown) => !text(p) || p.length > 1000)) return false;
    }
    if (a.wake !== undefined && (!object(a.wake) || typeof a.wake.enabled !== 'boolean' || typeof a.wake.armed !== 'boolean' || typeof a.wake.listening !== 'boolean' || !text(a.wake.message) || !Array.isArray(a.wake.phrases) || a.wake.phrases.length > 8 || a.wake.phrases.some((p: unknown) => !text(p) || p.length > 40) || typeof a.wake.sensitivity !== 'number' || !Number.isInteger(a.wake.sensitivity) || a.wake.sensitivity < 0 || a.wake.sensitivity > 100)) return false;
    if (a.dictation !== undefined && (!object(a.dictation) || !text(a.dictation.id) || !text(a.dictation.text) || a.dictation.text.length > 8000 || !(a.dictation.conversationId === null || text(a.dictation.conversationId)))) return false;
  }
  if (
    !oneOf(v.companion.characterId, characters) ||
    !text(v.companion.nickname) ||
    !text(v.companion.persona) ||
    !text(v.provider.baseUrl) ||
    !text(v.provider.model) ||
    typeof v.provider.keyConfigured !== "boolean"
  )
    return false;
  if (
    !profile(v.provider) ||
    (v.providers !== undefined &&
      !list(
        v.providers,
        (p) =>
          object(p) &&
          Object.keys(p).every((key) =>
            ["id", "name", "requiresKey", "profile"].includes(key),
          ) &&
          oneOf(p.id, MOBILE_PROVIDER_KINDS) &&
          text(p.name) &&
          typeof p.requiresKey === "boolean" &&
          profile(p.profile) &&
          (p.profile as Record<string, unknown>).kind === p.id,
      ))
  )
    return false;
  if (
    !list(
      v.characters,
      (c) =>
        object(c) &&
        oneOf(c.id, characters) &&
        text(c.name) &&
        text(c.description) &&
        c.image === `./characters/${c.id}/idle-0.svg`,
    )
  )
    return false;
  if (
    !list(
      v.conversations,
      (c) =>
        object(c) &&
        text(c.id) &&
        text(c.title) &&
        text(c.updatedAt) &&
        list(
          c.messages,
          (m) =>
            object(m) &&
            text(m.id) &&
            oneOf(m.role, ["user", "assistant"]) &&
            text(m.text) &&
            oneOf(m.status, ["complete", "streaming", "stopped", "error"]) &&
            text(m.createdAt) && (m.attachments === undefined || (Array.isArray(m.attachments) && m.attachments.length <= 8 && m.attachments.every(attachment))),
        ),
    )
  )
    return false;
  if (
    !list(
      v.capabilities,
      (c) =>
        object(c) &&
        oneOf(c.id, capabilities) &&
        text(c.title) &&
        text(c.description) &&
        text(c.detail) &&
        oneOf(c.state, [
          "unavailable",
          "notGranted",
          "granted",
          "disconnected",
        ]),
    )
  )
    return false;
  if (
    !list(
      v.tasks,
      (t) =>
        object(t) &&
        text(t.id) &&
        text(t.title) &&
        text(t.detail) &&
        text(t.conversationId) &&
        (t.choices === undefined || (Array.isArray(t.choices) && t.choices.every(c => ["once", "session", "whitelist"].includes(c)))) &&
        oneOf(t.kind, ["calendar", "notes", "accessibility", "tool"]) &&
        oneOf(t.status, [
          "awaitingApproval",
          "running",
          "requiresUserAction",
          "completed",
          "stopped",
          "failed",
          "unknown",
        ]),
    )
  )
    return false;
  const sessions = v.conversations as MobileSnapshot["conversations"];
  if (
    v.activeConversationId !== null &&
    (!text(v.activeConversationId) ||
      !sessions.some((s) => s.id === v.activeConversationId))
  )
    return false;
  if (v.activeReply !== null) {
    if (
      !object(v.activeReply) ||
      !text(v.activeReply.conversationId) ||
      !text(v.activeReply.messageId)
    )
      return false;
    const reply = v.activeReply;
    if (
      !sessions.some(
        (s) =>
          s.id === reply.conversationId &&
          s.messages.some(
            (m) =>
              m.id === reply.messageId &&
              m.role === "assistant" &&
              m.status === "streaming",
          ),
      )
    )
      return false;
  }
  return true;
}

const messages: Record<string, string> = {
  CONFLICT: "内容已有新版本，请保留草稿并重新读取后合并。",
  LIMIT: "内容超过允许的大小，请删减或拆分后保存。",
  INVALID_DOCUMENT: "技能文档格式不正确，需要 YAML 名称、描述和正文。",
  DOCUMENT_EMPTY: "文档没有可提取文字，请将需要的页面作为图片添加。",
  DOCUMENT_PASSWORD: "请先解锁文档后再添加。",
  DOCUMENT_TIMEOUT: "文档解析超时，请拆分后再添加。",
  CANCELLED: "操作已停止。",
  INVALID_INPUT: "请检查输入内容后重试。",
  BACKUP_PASSWORD: "密码至少需要 10 个字符。",
  BACKUP_DECRYPT: "密码不正确，或文件已损坏。",
  INVALID_BACKUP: "迁移文件无效。",
  BACKUP_RECOVERY: "恢复未完成，请使用加密恢复点。",
  BUSY: "当前操作尚未结束，请稍后再试。",
  NOT_FOUND: "这项内容已不存在，请刷新后重试。",
  STORAGE: "保存未完成，请稍后重试。",
  PROVIDER: "模型请求未完成，请检查连接设置。",
  UNAVAILABLE: "这项手机能力尚未接入。",
};

// 只投影协议字段；宿主额外的内部字段不能沿快照进入界面。
function projectSnapshot(s: MobileSnapshot): MobileSnapshot {
  return {
    protocolVersion: 1,
    ...(s.startup ? { startup: projectStartup(s.startup) } : {}),
    ...(s.library ? { library: { memory: s.library.memory, skills: s.library.skills } } : {}),
    ...(s.modelManagement === undefined ? {} : { modelManagement: s.modelManagement }),
    ...(s.contextManagement === undefined ? {} : { contextManagement: s.contextManagement }),
    ...(s.backupManagement === undefined ? {} : { backupManagement: s.backupManagement }),
    ...(s.permissionManagement === undefined ? {} : { permissionManagement: s.permissionManagement }),
    ...(s.mcpManagement === undefined ? {} : { mcpManagement: s.mcpManagement }),
    ...(s.githubAuth === undefined ? {} : { githubAuth: s.githubAuth }),
    ...(s.careManagement === undefined ? {} : { careManagement: s.careManagement }),
    ...(s.feishuChannel === undefined ? {} : { feishuChannel: s.feishuChannel }),
    revision: s.revision,
    mode: s.mode,
    ...(s.pet ? { pet: { scale: s.pet.scale, visible: s.pet.visible, quiet: s.pet.quiet, bubbleSeconds: s.pet.bubbleSeconds, action: s.pet.action,
      ...(s.pet.docking ? { docking: { snapToEdge: s.pet.docking.snapToEdge, hideWhenIdle: s.pet.docking.hideWhenIdle, delaySeconds: s.pet.docking.delaySeconds, tucked: s.pet.docking.tucked } } : {}) } } : {}),
    ...(s.voice ? { voice: {
      ...(s.voice.localTts !== undefined ? { localTts: s.voice.localTts } : {}),
      ...(s.voice.systemInput !== undefined ? { systemInput: s.voice.systemInput } : {}),
      ...(s.voice.live ? { live: { mode: s.voice.live.mode, profile: { kind: s.voice.live.profile.kind, baseUrl: s.voice.live.profile.baseUrl, model: s.voice.live.profile.model, voice: s.voice.live.profile.voice, keyConfigured: s.voice.live.profile.keyConfigured }, configured: s.voice.live.configured, problems: [...s.voice.live.problems], summary: s.voice.live.summary } } : {}),
      ...(s.voice.wake ? { wake: { enabled: s.voice.wake.enabled, phrases: [...s.voice.wake.phrases], sensitivity: s.voice.wake.sensitivity, armed: s.voice.wake.armed, listening: s.voice.wake.listening, message: s.voice.wake.message } } : {}),
      settings: { stt: { kind: s.voice.settings.stt.kind, baseUrl: s.voice.settings.stt.baseUrl, model: s.voice.settings.stt.model, keyConfigured: s.voice.settings.stt.keyConfigured }, tts: { kind: s.voice.settings.tts.kind, baseUrl: s.voice.settings.tts.baseUrl, model: s.voice.settings.tts.model, keyConfigured: s.voice.settings.tts.keyConfigured, voice: s.voice.settings.tts.voice, speed: s.voice.settings.tts.speed, ...(s.voice.settings.tts.stream !== undefined ? { stream: s.voice.settings.tts.stream } : {}) }, autoRead: s.voice.settings.autoRead, continuous: s.voice.settings.continuous },
      state: { phase: s.voice.state.phase, active: s.voice.state.active, dictating: s.voice.state.dictating, ...(s.voice.state.sessionMode ? { sessionMode: s.voice.state.sessionMode } : {}), message: s.voice.state.message, ...(s.voice.state.error ? { error: s.voice.state.error } : {}) },
      ...(s.voice.dictation ? { dictation: { id: s.voice.dictation.id, text: s.voice.dictation.text, conversationId: s.voice.dictation.conversationId } } : {}), maxRecordingSeconds: s.voice.maxRecordingSeconds,
    } } : {}),
    ...(s.media ? { media: { choose: s.media.choose, ...(s.media.camera !== undefined ? { camera: s.media.camera } : {}), ...(s.media.paste !== undefined ? { paste: s.media.paste } : {}), ...(s.media.documents !== undefined ? { documents: s.media.documents } : {}), maxAttachments: s.media.maxAttachments, maxBytes: s.media.maxBytes, maxTextBytes: s.media.maxTextBytes } } : {}),
    ...(s.runtime
      ? {
          runtime: {
            running: s.runtime.running,
            overlayVisible: s.runtime.overlayVisible,
            engine: s.runtime.engine,
            detail: s.runtime.detail,
          },
        }
      : {}),
    characters: s.characters.map(({ id, name, description, image }) => ({
      id,
      name,
      description,
      image,
    })),
    companion: {
      characterId: s.companion.characterId,
      nickname: s.companion.nickname,
      persona: s.companion.persona,
    },
    provider: {
      ...(s.provider.kind ? { kind: s.provider.kind } : {}),
      baseUrl: s.provider.baseUrl,
      model: s.provider.model,
      keyConfigured: s.provider.keyConfigured,
      ...(s.provider.advanced ? { advanced: projectAdvanced(s.provider.advanced) } : {}),
    },
    ...(s.providers
      ? {
          providers: s.providers.map((p) => ({
            id: p.id,
            name: p.name,
            requiresKey: p.requiresKey,
            profile: {
              kind: p.profile.kind,
              baseUrl: p.profile.baseUrl,
              model: p.profile.model,
              keyConfigured: p.profile.keyConfigured,
              ...(p.profile.advanced ? { advanced: projectAdvanced(p.profile.advanced) } : {}),
            },
          })),
        }
      : {}),
    conversations: s.conversations.map(
      ({ id, title, updatedAt, messages }) => ({
        id,
        title,
        updatedAt,
        messages: messages.map(({ id, role, text, status, createdAt, attachments }) => ({
          id,
          role,
          text,
          status,
          createdAt,
          ...(attachments ? { attachments: attachments.map(projectAttachment) } : {}),
        })),
      }),
    ),
    activeConversationId: s.activeConversationId,
    activeReply: s.activeReply && {
      conversationId: s.activeReply.conversationId,
      messageId: s.activeReply.messageId,
    },
    capabilities: s.capabilities.map(
      ({ id, title, description, state, detail }) => ({
        id,
        title,
        description,
        state,
        detail,
      }),
    ),
    tasks: s.tasks.map(
      ({ id, kind, title, detail, status, conversationId, choices }) => ({
        id,
        kind,
        title,
        detail,
        status,
        conversationId,
        ...(choices ? { choices: [...choices] } : {}),
      }),
    ),
  };
}

/** 单个前台 WebView 的连接；不自动重试写操作，避免重复发送/重复创建。 */
export function createMobileBridge(
  transport: MobileTransport,
  options: { timeoutMs?: number; id?: () => string } = {},
): MobileBridge & { dispose(): void } {
  let disposed = false;
  let latest: MobileSnapshot | undefined;
  let sequence = 0;
  const prefix = globalThis.crypto.randomUUID();
  const listeners = new Set<(s: MobileSnapshot) => void>();
  const pending = new Set<() => void>();
  const deliver = (
    listener: (s: MobileSnapshot) => void,
    snapshot: MobileSnapshot,
  ) => {
    try {
      listener(structuredClone(snapshot));
    } catch {
      /* 单个 UI 监听者不能破坏其它订阅。 */
    }
  };
  const accept = (value: unknown) => {
    if (
      disposed ||
      !isMobileSnapshot(value) ||
      (latest && value.revision <= latest.revision)
    )
      return;
    latest = projectSnapshot(value);
    for (const listener of listeners) deliver(listener, latest);
  };
  const unlisten = transport.listen(accept);

  return {
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      if (latest) deliver(listener, latest);
      return () => {
        listeners.delete(listener);
      };
    },
    async request<K extends MobileCommand>(
      method: K,
      params: MobileCommands[K]["params"],
    ): Promise<MobileCommands[K]["result"]> {
      if (disposed)
        throw new MobileBridgeError(
          "UNAVAILABLE",
          "连接已经关闭，请重新打开应用。",
        );
      const id = options.id?.() ?? `${prefix}:${++sequence}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel = () => {};
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => {
            if (disposed)
              throw new MobileBridgeError(
                "UNAVAILABLE",
                "连接已经关闭，请重新打开应用。",
              );
            return transport.invoke({
              protocolVersion: MOBILE_PROTOCOL_VERSION,
              id,
              method,
              params: structuredClone(params),
            });
          }),
          new Promise<never>((_, reject) => {
            cancel = () =>
              reject(
                new MobileBridgeError(
                  "UNAVAILABLE",
                  "连接已经关闭，请重新打开应用。",
                ),
              );
            pending.add(cancel);
            timer = setTimeout(
              () =>
                reject(
                  new MobileBridgeError(
                    "UNAVAILABLE",
                    "暂未收到操作结果，请先检查当前状态。",
                  ),
                ),
              options.timeoutMs ?? ((method === "media.choose" || method === "media.camera" || method === "media.paste" || method === "voice.system.input" || method === "backup.choose" || method === "backup.export") ? 300_000 : 30_000),
            );
          }),
        ]);
        if (
          disposed ||
          !object(response) ||
          response.protocolVersion !== 1 ||
          response.id !== id ||
          typeof response.ok !== "boolean"
        ) {
          throw new MobileBridgeError(
            "UNAVAILABLE",
            "连接数据不兼容，请重新打开应用。",
          );
        }
        if (!response.ok) {
          const code = response.error?.code;
          const safeCode =
            code && Object.hasOwn(messages, code)
              ? (code as MobileBridgeError["code"])
              : "UNAVAILABLE";
          throw new MobileBridgeError(safeCode, messages[safeCode]);
        }
        if (method === "snapshot.get") {
          if (!isMobileSnapshot(response.result))
            throw new MobileBridgeError(
              "UNAVAILABLE",
              "暂时无法读取应用状态。",
            );
          accept(response.result);
          return structuredClone(latest!) as MobileCommands[K]["result"];
        }
        if (method === "voice.local.catalog") {
          const c = response.result;
          if (!object(c) || !text(c.note) || c.note.length > 1000 || !Array.isArray(c.voices) || c.voices.length > 500 || !c.voices.every((v: unknown) => object(v) && text(v.id) && /^android:[a-f0-9]{64}$/.test(v.id) && text(v.name) && v.name.length <= 300)) throw new MobileBridgeError("UNAVAILABLE", "系统音色目录不可用。");
          return { note: c.note, voices: c.voices.map(({ id, name }: { id: string; name: string }) => ({ id, name })) } as MobileCommands[K]["result"];
        }
        if (method === "voice.system.input") {
          const c = response.result;
          if (!object(c) || !(c.text === null || text(c.text) && c.text.length <= 8000)) throw new MobileBridgeError("UNAVAILABLE", "系统识别结果不可用。");
          return { text: c.text } as MobileCommands[K]["result"];
        }
        if (method.startsWith("library.")) return projectLibraryResult(method, response.result, params) as MobileCommands[K]["result"];
        if (method.startsWith("mcp.")) return projectMcpResult(method, response.result) as MobileCommands[K]["result"];
        if (method.startsWith('github.auth.')) return projectGithubAuth(response.result) as MobileCommands[K]['result'];
        if (method.startsWith('care.')) return projectCareResult(method,response.result) as MobileCommands[K]['result'];
        if (method.startsWith('feishu.')) return projectFeishuResult(response.result) as MobileCommands[K]['result'];
        if (method.startsWith('backup.')) return projectBackup(method,response.result) as MobileCommands[K]['result'];
        if (method === 'policy.get' || method === 'policy.set') return projectPolicy(response.result) as MobileCommands[K]['result'];
        if (method === 'runtime.startup.save') return projectStartup(response.result) as MobileCommands[K]['result'];
        if (['provider.models', 'provider.inspect', 'provider.test', 'provider.test.cancel', 'conversation.context', 'context.archive'].includes(method)) return projectModelResult(method, response.result, params) as MobileCommands[K]['result'];
        if (
          method === "conversation.create" &&
          (!object(response.result) || !text(response.result.id))
        ) {
          throw new MobileBridgeError("UNAVAILABLE", "暂时无法读取会话状态。");
        }
        if ((method === "media.choose" || method === "media.camera" || method === "media.paste")) {
          if (!Array.isArray(response.result) || response.result.length > 8 || !response.result.every(attachment)) throw new MobileBridgeError("UNAVAILABLE", "附件结果不兼容。");
          return response.result.map(projectAttachment) as MobileCommands[K]["result"];
        }
        if (method === "media.preview") {
          const v = response.result;
          if (!object(v) || !attachment(v.attachment) || v.attachment.id !== (params as { id: string }).id ||
            (v.dataUrl !== undefined && (!text(v.dataUrl) || v.dataUrl.length > 1200100 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v.dataUrl))) ||
            (v.text !== undefined && (!text(v.text) || v.text.length > 12000))) throw new MobileBridgeError("UNAVAILABLE", "附件预览不可用。");
          return { attachment: projectAttachment(v.attachment), ...(v.dataUrl ? { dataUrl: v.dataUrl } : {}), ...(v.text !== undefined ? { text: v.text } : {}) } as MobileMediaPreview as MobileCommands[K]["result"];
        }
        return (
          method === "conversation.create"
            ? { id: (response.result as { id: string }).id }
            : undefined
        ) as MobileCommands[K]["result"];
      } catch (error) {
        if (error instanceof MobileBridgeError) throw error;
        // 不把原生网络错误、供应商响应或凭据暴露给 UI。
        throw new MobileBridgeError(
          "UNAVAILABLE",
          "连接暂时不可用，请稍后重试。",
        );
      } finally {
        clearTimeout(timer);
        pending.delete(cancel);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unlisten();
      listeners.clear();
      latest = undefined;
      for (const cancel of pending) cancel();
      pending.clear();
    },
  };
}
