import { createExperienceSettings } from "./experience-settings.js";
import { createModelSettings } from "./model-settings.js";
import { createCompanionSettings } from "./companion-settings.js";
const api = window.familiar,
  $ = (id) => document.getElementById(id);
let snapshot,
  dirty = false,
  editVersion = 0,
  toastTimer,
  polling = false;
const modelSettings = createModelSettings(
  api,
  () => {
    dirty = true;
  },
  toast,
);
const titles = {
  history: [
    "相处过的话，都在这里。",
    "查看旧对话，也可以接着聊；在这里聊天时，宠物气泡会安静下来。",
  ],
  permissions: [
    "让信任，有自己的分寸。",
    "设置默认选择，也能随时撤销会话授权和白名单。",
  ],
  care: [
    "合适的时候，问候一句。",
    "少一点打扰，多一点惦记。时间按这台电脑的本地时区安排。",
  ],
  memories: [
    "把相处，慢慢记下来。",
    "核心记忆、每日日记与经验教训，都在你能查看和编辑的文件里。",
  ],
  skills: [
    "一起学会，更多小事。",
    "方法说明独立管理，按需读取，也可以由你自己安装。",
  ],
  mcp: ["需要时，搭把手。", "外部工具独立连接，具体操作由你掌握。"],
  home: ["让桌面，多一点陪伴。", "它有自己的小日常，也随时愿意听你说说话。"],
  model: ["每一句话，都有回应。", "连接你选择的模型，让陪伴从文字开始。"],
  persona: ["慢慢认识，慢慢熟悉。", "一个名字，一点性格，成为你熟悉的伙伴。"],
  system: ["安静运行，各司其职。", "宠物独立常驻，每一种能力都可单独演进。"],
};
const companion = createCompanionSettings(api, toast);
const experience = createExperienceSettings(api, toast);
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
document.querySelectorAll("nav button").forEach(
  (button) =>
    (button.onclick = () => {
      document
        .querySelectorAll(".page")
        .forEach((p) => (p.hidden = p.id !== button.dataset.page));
      document
        .querySelectorAll("nav button")
        .forEach((b) => b.classList.toggle("selected", b === button));
      [$("page-title").textContent, $("page-description").textContent] =
        titles[button.dataset.page];
      window.scrollTo(0, 0);
      if (button.dataset.page === "model") modelSettings.activate();
      companion.activate(button.dataset.page);
      experience.activate(button.dataset.page);
    }),
);
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
function fill(config) {
  editVersion = config.version;
  if (!petWriting && !Object.keys(petPending).length) {
    $("scale").value = Math.round(config.pet.scale * 100);
    $("scale-value").textContent = $("scale").value + "%";
    $("topmost").checked = config.pet.topmost;
    $("quiet").checked = config.pet.quiet;
    $("character").value = config.pet.character;
    $("bubble-seconds").value = config.pet.bubbleSeconds;
    document.querySelector(".preview-creature").style.scale = String(
      config.pet.scale,
    );
  }
  $("name").value = config.persona.name;
  $("instruction").value = config.persona.instruction;
  modelSettings.fill(config.provider, snapshot.providers);
}
async function refresh(force = false) {
  if (polling) return;
  polling = true;
  try {
    const data = await api.request("runtime.status");
    if (data.apiVersion !== 3)
      throw new Error("宠物仍运行旧版本，请退出宠物和控制器后重新启动");
    const wasOffline = !snapshot;
    snapshot = data;
    if (!petWriting && !Object.keys(petPending).length)
      document.body.dataset.character = data.settings.pet.character;
    if (!$("autostart").disabled) $("autostart").checked = data.autostart;
    $("offline").hidden = true;
    $("dot").classList.remove("offline");
    $("connection").textContent = "宠物正在独立运行";
    $("pet-name").textContent = data.settings.persona.name;
    $("pet-state").textContent =
      {
        idle: "自在待着，随时等你",
        think: "正在认真想一想",
        sleep: "正在睡觉，轻轻叫醒它",
        happy: "今天也有小小的开心",
        drag: "跟着你，换个地方",
      }[data.behavior] || "在你身边";
    $("visibility").textContent = data.settings.pet.visible
      ? "隐藏宠物"
      : "显示宠物";
    $("memory").textContent =
      `主进程内存 ${Math.round(data.metrics.memory / 1024 / 1024)} MB`;
    if ((force || !dirty) && !petWriting && !Object.keys(petPending).length) {
      const select = $("character");
      select.replaceChildren(
        ...data.characters.map((c) => {
          const o = document.createElement("option");
          o.value = c.id;
          o.textContent = c.name;
          return o;
        }),
      );
      fill(data.settings);
      dirty = false;
    }
    modelSettings.usage(data.session);
    $("plugins").replaceChildren(
      ...data.plugins.map((p) => {
        const el = document.createElement("div");
        el.className = "plugin";
        const name = document.createElement("b");
        name.textContent = p.id.replace("familiar.", "");
        const state = document.createElement("span");
        state.textContent = p.status === "running" ? "● 运行中" : p.status;
        el.append(name, state);
        return el;
      }),
    );
    document
      .querySelectorAll(".save,#test,#save-key")
      .forEach((b) => (b.disabled = b.dataset.pending === "true"));
    if (wasOffline) document.body.dataset.connected = "true";
  } catch (e) {
    snapshot = undefined;
    $("offline").hidden = false;
    $("offline").querySelector("b").textContent = e.message || "宠物还没有醒来";
    $("dot").classList.add("offline");
    $("connection").textContent = "宠物未连接";
    document.body.dataset.connected = "false";
    document
      .querySelectorAll(".save,#test,#save-key")
      .forEach((b) => (b.disabled = true));
  } finally {
    polling = false;
  }
}
for (const input of document.querySelectorAll(
  "#persona input,#persona textarea,#model input:not(#api-key):not(#model-search),#model select",
))
  input.addEventListener("input", () => {
    dirty = true;
  });
$("scale").oninput = () => {
  $("scale-value").textContent = $("scale").value + "%";
  document.querySelector(".preview-creature").style.scale = String(
    Number($("scale").value) / 100,
  );
  livePet({ scale: Number($("scale").value) / 100 });
};
$("character").onchange = () => {
  document.body.dataset.character = $("character").value;
  livePet({ character: $("character").value });
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
  config.pet.character = $("character").value;
  config.persona.name = $("name").value;
  config.persona.instruction = $("instruction").value;
  config.provider = {
    ...modelSettings.read(),
    savedProfiles: config.provider.savedProfiles,
  };
  return config;
}
document.querySelectorAll(".save").forEach(
  (button) =>
    (button.onclick = async () => {
      if (!snapshot) return;
      clearTimeout(petTimer);
      await savePet();
      if (petWriting) {
        toast("正在保存外观，请稍候再保存模型设置");
        return;
      }
      const result = await action(
        button,
        "settings.apply",
        values(),
        "设置已生效；模型和性格从下一轮聊天开始使用",
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
  action($("start"), "runtime.start", undefined, "正在唤醒宠物…");
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
      "已开始新会话，旧对话保留在历史中",
    );
};
$("stop").onclick = () =>
  action(
    $("stop"),
    "runtime.stop",
    undefined,
    "宠物正在退出，控制器会保持打开",
  );
$("autostart").onchange = async () => {
  await action(
    $("autostart"),
    "autostart.set",
    $("autostart").checked,
    "登录启动设置已应用",
  );
  await refresh();
};
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 1500);
