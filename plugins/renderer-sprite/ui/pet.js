const api = window.familiar,
  canvas = document.querySelector("#pet"),
  context = canvas.getContext("2d", { willReadFrequently: true });
let sprite = {frames:{},fps:6},
  frames = {},
  action = "idle",
  current = [],
  index = 0,
  fps = 8,
  timer,
  hit = false,
  down,
  dragging = false,
  generation = 0,
  playGeneration = 0,
  playingAction = 'idle';
const call = (method, params) => api.request(method, params).catch(() => {});
function draw() {
  context.clearRect(0, 0, 260, 300);
  const image = current[index];
  if (image) context.drawImage(image, 20, 72, 220, 205);
}
async function play() {
  clearTimeout(timer);
  const version = ++playGeneration;
  playingAction = sprite.frames[action]?.length ? action : 'idle';
  const name = playingAction;
  if (!frames[name]) {
    const loaded = await Promise.all((sprite.frames[name] || []).map(src => new Promise(resolve => {
      const image = new Image();image.onload = () => resolve(image);image.onerror = () => resolve(null);image.src = src;
    })));
    if(version !== playGeneration) return;
    frames[name] = loaded;
  }
  if(version !== playGeneration) return;
  current = frames[name];
  index = 0;
  const step = () => {
    if(version !== playGeneration || document.hidden) return;
    draw();
    const ms = sprite.timings?.[name]?.[index] ?? 1000 / fps;
    if(current.length <= 1 || sprite.loops?.[name] === false && index === current.length - 1) return;
    timer = setTimeout(() => {index = (index + 1) % current.length;step();}, ms);
  };
  step();
}
api.on("familiar:character", (character) => {
  generation++;
  sprite = character.representations.sprite;
  frames = {};
  fps = sprite.fps;
  play();
  document.body.dataset.character = character.id;
});
api.on("familiar:action", (value) => {
  if (action === value) return;
  action = value;
  document.body.dataset.action = value;
  play();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {clearTimeout(timer);playGeneration++;}
  else play();
});
document.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect(),
    x = Math.floor(((event.clientX - rect.left) * 260) / rect.width),
    y = Math.floor(((event.clientY - rect.top) * 300) / rect.height);
  const inside = x >= 0 && x < 260 && y >= 0 && y < 300;
  const next =
    dragging ||
    !!event.target.closest("button") ||
    (inside && context.getImageData(x, y, 1, 1).data[3] > 35);
  if (next !== hit) {
    hit = next;
    call("pet.hit", hit);
  }
  if (
    down &&
    !dragging &&
    Math.hypot(event.screenX - down.x, event.screenY - down.y) > 4
  ) {
    dragging = true;
    call("pet.drag-start");
  }
});
canvas.addEventListener("mousedown", (event) => {
  if (event.button === 0 && hit) down = { x: event.screenX, y: event.screenY };
});
document.addEventListener("mouseup", () => {
  if (dragging) {
    dragging = false;
    call("pet.drag-end");
  } else if (down) call("pet.click");
  down = undefined;
});
window.addEventListener("blur", () => {
  if (dragging) call("pet.drag-end");
  dragging = false;
  down = undefined;
});
canvas.addEventListener("dblclick", () => call("chat.open"));
document.querySelector("#chat").onclick = () => call("chat.open");
document.querySelector("#settings").onclick = () => call("controller.open");
call("pet.ready");
const updateButton = document.querySelector('#update');
let updateState;
function renderUpdate(state) {
  updateState = state;
  const active = !!state.latestVersion && state.latestVersion !== state.currentVersion && !!state.assetName;
  updateButton.hidden = !active;
  updateButton.textContent = state.phase === 'downloading' ? `更新下载中 ${Math.floor(state.downloadedBytes / state.totalBytes * 100)}%` : state.phase === 'ready' ? '更新已下载 · 打开安装包' : `发现 ${state.latestVersion} · 点击更新`;
  updateButton.title = state.error || '从 GitHub 下载适用于 Windows 的正式版';
  updateButton.disabled = state.phase === 'downloading' || state.phase === 'checking';
}
api.on('familiar:update', renderUpdate);
void api.request('updates.state').then(renderUpdate).catch(() => {});
updateButton.onclick = () => api.request(updateState?.phase === 'ready' ? 'updates.open' : 'updates.download').then(renderUpdate).catch(() => {});
