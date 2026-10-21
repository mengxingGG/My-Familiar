import {
  MobileBridgeError,
  type MobileBridge,
  type MobileCommand,
  type MobileCommands,
  type MobileSnapshot,
  type MobileProviderKind,
  type MobileMediaPreview,
} from "../../../packages/mobile-contracts/index.ts";

/** 仅由 preview-entry 引入。所有数据在内存中，不读取真实配置、密钥或历史。 */
export function createPreviewBridge(
  options: { intervalMs?: number; nativeControls?: boolean } = {},
): MobileBridge & { dispose(): void } {
  const configuredKeys = new Set<string>();
  const media = new Map<string, MobileMediaPreview>();
  const state: MobileSnapshot = {
    protocolVersion: 1,
    revision: 0,
    mode: "preview",
    media: { choose: true, camera: false, maxAttachments: 8, maxBytes: 12 * 1024 * 1024, maxTextBytes: 400000 },
    characters: [
      {
        id: "mori",
        name: "小森",
        description: "安静的森林小伙伴，愿意慢慢听你说。",
        image: "./characters/mori/idle-0.svg",
      },
      {
        id: "youzi",
        name: "柚子",
        description: "带着一点阳光，陪你发现今天的小事。",
        image: "./characters/youzi/idle-0.svg",
      },
      {
        id: "luna",
        name: "月团",
        description: "像月光一样柔软，陪伴每个晚归的你。",
        image: "./characters/luna/idle-0.svg",
      },
      ...(
        [
          ["diandian", "点点"],
          ["fangfang", "方方"],
          ["lili", "栗栗"],
          ["mianmian", "绵绵"],
        ] as const
      ).map(([id, name]) => ({
        id,
        name,
        description: "一起发现生活里的小事。",
        image: `./characters/${id}/idle-0.svg`,
      })),
    ],
    companion: {
      characterId: "mori",
      nickname: "小森",
      persona: "温柔、好奇，认真倾听，也有自己的小想法。",
    },
    provider: {
      kind: "compatible",
      baseUrl: "",
      model: "",
      keyConfigured: false,
    },
    providers: (
      [
        ["compatible", "OpenAI 兼容", "http://127.0.0.1:1234/v1", false],
        [
          "openai",
          "OpenAI 官方 · Responses",
          "https://api.openai.com/v1",
          true,
        ],
        ["deepseek", "DeepSeek 官方", "https://api.deepseek.com", true],
        [
          "gemini",
          "Gemini 官方",
          "https://generativelanguage.googleapis.com/v1beta",
          true,
        ],
        ["claude", "Claude 官方", "https://api.anthropic.com/v1", true],
        ["openrouter", "OpenRouter 官方", "https://openrouter.ai/api/v1", true],
        ["llamacpp", "本地 llama.cpp", "http://127.0.0.1:8080/v1", false],
      ] as [MobileProviderKind, string, string, boolean][]
    ).map(([id, name, baseUrl, requiresKey]) => ({
      id,
      name,
      requiresKey,
      profile: { kind: id, baseUrl, model: "", keyConfigured: false },
    })),
    conversations: [
      {
        id: "welcome",
        title: "今天的小小日常",
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: "welcome-user",
            role: "user",
            text: "今天想慢下来一点。",
            status: "complete",
            createdAt: new Date().toISOString(),
          },
          {
            id: "welcome-assistant",
            role: "assistant",
            text: "好呀，那我们先把着急放在一边。你想说说今天，还是一起安静待一会儿？",
            status: "complete",
            createdAt: new Date().toISOString(),
          },
        ],
      },
      {
        id: "yesterday",
        title: "留住一个小灵感",
        updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
        messages: [
          {
            id: "yesterday-user",
            role: "user",
            text: "有空的时候，去公园看看树。",
            status: "complete",
            createdAt: new Date(Date.now() - 86_400_000).toISOString(),
          },
        ],
      },
    ],
    activeConversationId: "welcome",
    activeReply: null,
    capabilities: [
      {
        id: "calendar",
        title: "日历",
        description: "把约定放进日历，或交给日历应用完成。",
        state: "notGranted",
        detail: "预览演示授权流程，不会修改真实日历。",
      },
      {
        id: "notes",
        title: "笔记",
        description: "留住灵感，交给你选择的笔记应用。",
        state: "granted",
        detail: "预览中的授权状态；真实笔记尚未接入。",
      },
      {
        id: "accessibility",
        title: "跨应用协助",
        description: "经你允许后，帮助处理其它应用里的具体操作。",
        state: "unavailable",
        detail: "Android 无障碍执行器尚未接入。",
      },
    ],
    tasks: [],
  };
  if (options.nativeControls) {
    state.runtime = {
      running: false,
      overlayVisible: false,
      engine: "ready",
      detail: "预览中的常驻状态，不会启动真实后台服务。",
    };
    state.capabilities.push(
      ...(
        [
          "overlay",
          "notifications",
          "battery",
          "microphone",
          "location",
          "files",
        ] as const
      ).map((id) => ({
        id,
        title: {
          overlay: "悬浮伙伴",
          notifications: "运行通知",
          battery: "后台电池策略",
          microphone: "麦克风",
          location: "大致位置",
          files: "文件选择",
        }[id],
        description: "仅用于界面验收的模拟权限。",
        state: "notGranted" as const,
        detail: "预览不会触发系统权限或访问设备资料。",
      })),
    );
    state.capabilities.find((c) => c.id === "accessibility")!.state =
      "notGranted";
  }
  let disposed = false;
  let generation = 0;
  const listeners = new Set<(s: MobileSnapshot) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const snapshot = () => structuredClone(state);
  const publish = () => {
    state.revision++;
    for (const listener of listeners) listener(snapshot());
  };
  const later = (fn: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) fn();
    }, delay);
    timers.add(timer);
  };
  const active = () =>
    state.conversations.find((c) => c.id === state.activeConversationId);
  const stop = () => {
    generation++;
    const reply = state.activeReply;
    if (!reply) return;
    const message = state.conversations
      .find((c) => c.id === reply.conversationId)
      ?.messages.find((m) => m.id === reply.messageId);
    if (message) message.status = "stopped";
    state.activeReply = null;
  };
  const checkIdle = () => {
    if (state.activeReply)
      throw new MobileBridgeError("BUSY", "请先停止当前回复。");
  };
  const create = () => {
    const id = crypto.randomUUID();
    state.conversations.unshift({
      id,
      title: "新的对话",
      updatedAt: new Date().toISOString(),
      messages: [],
    });
    state.activeConversationId = id;
    return id;
  };
  const execute = async (
    method: MobileCommand,
    input: unknown,
  ): Promise<unknown> => {
    if (disposed) throw new MobileBridgeError("UNAVAILABLE", "预览已关闭。");
    switch (method) {
      case "snapshot.get":
        return snapshot();
      case "media.camera":
        throw new MobileBridgeError("UNAVAILABLE", "预览不调用系统相机。");
      case "media.choose": {
        const id = crypto.randomUUID();
        const value: MobileMediaPreview = { attachment: { id, name: "附件演示.txt", kind: "text", mimeType: "text/plain", bytes: 33 }, text: "这是一份仅用于界面验收的附件。" };
        media.set(id, value);
        return [structuredClone(value.attachment)];
      }
      case "media.preview": {
        const value = media.get((input as { id: string }).id);
        if (!value) throw new MobileBridgeError("NOT_FOUND", "附件不存在。");
        return structuredClone(value);
      }
      case "companion.save": {
        const p = input as MobileCommands["companion.save"]["params"];
        if (
          !state.characters.some((c) => c.id === p.characterId) ||
          !p.nickname.trim() ||
          p.nickname.length > 40 ||
          p.persona.length > 2000
        )
          throw new MobileBridgeError(
            "INVALID_INPUT",
            "请填写 1–40 字昵称，性格描述不超过 2000 字。",
          );
        state.companion = { ...p, nickname: p.nickname.trim() };
        break;
      }
      case "provider.save": {
        checkIdle();
        const p = input as MobileCommands["provider.save"]["params"];
        let url: URL;
        try {
          url = new URL(p.baseUrl);
        } catch {
          throw new MobileBridgeError(
            "INVALID_INPUT",
            "请填写有效的 API 地址。",
          );
        }
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !p.model.trim() ||
          p.model.length > 200
        )
          throw new MobileBridgeError(
            "INVALID_INPUT",
            "请使用无凭据的 HTTP(S) 地址和有效模型名。",
          );
        if (p.clearApiKey && p.apiKey)
          throw new MobileBridgeError(
            "INVALID_INPUT",
            "清除密钥与填写新密钥不能同时提交。",
          );
        const kind = p.kind ?? state.provider.kind ?? "compatible";
        const selected = state.providers!.find((item) => item.id === kind);
        if (!selected)
          throw new MobileBridgeError("INVALID_INPUT", "供应商类型无效。");
        const baseUrl = url.toString().replace(/\/$/, "");
        const scope = `${kind}\n${baseUrl}`;
        if (p.clearApiKey || p.apiKey === "") configuredKeys.delete(scope);
        else if (p.apiKey) configuredKeys.add(scope);
        state.provider = {
          kind,
          baseUrl,
          model: p.model.trim(),
          keyConfigured: configuredKeys.has(scope),
        };
        selected.profile = { ...state.provider };
        // 预览只保留“是否填写”，不保存或使用输入的密钥。
        break;
      }
      case "conversation.create": {
        checkIdle();
        const id = create();
        publish();
        return { id };
      }
      case "conversation.select": {
        const p = input as MobileCommands["conversation.select"]["params"];
        if (!state.conversations.some((c) => c.id === p.id))
          throw new MobileBridgeError("NOT_FOUND", "这段对话已不存在。");
        state.activeConversationId = p.id;
        break;
      }
      case "conversation.delete": {
        const p = input as MobileCommands["conversation.delete"]["params"];
        if (!state.conversations.some((c) => c.id === p.id))
          throw new MobileBridgeError("NOT_FOUND", "这段对话已不存在。");
        if (state.activeReply?.conversationId === p.id) stop();
        state.conversations = state.conversations.filter((c) => c.id !== p.id);
        state.tasks = state.tasks.filter((t) => t.conversationId !== p.id);
        if (state.activeConversationId === p.id)
          state.activeConversationId = state.conversations[0]?.id ?? null;
        break;
      }
      case "reply.cancel":
        stop();
        break;
      case "runtime.set": {
        if (!state.runtime)
          throw new MobileBridgeError(
            "UNAVAILABLE",
            "当前预览未启用常驻控件。",
          );
        const p = input as MobileCommands["runtime.set"]["params"];
        if (typeof p?.enabled !== "boolean")
          throw new MobileBridgeError("INVALID_INPUT", "参数无效。");
        if (!p.enabled) {
          stop();
          for (const task of state.tasks)
            if (
              ["awaitingApproval", "running", "requiresUserAction"].includes(
                task.status,
              )
            )
              task.status = "stopped";
        }
        state.runtime.running = p.enabled;
        state.runtime.overlayVisible =
          p.enabled &&
          state.capabilities.some(
            (c) => c.id === "overlay" && c.state === "granted",
          );
        break;
      }
      case "message.send": {
        checkIdle();
        const p = input as MobileCommands["message.send"]["params"];
        const text = p.text.trim();
        const attachments = (p.attachments ?? []).map(id => media.get(id)?.attachment);
        if (attachments.length > 8 || attachments.some(a => !a) || (!text && !attachments.length) || text.length > 8000)
          throw new MobileBridgeError(
            "INVALID_INPUT",
            "请输入不超过 8000 字的消息或添加附件。",
          );
        const targetId =
          p.conversationId === null ? create() : p.conversationId;
        const conversation = state.conversations.find((c) => c.id === targetId);
        if (!conversation)
          throw new MobileBridgeError("NOT_FOUND", "这段对话已不存在。");
        const now = new Date().toISOString();
        conversation.messages.push({
          id: crypto.randomUUID(),
          role: "user",
          text: text || "请看看这些附件。",
          ...(attachments.length ? { attachments: structuredClone(attachments.filter(a => !!a)) } : {}),
          status: "complete",
          createdAt: now,
        });
        if (conversation.messages.length === 1)
          conversation.title = text.slice(0, 24);
        conversation.updatedAt = now;
        const message = {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          text: "",
          status: "streaming" as "streaming" | "complete",
          createdAt: now,
        };
        conversation.messages.push(message);
        state.activeReply = {
          conversationId: conversation.id,
          messageId: message.id,
        };
        const mine = ++generation;
        const content =
          "我在听。可以从你最想说的那件小事开始，慢慢来。\n\n这是用于检查移动交互的示例回复；真实模型会由 Familiar 核心连接。";
        const fragments = Array.from(content);
        let offset = 0;
        const tick = () => {
          if (mine !== generation) return;
          message.text += fragments.slice(offset, offset + 3).join("");
          offset += 3;
          if (offset >= fragments.length) {
            message.status = "complete";
            state.activeReply = null;
            if (/日历|笔记/.test(text)) {
              const calendar = /日历/.test(text);
              state.tasks.push({
                id: crypto.randomUUID(),
                kind: calendar ? "calendar" : "notes",
                title: calendar ? "日历事件预览" : "笔记内容预览",
                detail: calendar
                  ? "示例：散步 · 2026-10-20 10:00–10:30 · Asia/Taipei · 个人日历"
                  : `示例笔记：${text.slice(0, 200)}`,
                status: "awaitingApproval",
                conversationId: conversation.id,
              });
            }
          } else later(tick, options.intervalMs ?? 55);
          publish();
        };
        later(tick, options.intervalMs ?? 55);
        break;
      }
      case "capability.request": {
        const p = input as MobileCommands["capability.request"]["params"];
        const capability = state.capabilities.find((c) => c.id === p.id);
        if (!capability || capability.state === "unavailable")
          throw new MobileBridgeError(
            "UNAVAILABLE",
            "这项能力尚未接入 Android。",
          );
        capability.state = "granted";
        capability.detail = "预览中的已授权状态，不代表真实系统授权。";
        break;
      }
      case "task.respond": {
        const p = input as MobileCommands["task.respond"]["params"];
        const task = state.tasks.find((t) => t.id === p.id);
        if (!task) throw new MobileBridgeError("NOT_FOUND", "任务已不存在。");
        if (p.action === "stop") {
          if (
            ["completed", "stopped", "failed", "unknown"].includes(task.status)
          )
            throw new MobileBridgeError("INVALID_INPUT", "任务已结束。");
          task.status = "stopped";
        } else {
          if (p.action !== "approve" || task.status !== "awaitingApproval")
            throw new MobileBridgeError(
              "INVALID_INPUT",
              "当前任务不在等待批准。",
            );
          task.status = "running";
          later(() => {
            if (task.status === "running" && state.tasks.includes(task)) {
              task.status = "requiresUserAction";
              publish();
            }
          }, 650);
        }
        break;
      }
      default:
        throw new MobileBridgeError("UNAVAILABLE", "预览不支持这项操作。");
    }
    publish();
  };
  return {
    request: execute as MobileBridge["request"],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      stop();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      listeners.clear();
      media.clear();
    },
  };
}
