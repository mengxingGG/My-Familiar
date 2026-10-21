import type { Kernel } from "../../../packages/kernel/index.ts";
import type {
  Message,
  ProviderProfile,
} from "../../../packages/contracts/index.ts";
import type {
  MobileRequest,
  MobileResponse,
} from "../../../packages/mobile-bridge/index.ts";
import type {
  MobileSnapshot,
  MobileMessage,
  CharacterId,
  MobileProviderKind,
} from "../../../packages/mobile-contracts/index.ts";
import {
  MOBILE_CHARACTER_IDS,
  MOBILE_PROVIDER_KINDS,
} from "../../../packages/mobile-contracts/index.ts";
import type { AndroidNative } from "../../../plugins/platform-android/index.ts";
import { mobileTasks } from "../../../plugins/platform-android/approvals.ts";
import { publicAttachment } from "../../../plugins/platform-android/media.ts";
import { mobileVoice } from "./mobile-voice.ts";
import { mobileLibrary } from "./mobile-library.ts";
import { mobileMcp } from "./mobile-mcp.ts";
import { mobileGithub } from './mobile-github.ts';
import { mobileBackup } from './mobile-backup.ts';
import { validatePolicy } from '../../../plugins/agent-tools/index.ts';
import { mobileCare } from "./mobile-care.ts";
import { mobileFeishu } from "./mobile-feishu.ts";
import { mobileModel, advancedProfile, mergeAdvanced } from "./mobile-model.ts";
import {
  credentialScope,
  validateProfile,
} from "../../../plugins/llm-shared/config.ts";

const input: (condition: unknown) => asserts condition = (condition) => {
  if (!condition) throw new Error("INVALID_INPUT");
};
const message = (m: Message): MobileMessage => ({
  id: m.id,
  role: m.role,
  text: m.text,
  status: m.status === "cancelled" ? "stopped" : m.status,
  createdAt: new Date(m.time).toISOString(),
  ...(m.attachments?.length ? { attachments: m.attachments.map(publicAttachment) } : {}),
});
const characterIds: readonly string[] = MOBILE_CHARACTER_IDS;

/** 把现有业务能力投影到移动协议，不另建会话/模型/记忆写入者。 */
export function mobileApi(kernel: Kernel, native: AndroidNative) {
  let revision = Date.now() * 1000;
  let queue = Promise.resolve<unknown>(undefined);
  const settings = kernel.resolve("settings");
  const history = kernel.resolve("conversation.history");
  const chat = kernel.resolve("conversation");
  const secrets = kernel.resolve("secrets.local");
  const voice = mobileVoice(kernel, native);
  const library = mobileLibrary(kernel);
  const mcp = mobileMcp(kernel);
  const github = mobileGithub(kernel);
  const care = mobileCare(kernel,native);
  const feishu = mobileFeishu(kernel);
  const models = mobileModel(kernel);
  let backup: ReturnType<typeof mobileBackup> | undefined;
  const modelMethods = new Set(['provider.models', 'provider.inspect', 'provider.test', 'provider.test.cancel', 'conversation.context', 'context.archive']);
  const publicProfile = (profile: ProviderProfile) => ({
    kind: profile.kind as MobileProviderKind,
    baseUrl: profile.baseUrl,
    model: profile.model,
    keyConfigured: secrets.has(credentialScope(profile)),
    advanced: advancedProfile(profile),
  });

  const snapshot = async (): Promise<MobileSnapshot> => {
    const config = settings.get();
    const summaries = await history.list();
    const conversations: MobileSnapshot["conversations"] = [];
    let activeConversationId: string | null = null;
    for (const item of summaries.slice(0, 100)) {
      let page = await history.read(item.id);
      const messages = [...page.messages];
      while (page.next !== null) {
        page = await history.read(item.id, page.next);
        messages.push(...page.messages);
      }
      if (page.active) activeConversationId = item.id;
      conversations.push({
        id: item.id,
        title: item.title,
        updatedAt: new Date(item.updated).toISOString(),
        messages: messages.slice(-100).map(message),
      });
    }
    const active = conversations.find((c) => c.id === activeConversationId);
    const reply = active?.messages.findLast((m) => m.status === "streaming");
    const [capabilities, runtime, docking, startup] = await Promise.all([
      native.call<MobileSnapshot["capabilities"]>("capabilities.status"),
      native.call<MobileSnapshot["runtime"]>("runtime.status"),
      native.call<NonNullable<MobileSnapshot["pet"]>["docking"]>("pet.docking.get"),
      native.call<MobileSnapshot["startup"]>("runtime.startup.get"),
    ]);
    return {
      protocolVersion: 1,
      revision: ++revision,
      mode: "live",
      library: { memory: true, skills: true },
      modelManagement: true,
      contextManagement: true,
      mcpManagement: true,
      permissionManagement: true,
      backupManagement: true,
      githubAuth: true,
      careManagement: true,
      feishuChannel: true,
      ...(startup ? { startup } : {}),
      pet: { scale: config.pet.scale, visible: config.pet.visible, quiet: config.pet.quiet, bubbleSeconds: config.pet.bubbleSeconds, action: kernel.resolve("behavior.pet").state(), ...(docking ? { docking } : {}) },
      voice: await voice.snapshot(),
      media: { paste: true, documents: true, camera: capabilities.some(c => c.id === "camera" && c.state === "granted"), choose: capabilities.some(c => c.id === "files" && c.state === "granted"), maxAttachments: 8, maxBytes: 12 * 1024 * 1024, maxTextBytes: 400000 },
      characters: kernel
        .resolve("character.catalog")
        .list()
        .filter((c) => characterIds.includes(c.id))
        .map((c) => ({
          id: c.id as CharacterId,
          name: c.name,
          description: c.description,
          image: `./characters/${c.id}/idle-0.svg`,
        })),
      companion: {
        characterId: config.pet.character as CharacterId,
        nickname: config.persona.name,
        persona: config.persona.instruction,
      },
      provider: publicProfile(config.provider),
      providers: kernel
        .resolve("llm.registry")
        .list()
        .map((entry) => ({
          id: entry.id as MobileProviderKind,
          name: entry.name,
          requiresKey: entry.requiresKey,
          profile: publicProfile(
            entry.id === config.provider.kind
              ? config.provider
              : (config.provider.savedProfiles[entry.id] ?? entry.defaults),
          ),
        })),
      conversations,
      activeConversationId,
      activeReply:
        reply && active
          ? { conversationId: active.id, messageId: reply.id }
          : null,
      capabilities,
      runtime,
      tasks: mobileTasks(kernel.resolve("agent.approvals").list(), activeConversationId ?? ""),
    };
  };
  async function run(request: MobileRequest): Promise<unknown> {
    input(
      request.protocolVersion === 1 &&
        typeof request.id === "string" &&
        request.id.length <= 100,
    );
    const p = request.params as Record<string, unknown> | undefined;
    if (request.method.startsWith("backup.")) return (backup ??= mobileBackup(kernel,native))(request.method,p);
    if (request.method.startsWith("library.")) return library(request.method, p);
    if (request.method.startsWith("mcp.")) return mcp(request.method, p);
    if (request.method.startsWith('github.auth.')) return github(request.method,p);
    if (request.method.startsWith("care.")) return care(request.method,p);
    if (request.method.startsWith("feishu.")) return feishu(request.method,p);
    if (modelMethods.has(request.method)) return models(request.method, p);
    if (request.method === "voice.host") return kernel.resolve("commands").call("voice.host", p);
    if (request.method === "voice.wake.host") return kernel.resolve("android.wake").host(p);
    if (request.method.startsWith("voice.")) return voice.run(request.method, p);
    if (["conversation.create", "conversation.select", "conversation.delete", "message.send", "pet.chat.send", "provider.save", "companion.save"].includes(request.method)) voice.guard();
    if (['provider.save','companion.save'].includes(request.method)) kernel.resolve('companion.care').stop();
    switch (request.method) {
      case "policy.get": return kernel.resolve("agent.policy").get();
      case "policy.set": {
        let value; try { value = validatePolicy(p as unknown as import("../../../packages/contracts/agent.ts").ToolPolicy); } catch { throw Error("INVALID_INPUT"); }
        return kernel.resolve("agent.policy").set(value);
      }
      case "policy.resetSession": kernel.resolve("agent.policy").resetSession(); return;
      case "pet.chat.state": {
        input(!p || Object.keys(p).length === 0);
        const state = chat.state(), last = state.messages.at(-1);
        const reply = last?.role === "assistant" ? last : undefined;
        const user = state.messages.findLast(message => message.role === "user");
        return { conversationId: history.current(), busy: state.busy, name: settings.get().persona.name,
          reply: state.error || reply?.text.slice(-12000) || "", replyId: reply?.id ?? "", truncated: (reply?.text.length ?? 0) > 12000,
          lastUser: user?.text.slice(0, 300) ?? "", modelConfigured: !!settings.get().provider.model };
      }
      case "pet.chat.send": {
        input(p && Object.keys(p).every(key => ["conversationId", "text"].includes(key)) && typeof p.conversationId === "string" && typeof p.text === "string" && p.text.trim().length > 0 && p.text.length <= 8000);
        if (p.conversationId !== history.current()) throw Error("CONFLICT");
        if (chat.state().busy) throw Error("BUSY");
        if (!settings.get().provider.model) throw Error("PROVIDER");
        kernel.resolve("companion.presentation").controller(false);
        await chat.send(p.text as string);
        return;
      }
      case "pet.chat.cancel":
        input(p && Object.keys(p).length === 1 && typeof p.conversationId === "string");
        if (p.conversationId !== history.current()) throw Error("CONFLICT");
        await chat.cancel(); return;
      case "snapshot.get":
        if (typeof p?.controllerActive === "boolean") kernel.resolve("companion.presentation").controller(p.controllerActive);
        return snapshot();
      case "pet.settings.save":
        input(p && typeof p.scale === "number" && Number.isFinite(p.scale) && p.scale >= .65 && p.scale <= 1.6 && typeof p.visible === "boolean" && typeof p.quiet === "boolean" && Number.isInteger(p.bubbleSeconds) && Number(p.bubbleSeconds) >= 0 && Number(p.bubbleSeconds) <= 300);
        await settings.patchPet({ scale: p.scale, visible: p.visible, quiet: p.quiet, bubbleSeconds: p.bubbleSeconds as number }); return;
      case "pet.docking.save":
        input(p && typeof p.snapToEdge === "boolean" && typeof p.hideWhenIdle === "boolean" && Number.isInteger(p.delaySeconds) && Number(p.delaySeconds) >= 10 && Number(p.delaySeconds) <= 300);
        await native.call("pet.docking.save", { snapToEdge: p.snapToEdge, hideWhenIdle: p.hideWhenIdle, delaySeconds: p.delaySeconds }); return;
      case "pet.interact":
      case "pet.host": {
        const action = String(p?.action);
        const allowed = request.method === "pet.host" ? ["click", "sleep", "drag-start", "drag-end", "recall", "close", "cancel", "open", "compose"] : ["click", "sleep", "recall", "reset-position"];
        input(allowed.includes(action));
        if (["click", "sleep", "drag-start", "drag-end"].includes(action)) kernel.resolve("behavior.pet").interact(action as "click" | "sleep" | "drag-start" | "drag-end");
        if (action === "reset-position") await native.call("pet.reset");
        if (action === "recall") await kernel.resolve("commands").call("speech.recall");
        if (action === "compose") await kernel.resolve("commands").call("chat.open");
        if (action === "close") { await kernel.resolve("commands").call("chat.close"); await kernel.resolve("commands").call("speech.close"); }
        if (action === "cancel") { await voice.run("voice.stop", undefined); await chat.cancel(); }
        if (action === "open") await native.call("pet.open");
        return;
      }
      case "media.import": {
        input(p && Array.isArray(p.tokens));
        return (await kernel.resolve("android.media").import(p.tokens as string[])).map(publicAttachment);
      }
      case "media.preview": {
        input(p && typeof p.id === "string");
        return kernel.resolve("android.media").preview(p.id as string);
      }
      case "companion.save": {
        input(
          p &&
            characterIds.includes(String(p.characterId)) &&
            typeof p.nickname === "string" &&
            p.nickname.trim().length > 0 &&
            p.nickname.length <= 40 &&
            typeof p.persona === "string" &&
            p.persona.length <= 6000,
        );
        const config = settings.get();
        await settings.apply({
          ...config,
          pet: { ...config.pet, character: String(p.characterId) },
          persona: {
            ...config.persona,
            name: p.nickname as string,
            instruction: p.persona as string,
          },
        });
        return;
      }
      case "provider.save": {
        if (chat.state().busy) throw new Error("BUSY");
        input(
          p &&
            typeof p.baseUrl === "string" &&
            typeof p.model === "string" &&
            p.baseUrl.length <= 2000 &&
            p.model.length <= 200,
        );
        input(
          p.apiKey === undefined ||
            (typeof p.apiKey === "string" && p.apiKey.length <= 16384),
        );
        input(
          p.clearApiKey === undefined || typeof p.clearApiKey === "boolean",
        );
        input(!(p.clearApiKey && p.apiKey));
        let url: URL;
        try {
          url = new URL(p.baseUrl as string);
        } catch {
          throw new Error("INVALID_INPUT");
        }
        input(
          ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash,
        );
        const config = settings.get();
        const kind = p.kind ?? config.provider.kind;
        input(
          typeof kind === "string" &&
            (MOBILE_PROVIDER_KINDS as readonly string[]).includes(kind),
        );
        const entry = kernel
          .resolve("llm.registry")
          .list()
          .find((item) => item.id === kind)!;
        const profile =
          kind === config.provider.kind
            ? config.provider
            : (config.provider.savedProfiles[kind] ?? entry.defaults);
        let provider: ProviderProfile;
        try {
          provider = kernel.resolve("llm.management").validate(mergeAdvanced({
            ...profile,
            kind,
            baseUrl: p.baseUrl as string,
            model: p.model as string,
          }, p.advanced));
        } catch {
          throw new Error("INVALID_INPUT");
        }
        const scope = credentialScope(provider);
        const previous = secrets.get(scope);
        if (p.apiKey !== undefined || p.clearApiKey)
          await secrets.set(scope, p.clearApiKey ? "" : (p.apiKey as string));
        try {
          await settings.apply({
            ...config,
            provider: {
              ...provider,
              savedProfiles: {
                ...config.provider.savedProfiles,
                [config.provider.kind]: validateProfile(config.provider),
                [provider.kind]: provider,
              },
            },
          });
        } catch (error) {
          if (p.apiKey !== undefined || p.clearApiKey)
            await secrets.set(scope, previous);
          throw error;
        }
        return;
      }
      case "conversation.create":
        return { id: await history.create() };
      case "conversation.select":
        input(p && typeof p.id === "string");
        await history.select(p.id as string);
        return;
      case "conversation.delete":
        input(p && typeof p.id === "string");
        await history.remove(p.id as string);
        return;
      case "message.send": {
        input(
          p &&
            typeof p.text === "string" &&
            (p.text.trim().length > 0 || (Array.isArray(p.attachments) && p.attachments.length > 0)) &&
            p.text.length <= 8000 &&
            (p.conversationId === null || typeof p.conversationId === "string"),
        );
        if (chat.state().busy) throw new Error("BUSY");
        if (!settings.get().provider.model) throw new Error("PROVIDER");
        input(p.attachments === undefined || (Array.isArray(p.attachments) && p.attachments.length <= 8 && p.attachments.every(id => typeof id === "string")));
        const attachments = p.attachments as string[] | undefined;
        if (attachments) await kernel.resolve("media.assets").get(attachments);
        if (p.conversationId === null) await history.create();
        else await history.select(p.conversationId as string);
        await chat.send({ text: p.text as string, attachments });
        // 所有请求串行，新的会话与首条发送对快照读者原子可见。
        return;
      }
      case "reply.cancel":
        await chat.cancel();
        return;
      case "runtime.set": {
        input(p && typeof p.enabled === "boolean");
        if (!p.enabled) { const a=kernel.resolve('github.deviceAuth');if(a.status().phase==='authorizing')a.cancel(a.status().revision);kernel.resolve('feishu.office').setResident(false); kernel.resolve('feishu.channel').setResident(false); kernel.resolve('companion.care').stop(); await voice.run("voice.stop", undefined); await chat.cancel(); }
        await native.call("runtime.set", { enabled: p.enabled });
        if (p.enabled) { kernel.resolve('feishu.channel').setResident(true); kernel.resolve('feishu.office').setResident(true); }
        return;
      }
      case "runtime.startup.save":
        input(p && typeof p.enabled === "boolean" && Object.keys(p).length === 1);
        return native.call("runtime.startup.save", { enabled: p.enabled });
      case "task.respond": {
        input(
          p &&
            typeof p.id === "string" &&
            (p.choice === undefined || ["once", "session", "whitelist"].includes(String(p.choice))) &&
            ["approve", "stop"].includes(String(p.action)),
        );
        await kernel
          .resolve("agent.approvals")
          .decide(p.id as string, p.action === "approve", (p.choice ?? "once") as import("../../../packages/contracts/agent.ts").ApprovalChoice);
        return;
      }
      default:
        throw new Error("UNAVAILABLE");
    }
  }
  return (request: MobileRequest): Promise<MobileResponse> => {
    // 资料各自拥有写入串行队列；下载 Skill 不得阻塞停止录音/回复和主快照。
    const independent = request.method === "media.import" || request.method === "voice.host" || request.method === "voice.wake.host" || request.method.startsWith("library.") || request.method.startsWith("mcp.") || request.method.startsWith('github.auth.') || request.method.startsWith('care.') || request.method.startsWith('feishu.') || modelMethods.has(request.method);
    const operation = independent ? run(request) : queue.then(() => run(request));
    if (!independent) queue = operation.catch(() => {});
    return operation.then(
      (result) => ({ protocolVersion: 1, id: request.id, ok: true, result }),
      (error) => ({
        protocolVersion: 1,
        id: request.id,
        ok: false,
        error: {
          code: ["INVALID_INPUT", "BUSY", "PROVIDER", "UNAVAILABLE", "NOT_FOUND", "CONFLICT", "LIMIT", "INVALID_DOCUMENT", "CANCELLED", "DOCUMENT_EMPTY", "DOCUMENT_PASSWORD", "DOCUMENT_TIMEOUT", "INVALID_BACKUP", "BACKUP_PASSWORD", "BACKUP_DECRYPT", "BACKUP_RECOVERY"].includes(
            error?.message,
          )
            ? error.message
            : "STORAGE",
        },
      }),
    );
  };
}
