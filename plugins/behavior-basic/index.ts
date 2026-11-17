import {
  definePlugin,
  type PetAction,
  type ChatState,
  type LifeSnapshot,
} from "../../packages/contracts/index.ts";
export const behaviorBasic = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.behavior-basic",
    version: "0.1.0",
    provides: ["behavior.pet"],
    requires: ["renderer.pet", "settings", "pet.life"],
  },
  start(ctx) {
    const renderer = ctx.use("renderer.pet");
    let state: PetAction = "idle",
      busy = false,
      dragging = false,
      transient = false;
    let revert: (() => void) | undefined;
    let lifeTimer: (() => void) | undefined;
    let life: LifeSnapshot | undefined;
    const settle = () => {
      state = dragging ? "drag" : busy ? "think" : transient ? 'happy' : life?.presentation.action ?? 'idle';
      renderer.act(state);
    };
    const refreshLife = () => {
      lifeTimer?.();
      try {life = ctx.use('pet.life').snapshot();} catch {life = undefined;}
      settle();
      if (life && life.presentation.until > Date.now()) lifeTimer = ctx.timeout(refreshLife, life.presentation.until - Date.now() + 1);
    };
    const interact = async (
      action: "click" | "drag-start" | "drag-end" | "sleep",
    ) => {
      revert?.();
      transient = false;
      if (action === "drag-start") dragging = true;
      if (action === "drag-end") dragging = false;
      if (action === "sleep") {
        await ctx.use('pet.life').act({requestId: globalThis.crypto.randomUUID(), kind:'sleep', sleeping: !life?.needs.sleeping});
        refreshLife();
      }
      settle();
      if (action === "click" && !busy && !dragging) {
        transient = true;
        settle();
        if (!ctx.use("settings").get().pet.quiet) renderer.say("我在这里。");
        revert = ctx.timeout(() => {transient = false;settle();}, 1600);
      }
    };
    ctx.provide("behavior.pet", { state: () => state, interact });
    ctx.on<"click" | "drag-start" | "drag-end">("pet.interaction", interact);
    ctx.on<ChatState>("conversation.changed", (chat) => {
      busy = chat.busy;
      settle();
    });
    ctx.on('life.changed', refreshLife);
    refreshLife();
  },
});
