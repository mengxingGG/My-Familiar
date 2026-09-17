const api = window.familiar,
  $ = (id) => document.getElementById(id);
let text = "";
function render(view) {
  text = view.text;
  $("name").textContent = view.name;
  $("state").textContent = view.busy ? "正在回复" : "";
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
$("copy").onclick = () =>
  navigator.clipboard
    .writeText(text)
    .then(() => ($("copy").textContent = "已复制"))
    .catch(() => ($("copy").textContent = "可选择文字复制"));
document.onkeydown = (e) => {
  if (e.key === "Escape") void call("speech.close");
};
