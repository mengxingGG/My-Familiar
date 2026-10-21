import type { Surface, Settings } from "../../packages/contracts/index.ts";
import type { AndroidNative } from "./index.ts";

/** 只翻译已有桌面表现协议；动作、回复、气泡寿命仍由原插件拥有。 */
export function androidPetSurface(native: AndroidNative, interaction: (action: "drag-start" | "drag-end") => void) {
  let sequence = 0, disposed = false, queue = Promise.resolve();
  const send = (type: string, params: Record<string, unknown> = {}) => {
    const command = { ...params, type, sequence: ++sequence };
    queue = queue.then(async () => { if (!disposed) await native.call("pet.present", command); }).catch(() => {});
  };
  return {
    async create(kind: string) { if (!["pet", "speech", "composer"].includes(kind)) throw Error("Android 不支持该表面"); },
    send(kind: string, channel: string, payload: unknown) {
      if (kind === "pet" && channel === "familiar:action") send("action", { action: payload });
      // 角色帧来自 APK 资源，配置通道统一选择角色，不重复传输 data URL。
      if (kind === "speech" && channel === "familiar:speech") {
        const view = payload as { text: string; busy: boolean; kind: string; name: string; activity?: string };
        send("speech", { text: view.text.slice(0, 4000), busy: view.busy, kind: view.kind, name: view.name.slice(0, 40), activity: (view.activity ?? "").slice(0, 160) });
      }
    },
    show(kind: string, visible: boolean) {
      if (kind === "speech") send("speech-visible", { visible });
      if (kind === "composer") send("composer-visible", { visible });
    },
    configurePet(pet: Settings["pet"]) { send("configure", { characterId: pet.character, scale: pet.scale, visible: pet.visible }); },
    close(kind: string) { if (kind === "speech") send("speech-visible", { visible: false }); if (kind === "composer") send("composer-visible", { visible: false }); },
    resizeSpeech() { /* 原生按屏幕和文本测量，不使用桌面像素高度。 */ },
    resetPosition() { send("reset-position"); },
    interaction(kind: "drag-start" | "drag-end" | "hit") { if (kind !== "hit") interaction(kind); },
    openController() { send("open"); },
    async dispose() { await queue; disposed = true; await native.call("pet.present", { type: "clear", sequence: ++sequence }).catch(() => {}); },
  } satisfies Partial<Surface> & { dispose(): Promise<void> };
}
