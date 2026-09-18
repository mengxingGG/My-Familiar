import { locationWindows } from "../../plugins/location-windows/index.ts";
import { amapCare } from "../../plugins/amap-care/index.ts";
import { companionCare } from "../../plugins/companion-care/index.ts";
import { experienceControls } from "../../plugins/experience-controls/index.ts";
import { app, dialog } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Kernel } from "../../packages/kernel/index.ts";
import { commands } from "../../plugins/commands/index.ts";
import { storageLocal } from "../../plugins/storage-local/index.ts";
import { platformWindows } from "../../plugins/platform-windows/index.ts";
import { characterPack } from "../../plugins/character-pack/index.ts";
import { settings } from "../../plugins/settings/index.ts";
import { secretsLocal } from "../../plugins/secrets-local/index.ts";
import { rendererSprite } from "../../plugins/renderer-sprite/index.ts";
import { behaviorBasic } from "../../plugins/behavior-basic/index.ts";
import { providerCompatible } from "../../plugins/provider-compatible/index.ts";
import { providerOpenai } from "../../plugins/provider-openai/index.ts";
import { providerDeepseek } from "../../plugins/provider-deepseek/index.ts";
import { providerGemini } from "../../plugins/provider-gemini/index.ts";
import { providerClaude } from "../../plugins/provider-claude/index.ts";
import { providerOpenrouter } from "../../plugins/provider-openrouter/index.ts";
import { providerLlamacpp } from "../../plugins/provider-llamacpp/index.ts";
import { llmRegistry } from "../../plugins/llm-registry/index.ts";
import { llmRouter } from "../../plugins/llm-router/index.ts";
import { conversation } from "../../plugins/conversation/index.ts";
import { bubbleChat } from "../../plugins/bubble-chat/index.ts";
import { runtimeControls } from "../../plugins/runtime-controls/index.ts";
import {
  transportClient,
  transportServer,
} from "../../plugins/transport-local/index.ts";
import { controlCenter } from "../../plugins/control-center/index.ts";
import { petConfig } from "../../plugins/pet-config/index.ts";
import { providerConfig } from "../../plugins/provider-compatible/config.ts";
import { personaConfig } from "../../plugins/conversation/config.ts";
import { autostartWindows } from "../../plugins/autostart-windows/index.ts";
import { homeFiles } from "../../plugins/home-files/index.ts";
import { memoryFiles } from "../../plugins/memory-files/index.ts";
import { skillsLocal } from "../../plugins/skills-local/index.ts";
import { agentTools } from "../../plugins/agent-tools/index.ts";
import { agentRunner } from "../../plugins/agent-runner/index.ts";
import { mcpClient } from "../../plugins/mcp-client/index.ts";
import { toolsBasic } from "../../plugins/tools-basic/index.ts";
import { companionControls } from "../../plugins/companion-controls/index.ts";

// 宿主只做环境引导和官方插件组合，不实现产品业务。
export async function bootstrap(role: "runtime" | "controller") {
  const directory =
    process.env.FAMILIAR_DATA_DIR ?? join(app.getPath("appData"), "Familiar");
  app.setPath("userData", join(directory, role));
  app.setName(role === "runtime" ? "Familiar" : "Familiar Controller");
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  const kernel = new Kernel({
    grants: {
      "familiar.storage-local": ["storage.app"],
      "familiar.platform-windows": ["desktop.windows", "desktop.shortcut"],
      "familiar.character-pack": ["assets.read"],
      "familiar.secrets-local": ["secrets.model"],
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
      "familiar.transport-server": ["ipc.local"],
      "familiar.autostart-windows": ["system.login-item"],
      "familiar.home-files": ["storage.app"],
      "familiar.mcp-client": ["network.mcp", "process.mcp"],
      "familiar.tools-basic": ["process.shell"],
      "familiar.location-windows": ["device.location"],
      "familiar.amap-care": ["network.amap"],
    },
    log: ({ plugin, message }) => console.error(`[${plugin}] ${message}`),
  });
  let exiting = false,
    started = false,
    disposed = false;
  let startup: Promise<void> | undefined;
  const quit = () => {
    if (exiting) return;
    exiting = true;
    void Promise.resolve(startup)
      .catch(() => {})
      .then(() => kernel.dispose())
      .catch((e) => console.error("停止失败", e.message))
      .finally(() => {
        disposed = true;
        app.quit();
      });
  };
  app.on("before-quit", (event) => {
    if (!disposed) {
      event.preventDefault();
      quit();
    }
  });
  app.on("window-all-closed", () => {
    if (role === "controller") quit();
  });
  app.on("second-instance", () => {
    if (started && role === "controller")
      kernel.resolve("platform.surface").show("controller", true);
  });
  await app.whenReady();
  const root = join(app.getAppPath(), "dist");
  const launch = (target: "runtime" | "controller") => {
    const args = [
      ...(!app.isPackaged ? [app.getAppPath()] : []),
      ...(target === "controller" ? ["--controller"] : []),
    ];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    child.on("error", (e) => kernel.report("host.launch", e));
    child.unref();
  };
  const platform = platformWindows({ root, role, launch, quit });
  const plugins =
    role === "runtime"
      ? [
          commands,
          llmRegistry,
          providerCompatible,
          providerOpenai,
          providerDeepseek,
          providerGemini,
          providerClaude,
          providerOpenrouter,
          providerLlamacpp,
          storageLocal(join(directory, "data")),
          platform,
          characterPack(join(root, "characters")),
          petConfig,
          personaConfig,
          providerConfig,
          settings,
          secretsLocal,
          rendererSprite,
          behaviorBasic,
          llmRouter,
          homeFiles(
            process.env.FAMILIAR_HOME ??
              (process.env.FAMILIAR_DATA_DIR ||
              (app.isPackaged &&
                existsSync(join(process.resourcesPath, "familiar-installed")))
                ? join(directory, "home")
                : join(
                    app.isPackaged
                      ? app.getPath("exe").replace(/[^\\/]+$/, "")
                      : app.getAppPath(),
                    ".familiar",
                  )),
            join(directory, "home"),
          ),
          memoryFiles,
          skillsLocal,
          agentTools,
          mcpClient,
          toolsBasic,
          agentRunner,
          companionControls,
          conversation,
          bubbleChat,
          locationWindows,
          amapCare,
          companionCare,
          experienceControls,
          autostartWindows,
          runtimeControls,
          transportServer(directory),
        ]
      : [
          commands,
          storageLocal(join(directory, "controller-data")),
          platform,
          transportClient(directory),
          controlCenter(() => launch("runtime")),
        ];
  try {
    for (const plugin of plugins) kernel.install(plugin);
    startup = kernel.startAll();
    await startup;
    started = true;
  } catch (e) {
    console.error(e);
    if (!exiting)
      dialog.showErrorBox(
        "Familiar 启动失败",
        e instanceof Error ? e.message : String(e),
      );
    quit();
  }
}
