import {
  definePlugin,
  type PetAction,
  type ChatState,
} from "../../packages/contracts/index.ts";
export const behaviorBasic = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.behavior-basic",
    version: "0.1.0",
    provides: ["behavior.pet"],
    requires: ["renderer.pet", "settings"],
  },
  start(ctx) {
    const renderer = ctx.use("renderer.pet");
    let state: PetAction = "idle",
      busy = false,
      dragging = false,
      sleeping = false,
      lastTouch = Date.now();
    let revert: (() => void) | undefined;
    const settle = () => {
      state = dragging ? "drag" : busy ? "think" : sleeping ? "sleep" : "idle";
      renderer.act(state);
    };
    const interact = (
      action: "click" | "drag-start" | "drag-end" | "sleep",
    ) => {
      lastTouch = Date.now();
      revert?.();
      if (action === "drag-start") dragging = true;
      if (action === "drag-end") dragging = false;
      if (action === "sleep") sleeping = !sleeping;
      else sleeping = false;
      settle();
      if (action === "click" && !busy && !dragging) {
        state = "happy";
        renderer.act(state);
        if (!ctx.use("settings").get().pet.quiet) renderer.say("我在这里。");
        revert = ctx.timeout(settle, 1600);
      }
    };
    ctx.provide("behavior.pet", { state: () => state, interact });
    ctx.on<"click" | "drag-start" | "drag-end">("pet.interaction", interact);
    ctx.on<ChatState>("conversation.changed", (chat) => {
      busy = chat.busy;
      settle();
    });
    ctx.interval(() => {
      if (!busy && !dragging && Date.now() - lastTouch > 180000) {
        sleeping = true;
        settle();
      }
    }, 30000);
  },
});
