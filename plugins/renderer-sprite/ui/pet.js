const api = window.familiar,
  canvas = document.querySelector("#pet"),
  context = canvas.getContext("2d", { willReadFrequently: true });
let frames = {},
  action = "idle",
  current = [],
  index = 0,
  fps = 8,
  timer,
  hit = false,
  down,
  dragging = false,
  generation = 0;
const call = (method, params) => api.request(method, params).catch(() => {});
function draw() {
  context.clearRect(0, 0, 260, 300);
  const image = current[index++ % Math.max(1, current.length)];
  if (image) context.drawImage(image, 20, 72, 220, 205);
}
function play() {
  clearInterval(timer);
  current = frames[action] || frames.idle || [];
  index = 0;
  draw();
  if (current.length > 1 && !document.hidden)
    timer = setInterval(draw, 1000 / fps);
}
api.on("familiar:character", async (character) => {
  const version = ++generation,
    sprite = character.representations.sprite,
    loaded = {};
  for (const [name, sources] of Object.entries(sprite.frames)) {
    loaded[name] = await Promise.all(
      sources.map(
        (src) =>
          new Promise((resolve) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.src = src;
          }),
      ),
    );
  }
  if (version !== generation) return;
  frames = loaded;
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
  if (document.hidden) clearInterval(timer);
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
