const api = window.familiar,
  $ = (id) => document.getElementById(id);
let busy = false,
  sending = false;
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
  if (busy || sending || !$("input").value.trim()) return;
  sending = true;
  $("send").disabled = true;
  try {
    await api.request("chat.send", $("input").value);
    $("input").value = "";
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
