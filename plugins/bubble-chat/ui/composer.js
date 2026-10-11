const api = window.familiar,
  $ = (id) => document.getElementById(id);
let busy = false,
  sending = false;
let attachments = [],
  voice = {},
  lastDictation = "";
function renderAttachments() {
  $("attachments").replaceChildren(
    ...attachments.map((a) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${a.kind === "image" ? "▧" : "▤"} ${a.name} ×`;
      b.title = "移除此附件";
      b.onclick = () => {
        attachments = attachments.filter((v) => v.id !== a.id);
        renderAttachments();
      };
      return b;
    }),
  );
}
function add(items) {
  if (!Array.isArray(items)) items = [items];
  if (attachments.length + items.length > 8)
    throw new Error("最多添加 8 个附件");
  attachments.push(...items);
  renderAttachments();
}
const action = (fn) => async () => {
  try {
    error("");
    await fn();
  } catch (e) {
    error(e.message);
  }
};
function voiceState(v) {
  voice = v;
  $("voice-status").textContent = [v.message, v.error]
    .filter(Boolean)
    .join(" · ");
  $("dictate").textContent = v.dictating ? "结束录音" : "麦克风";
  $("voice-start").hidden = v.active;
  $("voice-stop").hidden = !v.active && v.phase !== "speaking";
  $("autoread").checked = v.autoRead;
}
api.on("familiar:voice-state", voiceState);
api.on("familiar:dictation", (v) => {
  if (v.target !== "composer" || v.id === lastDictation) return;
  lastDictation = v.id;
  $("input").value += ($("input").value ? "\n" : "") + v.text;
  $("input").focus();
});
$("attach").onclick = action(async () =>
  add(await api.request("media.choose")),
);
$("snapshot").onclick = action(async () =>
  add(await api.request("media.capture")),
);
$("dictate").onclick = action(() =>
  api.request(voice.dictating ? "voice.finish" : "voice.dictate", {
    target: "composer",
  }),
);
$("voice-start").onclick = action(() => api.request("voice.start"));
$("voice-stop").onclick = action(() => api.request("voice.stop"));
$("autoread").onchange = action(() =>
  api.request("voice.autoread", $("autoread").checked),
);
$("input").addEventListener("paste", (e) => {
  if (
    [...e.clipboardData.items].some((item) => item.type.startsWith("image/"))
  ) {
    e.preventDefault();
    void action(async () => add(await api.request("media.paste")))();
  }
});
void api
  .request("voice.state")
  .then(voiceState)
  .catch(() => {});
function state(value) {
  busy = value.busy;
  $("send").hidden = busy;
  $("cancel").hidden = !busy;
}
function error(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}
api.on("familiar:chat", state);
api.on("familiar:focus", (value) => {
  state(value);
  $("input").focus();
});
$("form").onsubmit = async (event) => {
  event.preventDefault();
  if (busy || sending || (!$("input").value.trim() && !attachments.length))
    return;
  sending = true;
  $("send").disabled = true;
  try {
    await api.request("chat.send", {
      text: $("input").value,
      attachments: attachments.map((a) => a.id),
    });
    $("input").value = "";
    attachments = [];
    renderAttachments();
    error("");
  } catch (e) {
    error(e.message);
  } finally {
    sending = false;
    $("send").disabled = false;
  }
};
$("input").onkeydown = (event) => {
  if (event.key === "Enter" && event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("form").requestSubmit();
  }
};
document.onkeydown = (event) => {
  if (event.key === "Escape" && !event.isComposing)
    void api.request("chat.close");
};
$("close").onclick = () => api.request("chat.close");
$("cancel").onclick = () =>
  api.request("chat.cancel").catch((e) => error(e.message));
void api.request("chat.state").then(state);
window.addEventListener("focus", () => $("input").focus());
