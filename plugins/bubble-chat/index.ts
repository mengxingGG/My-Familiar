import {
  definePlugin,
  type ChatState,
} from "../../packages/contracts/index.ts";
// 对话数据留在 conversation；本插件只管理气泡与临时输入条。
export const bubbleChat = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.bubble-chat",
    version: "0.1.0",
    provides: [],
    requires: ["commands", "platform.surface", "conversation", "settings"],
  },
  async start(ctx) {
    const commands = ctx.use("commands"),
      surface = ctx.use("platform.surface"),
      conversation = ctx.use("conversation"),
      settings = ctx.use("settings");
    let view = {
      text: "",
      busy: false,
      kind: "reply",
      name: settings.get().persona.name,
    };
    let dismiss: (() => void | Promise<void>) | undefined;
    let dismissedTurn: string | undefined;
    const display = (text: string, busy: boolean, kind = "reply") => {
      dismiss?.();
      view = { text, busy, kind, name: settings.get().persona.name };
      surface.send("speech", "familiar:speech", view);
      const lines = text
        .split("\n")
        .reduce(
          (sum, line) => sum + Math.max(1, Math.ceil(line.length / 22)),
          0,
        );
      surface.resizeSpeech(120 + Math.min(7, lines) * 24);
      if (settings.get().pet.visible && (!dismissedTurn || kind === "ambient"))
        surface.show("speech", !!text || busy);
      if (kind === "ambient")
        dismiss = ctx.timeout(() => surface.show("speech", false), 6000);
    };
    const sync = (state: ChatState) => {
      surface.send("composer", "familiar:chat", { busy: state.busy });
      const last = state.messages.at(-1);
      if (last?.id !== dismissedTurn) dismissedTurn = undefined;
      if (state.error) display(state.error, false, "error");
      else if (last?.role === "assistant")
        display(
          last.text ||
            (state.busy
              ? "正在回复…"
              : last.status === "cancelled"
                ? "已停止回复。"
                : ""),
          state.busy,
        );
      else if (!state.messages.length) {
        view.text = "";
        surface.show("speech", false);
      }
    };
    const open = async () => {
      const config = settings.get();
      if (!config.pet.visible) {
        config.pet.visible = true;
        await settings.apply(config);
      }
      surface.show("composer", true);
      surface.send("composer", "familiar:focus", {
        busy: conversation.state().busy,
      });
    };
    for (const [name, command] of Object.entries({
      "chat.open": open,
      "chat.close": () => surface.show("composer", false),
      "chat.state": () => ({ busy: conversation.state().busy }),
      "chat.send": async (text: unknown) => {
        await conversation.send(text as string);
        surface.show("composer", false);
      },
      "chat.cancel": () => conversation.cancel(),
      "chat.clear": async () => {
        await conversation.clear();
        surface.show("speech", false);
      },
      "speech.state": () => view,
      "speech.close": () => {
        dismissedTurn = conversation.state().messages.at(-1)?.id;
        surface.show("speech", false);
      },
      "speech.recall": () => {
        dismissedTurn = undefined;
        sync(conversation.state());
        if (view.text) surface.show("speech", true);
      },
    }))
      ctx.effect(commands.register(name, command));
    ctx.on<ChatState>("conversation.changed", sync);
    ctx.on<string>("pet.speech", (text) => {
      if (!conversation.state().busy) display(text, false, "ambient");
    });
    ctx.effect(() => {
      surface.close("composer");
      surface.close("speech");
    });
    await surface.create("speech", "ui/bubble-chat/speech.html");
    surface.show("speech", false);
    await surface.create("composer", "ui/bubble-chat/composer.html");
    surface.show("composer", false);
  },
});
