import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { Kernel } from "../../../packages/kernel/index.ts";
import { commands } from "../../../plugins/commands/index.ts";
import { storageLocal } from "../../../plugins/storage-local/index.ts";
import { characterPack } from "../../../plugins/character-pack/index.ts";
import { createSettings } from "../../../plugins/settings/index.ts";
import { petConfig } from "../../../plugins/pet-config/index.ts";
import { personaConfig } from "../../../plugins/conversation/config.ts";
import { providerConfig } from "../../../plugins/provider-compatible/config.ts";
import { providerCompatible } from "../../../plugins/provider-compatible/index.ts";
import { providerOpenai } from "../../../plugins/provider-openai/index.ts";
import { providerDeepseek } from "../../../plugins/provider-deepseek/index.ts";
import { providerGemini } from "../../../plugins/provider-gemini/index.ts";
import { providerClaude } from "../../../plugins/provider-claude/index.ts";
import { providerOpenrouter } from "../../../plugins/provider-openrouter/index.ts";
import { providerLlamacpp } from "../../../plugins/provider-llamacpp/index.ts";
import { llmRegistry } from "../../../plugins/llm-registry/index.ts";
import { llmRouter } from "../../../plugins/llm-router/index.ts";
import { homeFiles } from "../../../plugins/home-files/index.ts";
import { memoryFiles } from "../../../plugins/memory-files/index.ts";
import { memoryJudge } from "../../../plugins/memory-judge/index.ts";
import { memoryTrace } from "../../../plugins/memory-trace/index.ts";
import { createSkillsLocal } from "../../../plugins/skills-local/index.ts";
import { createAgentTools } from "../../../plugins/agent-tools/index.ts";
import { createToolsBasic } from "../../../plugins/tools-basic/index.ts";
import { agentRunner } from "../../../plugins/agent-runner/index.ts";
import {
  contextCompaction,
  contextTools,
} from "../../../plugins/context-compaction/index.ts";
import { conversation } from "../../../plugins/conversation/index.ts";
import { mediaAssets } from "../../../plugins/media-assets/index.ts";
import { createDocumentText } from "../../../plugins/document-text/index.ts";
import { createMediaInput } from "../../../plugins/media-input/index.ts";
import { androidApprovals } from "../../../plugins/platform-android/approvals.ts";
import { createAndroidMedia } from "../../../plugins/platform-android/media.ts";
import { androidAudio } from "../../../plugins/platform-android/audio.ts";
import { voiceApi } from "../../../plugins/voice-api/index.ts";
import { voiceDefaults } from "../../../plugins/voice-api/config.ts";
import { voiceSession } from "../../../plugins/voice-session/index.ts";
import { rendererSprite } from "../../../plugins/renderer-sprite/index.ts";
import { behaviorBasic } from "../../../plugins/behavior-basic/index.ts";
import { bubbleChat } from "../../../plugins/bubble-chat/index.ts";
import { createMcpClient } from "../../../plugins/mcp-client/index.ts";
import { androidLocation } from "../../../plugins/platform-android/location.ts";
import { createCompanionCare } from "../../../plugins/companion-care/index.ts";
import { channelChat } from "../../../plugins/channel-chat/index.ts";
import { createFeishuChannel } from "../../../plugins/feishu-channel/index.ts";
import type { FeishuTransportFactory } from "../../../plugins/feishu-channel/transport.ts";
import { androidFeishuOffice, type AndroidFeishuOfficeOptions } from "../../../plugins/feishu-android/index.ts";
import { androidFeishuAuth, type AndroidFeishuAuthOptions } from "../../../plugins/feishu-android/auth.ts";
import { githubDeviceAuth, type GithubDeviceOptions } from "../../../plugins/github-integration/device-auth.ts";
import { amapCare } from "../../../plugins/amap-care/index.ts";
import { appUpdates } from "../../../plugins/app-updates/index.ts";
import { FAMILIAR_VERSION } from "../../../packages/contracts/updates.ts";
import {
  androidSecrets,
  androidTools,
  type AndroidNative,
} from "../../../plugins/platform-android/index.ts";

/** 这里只装配已有业务插件；Android 原生所有者通过窄接口提供平台 I/O。 */
export async function bootstrapAndroid(
  root: string,
  assets: string,
  native: AndroidNative,
  options: { feishuTransport?: FeishuTransportFactory; feishuPollMs?: number; feishuOffice?: AndroidFeishuOfficeOptions; feishuAuth?: AndroidFeishuAuthOptions; githubAuth?: GithubDeviceOptions } = {},
) {
  const kernel = new Kernel({
    grants: {
      "familiar.storage-local": ["storage.app"],
      "familiar.media-android": ["storage.app"],
      "familiar.audio-android": ["storage.app", "device.microphone"],
      "familiar.voice-api": ["network.voice"],
      "familiar.voice-session": ["device.microphone", "network.voice"],
      "familiar.character-pack": ["assets.read"],
      "familiar.home-files": ["storage.app"],
      "familiar.secrets-android": ["secrets.model"],
      "familiar.app-updates": ["network.updates", "files.updates"],
      "familiar.github-device-auth": ["network.github"],
      "familiar.tools-android": ["device.accessibility", "device.calendar", "device.notes"],
      "familiar.mcp-client": ["network.mcp"],
      "familiar.location-android": ["device.location"],
      "familiar.amap-care": ["network.amap"],
      "familiar.feishu-channel": ["network.feishu"],
      "familiar.feishu-office-android": ["process.feishu", "network.feishu"],
      "familiar.feishu-auth-android": ["network.feishu"],
      ...Object.fromEntries(
        [
          "compatible",
          "openai",
          "deepseek",
          "gemini",
          "claude",
          "openrouter",
          "llamacpp",
        ].map((id) => [`familiar.provider-${id}`, ["network.model"]]),
      ),
    },
    log: ({ plugin }) => console.error(`[${plugin}] 运行事件`),
  });
  const home = join(root, "home");
  const plugins = [
    commands,
    storageLocal(join(root, "data")),
    appUpdates({currentVersion: FAMILIAR_VERSION, platform: 'android-arm64', directory: join(root, 'updates'), open: async (_path, asset) => {await native.call('updates.open', {name: asset.name});}, notify: state => native.call('updates.present', {...state}).then(() => {})}),
    characterPack(join(assets, "characters")),
    petConfig,
    personaConfig,
    providerConfig,
    createSettings(async (pet) => {
      await native.call("companion.update", { characterId: pet.character, scale: pet.scale, visible: pet.visible });
    }),
    androidSecrets(native),
    llmRegistry,
    providerCompatible,
    providerOpenai,
    providerDeepseek,
    providerGemini,
    providerClaude,
    providerOpenrouter,
    providerLlamacpp,
    llmRouter,
    mediaAssets,
    createDocumentText(join(assets, "document-worker.cjs")),
    createAndroidMedia(root),
    createMediaInput({ desktopCapture: false }),
    homeFiles(home, home),
    memoryTrace,
    memoryJudge,
    memoryFiles,
    createSkillsLocal({ builtinIds: ["companion-memory", "workspace-files"] }),
    createAgentTools({ adaptiveCatalog: true }),
    androidApprovals(native),
    githubDeviceAuth({...options.githubAuth,open:async(url,userCode)=>{await native.call('github.auth.open',{url,userCode});}}),
    createMcpClient({stdio:false,trustReadOnlyHints:false,githubWritesRequireApproval:true,deferLargeCatalogs:true,githubDeviceAuth:true}),
    createToolsBasic({ shell: false, mcpInstall: false, confineWorkspace: true }),
    agentRunner,
    contextCompaction,
    contextTools,
    conversation,
    channelChat,
    createFeishuChannel({ available: async () => (await native.call<{ running: boolean }>("runtime.status")).running, transport: options.feishuTransport, pollMs: options.feishuPollMs }),
    androidFeishuAuth({ ...options.feishuAuth, open: async url => { await native.call("feishu.auth.open", { url }); } }),
    androidFeishuOffice({ ...options.feishuOffice, resident: async () => (await native.call<{ running: boolean } | null>("runtime.status"))?.running === true }),
    androidAudio(root, native),
    rendererSprite,
    behaviorBasic,
    bubbleChat,
    androidLocation(native),
    amapCare,
    createCompanionCare({canRun:async()=>(await native.call<boolean>('care.available')) && !kernel.resolve('voice.session').state().active}),
    voiceApi(join(root, "voice-cache"), join(assets, "voice-samples"), { ...voiceDefaults, wakeEnabled: false, identity: "provider", tts: { ...voiceDefaults.tts, reference: false } }),
    voiceSession(join(assets, "voice-samples")),
    androidTools(native),
  ];
  for (const plugin of plugins) kernel.install(plugin);
  try {
    await kernel.startAll();
    await native.call("companion.update", {
      characterId: kernel.resolve("settings").get().pet.character,
      scale: kernel.resolve("settings").get().pet.scale,
      visible: kernel.resolve("settings").get().pet.visible,
    });
    await rm(join(root, "startup-diagnostic.json"), { force: true });
  } catch (error) {
    // 私有诊断只保留插件状态、异常类别和代码位置，不写错误正文或配置。
    await writeFile(
      join(root, "startup-diagnostic.json"),
      JSON.stringify({
        runtime: process.version,
        platform: process.platform,
        errorName: error instanceof Error ? error.name : "unknown",
        frames:
          error instanceof Error
            ? error.stack?.split("\n").filter((line) => /^\s+at /.test(line))
            : [],
        plugins: kernel.snapshot().map(({ id, status }) => ({ id, status })),
      }),
      { mode: 0o600 },
    ).catch(() => {});
    await kernel.dispose().catch(() => {});
    throw error;
  }
  return kernel;
}
