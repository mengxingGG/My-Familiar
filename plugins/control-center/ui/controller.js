const api = window.familiar,
  $ = (id) => document.getElementById(id);
let snapshot,
  dirty = false,
  editVersion = 0,
  toastTimer,
  polling = false;
const titles = {
  home: ["让桌面，多一点陪伴。", "它有自己的小日常，也随时愿意听你说说话。"],
  model: ["每一句话，都有回应。", "连接你选择的模型，让陪伴从文字开始。"],
  persona: ["慢慢认识，慢慢熟悉。", "一个名字，一点性格，成为你熟悉的伙伴。"],
  system: ["安静运行，各司其职。", "宠物独立常驻，每一种能力都可单独演进。"],
};
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
  $("scale").value = Math.round(config.pet.scale * 100);
  $("scale-value").textContent = $("scale").value + "%";
  $("topmost").checked = config.pet.topmost;
  $("quiet").checked = config.pet.quiet;
  $("character").value = config.pet.character;
  $("name").value = config.persona.name;
  $("instruction").value = config.persona.instruction;
  $("base-url").value = config.provider.baseUrl;
  $("model-id").value = config.provider.model;
  $("temperature").value = config.provider.temperature;
  $("temperature-value").textContent = config.provider.temperature;
}
async function refresh(force = false) {
  if (polling) return;
  polling = true;
  try {
    const data = await api.request("runtime.status");
    const wasOffline = !snapshot;
    snapshot = data;
    document.body.dataset.character = data.settings.pet.character;
    $("autostart").checked = data.autostart;
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
    if (force || !dirty) {
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
    $("key-status").textContent = data.hasKey
      ? "已保存密钥（系统加密）。留空不会覆盖已有密钥。"
      : "尚未保存密钥；本地服务可以不填写。";
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
  "input:not(#api-key):not(#autostart),select,textarea",
))
  input.addEventListener("input", () => {
    dirty = true;
  });
$("scale").oninput = () => {
  $("scale-value").textContent = $("scale").value + "%";
};
$("temperature").oninput = () => {
  $("temperature-value").textContent = $("temperature").value;
};
function values() {
  const config = structuredClone(snapshot.settings);
  config.version = editVersion;
  config.pet.scale = Number($("scale").value) / 100;
  config.pet.topmost = $("topmost").checked;
  config.pet.quiet = $("quiet").checked;
  config.pet.character = $("character").value;
  config.persona.name = $("name").value;
  config.persona.instruction = $("instruction").value;
  config.provider.baseUrl = $("base-url").value;
  config.provider.model = $("model-id").value;
  config.provider.temperature = Number($("temperature").value);
  return config;
}
document.querySelectorAll(".save").forEach(
  (button) =>
    (button.onclick = async () => {
      if (!snapshot) return;
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
$("save-key").onclick = async () => {
  if (!$("api-key").value) {
    toast("请输入密钥；删除密钥请使用下方按钮");
    return;
  }
  await action(
    $("save-key"),
    "secret.set",
    $("api-key").value,
    "密钥已加密保存",
  );
  $("api-key").value = "";
  void refresh();
};
$("delete-key").onclick = () => {
  if (confirm("删除已保存的模型密钥？"))
    void action($("delete-key"), "secret.set", "", "密钥已删除");
};
$("clear-chat").onclick = () => {
  if (confirm("停止生成并永久清空本地对话记录？"))
    void action($("clear-chat"), "chat.clear", undefined, "对话已清空");
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
