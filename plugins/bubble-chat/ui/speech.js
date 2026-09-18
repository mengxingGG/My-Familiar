const api = window.familiar,
  $ = (id) => document.getElementById(id);
let text = "";
let approvalId;
function render(view) {
  text = view.text;
  $("name").textContent = view.name;
  $("state").textContent = view.approval
    ? "等待确认"
    : view.busy
      ? view.activity || "正在回复"
      : "";
  if (approvalId !== view.approval?.id) $("allow-scope").value = "once";
  $("allow-scope").disabled = !view.approval?.rule;
  approvalId = view.approval?.id;
  $("approval").hidden = !view.approval;
  $("speech").hidden = !!view.approval;
  $("approval-title").textContent = view.approval?.title || "";
  $("approval-detail").textContent = view.approval?.detail || "";
  $("cancel").hidden = !view.busy;
  const speech = $("speech"),
    follow = speech.scrollHeight - speech.scrollTop - speech.clientHeight < 40;
  speech.textContent = text;
  if (follow) speech.scrollTop = speech.scrollHeight;
  document.body.dataset.busy = String(view.busy);
}
function call(name) {
  return api.request(name).catch((e) => {
    $("speech").textContent = e.message;
  });
}
api.on("familiar:speech", render);
void api.request("speech.state").then(render);
$("close").onclick = () => call("speech.close");
$("continue").onclick = () => call("chat.open");
$("cancel").onclick = () => call("chat.cancel");
for (const [id, allow] of [
  ["allow", true],
  ["deny", false],
])
  $(id).onclick = () =>
    api
      .request("agent.decide", {
        id: approvalId,
        allow,
        choice: $("allow-scope").value,
      })
      .catch((e) => {
        $("approval-detail").textContent = e.message;
      });
$("copy").onclick = () =>
  navigator.clipboard
    .writeText(text)
    .then(() => ($("copy").textContent = "已复制"))
    .catch(() => ($("copy").textContent = "可选择文字复制"));
document.onkeydown = (e) => {
  if (e.key === "Escape") void call("speech.close");
};

document.body.addEventListener("mouseenter", () =>
  api.request("speech.hover", true).catch(() => {}),
);
document.body.addEventListener("mouseleave", () =>
  api.request("speech.hover", false).catch(() => {}),
);
