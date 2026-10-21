import { createExperienceSettings } from "./experience-settings.js";
import { createVoiceSettings } from "./voice-settings.js";
import { createIntegrationSettings } from "./integration-settings.js";
import { createModelSettings } from "./model-settings.js";
import { createCompanionSettings } from "./companion-settings.js";
const api = window.familiar,
  $ = (id) => document.getElementById(id);
let snapshot,
  dirty = false,
  editVersion = 0,
  toastTimer,
  polling = false,
  characterSignature = "",
  // 切换后作废切换前发出的状态轮询，避免旧结果把开关弹回去。
  autostartEpoch = 0;
const autostartNote = "只启动宠物，控制器需要时再打开。立即生效。";
const modelSettings = createModelSettings(
  api,
  () => {
    dirty = true;
  },
  toast,
);
// 标题说明这一页做什么；导航名称与之保持一致。
const titles = {
  home: ["形象与桌面", "选择角色和大小，调整它在桌面上的样子。修改立即生效。"],
  persona: ["名字与性格", "它怎么称呼自己、用什么语气说话。从下一轮对话开始生效。"],
  voice: [
    "图片与语音",
    "唤醒、语音对话、宠物的声音和截图。文字输入一直可用。",
  ],
  care: ["主动关怀", "让它在合适的时候问候你，或按你设定的时间提醒。时间按本机时区。"],
  history: [
    "历史会话",
    "查看过去的对话，也可以在这里接着聊。在此页聊天时，宠物不弹气泡。",
  ],
  memories: [
    "记忆与日记",
    "核心规则、日记、教训和扩展记忆都是你能查看和编辑的文件。",
  ],
  model: ["模型连接", "给对话接上模型服务。每个服务分别保存设置和密钥。"],
  permissions: [
    "工具权限",
    "决定宠物使用工具时默认允许、先问你，还是禁止。",
  ],
  skills: ["Skills", "按需读取的方法说明。安装不会运行其中的脚本。"],
  mcp: ["MCP 工具", "连接外部工具服务。密钥加密保存，具体操作按工具权限确认。"],
  integrations: [
    "飞书与 GitHub",
    "在飞书私聊里和它说话，或让它处理文档、日程、仓库和 Issue。",
  ],
  system: ["运行与插件", "宠物在后台独立运行。这里管理启动、会话和插件状态。"],
};
const states = {
  idle: "自在待着，随时等你",
  think: "正在想一想",
  sleep: "在睡觉，叫一声就醒",
  happy: "今天也挺开心",
  drag: "跟着你换个地方",
};
const companion = createCompanionSettings(api, toast);
const experience = createExperienceSettings(api, toast);
const integrations = createIntegrationSettings(api, toast);
const voice = createVoiceSettings(api, toast);
let petTimer,
  petPending = {},
  petWriting = false;
async function savePet() {
  if (petWriting || !Object.keys(petPending).length) return;
  petWriting = true;
  const patch = petPending;
  petPending = {};
  try {
    const result = await api.request("settings.pet", patch);
    if (snapshot) snapshot.settings = result;
    editVersion = result.version;
    $("pet-save-status").textContent = "已自动保存";
  } catch (e) {
    toast(e.message, true);
    $("pet-save-status").textContent = "保存失败，请重试";
  } finally {
    petWriting = false;
    if (Object.keys(petPending).length) void savePet();
  }
}
function livePet(patch) {
  Object.assign(petPending, patch);
  $("pet-save-status").textContent = "正在应用…";
  clearTimeout(petTimer);
  petTimer = setTimeout(savePet, 80);
}
function show(page) {
  document
    .querySelectorAll(".page")
    .forEach((p) => (p.hidden = p.id !== page));
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("selected", b.dataset.page === page));
  [$("page-title").textContent, $("page-description").textContent] =
    titles[page];
  window.scrollTo(0, 0);
  if (page === "model") modelSettings.activate();
  companion.activate(page);
  experience.activate(page);
  integrations.activate(page);
  voice.activate(page);
}
document
  .querySelectorAll("nav button")
  .forEach((button) => (button.onclick = () => show(button.dataset.page)));
function toast(text, error = false) {
  $("toast").textContent = text;
  $("toast").className = error ? "error" : "";
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6000);
}
async function action(button, method, params, success) {
  button.dataset.pending = "true";
  button.disabled = true;
  try {
    const result = await api.request(method, params);
    if (success)
      toast(typeof success === "function" ? success(result) : success);
    return result;
  } catch (e) {
    toast(e.message, true);
  } finally {
    delete button.dataset.pending;
    button.disabled = false;
  }
}
const selectedCharacter = () =>
  document.querySelector('#character input[name="character"]:checked')
    ?.value ?? snapshot?.settings.pet.character;
function renderCharacters(list) {
  const signature = JSON.stringify(list.map((c) => [c.id, c.name]));
  if (signature === characterSignature) return;
  characterSignature = signature;
  $("character").replaceChildren(
    ...list.map((c) => {
      const option = document.createElement("label"),
        input = document.createElement("input"),
        image = document.createElement("img"),
        name = document.createElement("b"),
        persona = document.createElement("small");
      option.className = "character-option";
      option.title = c.description || c.name;
      input.type = "radio";
      input.name = "character";
      input.value = c.id;
      input.onchange = () => {
        document.body.dataset.character = c.id;
        previewCharacter();
        livePet({ character: c.id });
      };
      image.src = c.preview;
      image.alt = "";
      name.textContent = c.name;
      persona.textContent =
        snapshot?.personas.find((p) => p.id === c.recommendedPersona)?.name ??
        "";
      option.append(input, image, name, persona);
      return option;
    }),
  );
}
function fill(config) {
  editVersion = config.version;
  if (!petWriting && !Object.keys(petPending).length) {
    $("scale").value = Math.round(config.pet.scale * 100);
    $("scale-value").textContent = $("scale").value + "%";
    $("topmost").checked = config.pet.topmost;
    $("quiet").checked = config.pet.quiet;
    for (const input of document.querySelectorAll("#character input"))
      input.checked = input.value === config.pet.character;
    $("bubble-seconds").value = config.pet.bubbleSeconds;
  }
  $("name").value = config.persona.name;
  $("instruction").value = config.persona.instruction;
  $("persona-style").replaceChildren(
    ...[
      { id: "character", name: "跟随角色推荐" },
      ...snapshot.personas,
      { id: "custom", name: "完全自定义" },
    ].map((p) => new Option(p.name, p.id)),
  );
  $("persona-style").value = config.persona.style ?? "custom";
  previewCharacter();
  modelSettings.fill(config.provider, snapshot.providers);
}
function stage(data) {
  document.body.dataset.petState = data.behavior || "idle";
  $("pet-name").textContent = data.settings.persona.name;
  $("pet-state").textContent = states[data.behavior] || "在你身边";
}
async function refresh(force = false) {
  if (polling) return;
  polling = true;
  const epoch = autostartEpoch;
  try {
    const data = await api.request("runtime.status");
    if (data.apiVersion !== 4)
      throw new Error("宠物仍在运行旧版本。请退出宠物和控制器后重新启动");
    snapshot = data;
    void api.request('updates.state').then(renderUpdate).catch(() => {});
    if (!petWriting && !Object.keys(petPending).length)
      document.body.dataset.character = data.settings.pet.character;
    if (epoch === autostartEpoch && !$("autostart").dataset.pending) {
      $("autostart").checked = data.autostart;
      $("autostart").disabled = !!data.autostartUnavailable;
      $("autostart-note").textContent =
        data.autostartUnavailable || autostartNote;
    }
    $("offline").hidden = true;
    $("dot").classList.remove("offline");
    $("connection").textContent = "宠物正在运行";
    stage(data);
    $("visibility").textContent = data.settings.pet.visible
      ? "隐藏宠物"
      : "显示宠物";
    $("memory").textContent =
      `主进程内存 ${Math.round(data.metrics.memory / 1024 / 1024)} MB`;
    renderCharacters(data.characters);
    if ((force || !dirty) && !petWriting && !Object.keys(petPending).length) {
      fill(data.settings);
      dirty = false;
    } else previewCharacter();
    modelSettings.usage(data.session);
    $("plugins").replaceChildren(
      ...data.plugins.map((p) => {
        const el = document.createElement("div"),
          name = document.createElement("b"),
          state = document.createElement("span");
        el.className = "plugin";
        name.textContent = p.id.replace("familiar.", "");
        name.title = p.id;
        state.textContent = p.status === "running" ? "运行中" : p.status;
        if (p.status !== "running") state.className = "off";
        el.append(name, state);
        return el;
      }),
    );
    document
      .querySelectorAll(".save,#test,#save-key")
      .forEach((b) => (b.disabled = b.dataset.pending === "true"));
    document.body.dataset.connected = "true";
    // 小窗里的光环只表示语音会话正在进行；读取失败不影响其它状态。
    api
      .request("voice.state")
      .then((v) => (document.body.dataset.voice = v?.active ? "active" : "idle"))
      .catch(() => (document.body.dataset.voice = "idle"));
  } catch (e) {
    snapshot = undefined;
    $("offline").hidden = false;
    $("offline").querySelector("b").textContent = e.message || "宠物还没有醒来";
    $("dot").classList.add("offline");
    $("connection").textContent = "宠物未连接";
    $("pet-state").textContent = "还没有醒来";
    document.body.dataset.connected = "false";
    document
      .querySelectorAll(".save,#test,#save-key")
      .forEach((b) => (b.disabled = true));
    // 离线时读不到真实状态，禁止切换，免得开关显示已开启而系统里并没有启动项。
    if (!$("autostart").dataset.pending) {
      $("autostart").disabled = true;
      $("autostart-note").textContent = "宠物运行时才能查看和修改。";
    }
  } finally {
    polling = false;
  }
}
let updateState;
function renderUpdate(state) {
  updateState = state;
  const available = !!state.assetName && !!state.latestVersion && state.latestVersion !== state.currentVersion;
  $('update-title').textContent = available ? `发现新版本 ${state.latestVersion}` : `Familiar ${state.currentVersion}`;
  $('update-detail').textContent = state.error || (state.phase === 'downloading' ? `正在下载 ${state.assetName} · ${Math.floor(state.downloadedBytes / state.totalBytes * 100)}%` : state.phase === 'ready' ? '安装包已校验，点击打开文件位置。' : state.phase === 'checking' ? '正在检查 GitHub 正式版…' : available ? '点击即可下载 Windows 安装包，模型设置和记忆会保留。' : state.phase === 'current' ? '已经是最新正式版。' : '启动后自动检查 GitHub 正式版。');
  $('update-check').disabled = ['checking', 'downloading'].includes(state.phase);
  $('update-action').hidden = !available || ['checking', 'downloading'].includes(state.phase);
  $('update-action').textContent = state.phase === 'ready' ? '打开安装包位置' : state.phase === 'error' ? '重试下载' : '下载更新';
  $('update-cancel').hidden = state.phase !== 'downloading';
}
$('update-check').onclick = () => action($('update-check'), 'updates.check', undefined).then(s => s && renderUpdate(s));
$('update-action').onclick = () => action($('update-action'), updateState?.phase === 'ready' ? 'updates.open' : 'updates.download', undefined).then(s => s && renderUpdate(s));
$('update-cancel').onclick = () => action($('update-cancel'), 'updates.cancel', undefined).then(s => s && renderUpdate(s));
for (const input of document.querySelectorAll(
  "#persona input,#persona textarea,#persona select,#model input:not(#api-key):not(#model-search),#model select",
))
  input.addEventListener("input", () => {
    dirty = true;
  });
$("scale").oninput = () => {
  $("scale-value").textContent = $("scale").value + "%";
  livePet({ scale: Number($("scale").value) / 100 });
};
for (const key of ["topmost", "quiet"])
  $(key).onchange = () => livePet({ [key]: $(key).checked });
$("bubble-seconds").onchange = () =>
  livePet({ bubbleSeconds: Number($("bubble-seconds").value) });
function values() {
  const config = structuredClone(snapshot.settings);
  config.version = editVersion;
  config.pet.bubbleSeconds = Number($("bubble-seconds").value);
  config.pet.scale = Number($("scale").value) / 100;
  config.pet.topmost = $("topmost").checked;
  config.pet.quiet = $("quiet").checked;
  config.pet.character = selectedCharacter();
  config.persona.name = $("name").value;
  config.persona.instruction = $("instruction").value;
  config.persona.style = $("persona-style").value;
  config.provider = {
    ...modelSettings.read(),
    savedProfiles: config.provider.savedProfiles,
  };
  return config;
}
function previewCharacter() {
  const character = snapshot?.characters.find(
    (c) => c.id === selectedCharacter(),
  );
  if (
    character?.preview &&
    $("character-preview").getAttribute("src") !== character.preview
  )
    $("character-preview").src = character.preview;
  const chosen = $("persona-style").value;
  const style = chosen === "character" ? character?.recommendedPersona : chosen;
  const preset = snapshot?.personas.find((p) => p.id === style);
  $("persona-description").textContent = preset
    ? `${preset.name}：${preset.description}`
    : "按你写下的表达习惯相处。";
  $("persona-example").textContent = preset
    ? `比如：${preset.example}`
    : "原有的自定义设定会完整保留。";
}
$("persona-style").onchange = previewCharacter;
document.querySelectorAll(".save").forEach(
  (button) =>
    (button.onclick = async () => {
      if (!snapshot) return;
      clearTimeout(petTimer);
      await savePet();
      if (petWriting) {
        toast("正在保存外观，请稍后再保存模型设置");
        return;
      }
      const result = await action(
        button,
        "settings.apply",
        values(),
        "设置已生效，模型和性格从下一轮对话开始使用",
      );
      if (result) {
        dirty = false;
        await refresh(true);
      }
    }),
);
$("refresh").onclick = () => {
  if (dirty && !confirm("刷新会放弃尚未保存的设置，继续吗？")) return;
  void refresh(true);
};
$("start").onclick = () =>
  action($("start"), "runtime.start", undefined, "正在启动宠物…");
$("chat").onclick = () => action($("chat"), "chat.open");
$("sleep").onclick = () => action($("sleep"), "pet.sleep");
$("reset").onclick = () =>
  action($("reset"), "pet.reset", undefined, "宠物已回到屏幕内");
$("visibility").onclick = () =>
  snapshot &&
  action($("visibility"), "pet.show", !snapshot.settings.pet.visible);
$("test").onclick = () =>
  action($("test"), "provider.test", undefined, (result) => result);
$("clear-chat").onclick = () => {
  if (confirm("开始新会话？当前对话会保留在历史会话中。"))
    void action(
      $("clear-chat"),
      "chat.clear",
      undefined,
      "已开始新会话，旧对话保留在历史会话中",
    );
};
$("stop").onclick = () => {
  if (confirm("退出宠物？控制器会保持打开，可以再次启动。"))
    void action(
      $("stop"),
      "runtime.stop",
      undefined,
      "宠物正在退出，控制器保持打开",
    );
};
$("autostart").onchange = async () => {
  const wanted = $("autostart").checked;
  autostartEpoch++;
  const result = await action(
    $("autostart"),
    "autostart.set",
    wanted,
    "登录启动设置已应用",
  );
  // 失败时回到原状态，不让开关停在没有生效的位置。
  $("autostart").checked = typeof result === "boolean" ? result : !wanted;
  autostartEpoch++;
  await refresh();
};
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 1500);
