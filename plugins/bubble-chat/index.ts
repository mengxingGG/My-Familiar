import {
  definePlugin,
  type ChatState,
  type Settings,
  type Approval,
} from "../../packages/contracts/index.ts";
// 对话数据留在 conversation；本插件只管理气泡与临时输入条。
export const bubbleChat = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.bubble-chat",
    version: "0.1.0",
    provides: ["companion.presentation"],
    requires: ["commands", "platform.surface", "conversation", "settings"],
  },
  async start(ctx) {
    const commands = ctx.use("commands"),
      surface = ctx.use("platform.surface"),
      conversation = ctx.use("conversation"),
      settings = ctx.use("settings");
    let activity = "",
      approvals: Approval[] = [];
    let view: {
      text: string;
      busy: boolean;
      kind: string;
      name: string;
      activity?: string;
      approval?: Approval;
    } = {
      text: "",
      busy: false,
      kind: "reply",
      name: settings.get().persona.name,
    };
    let dismiss: (() => void | Promise<void>) | undefined;
    let dismissedTurn: string | undefined;
    let composing = false,
      controllerUntil = 0,
      hovering = false;
    const inController = () => Date.now() < controllerUntil;
    ctx.provide("companion.presentation", {
      inController,
      controller(active) {
        controllerUntil = active ? Date.now() + 6000 : 0;
        if (active) {
          surface.show("speech", false);
          surface.show("composer", false);
          composing = false;
        }
      },
    });
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const display = (text: string, busy: boolean, kind = "reply") => {
      dismiss?.();
      view = {
        text,
        busy,
        kind,
        name: settings.get().persona.name,
        activity: busy ? activity : "",
        approval: approvals[0],
      };
      surface.send("speech", "familiar:speech", view);
      const lines = text
        .split("\n")
        .reduce(
          (sum, line) => sum + Math.max(1, Math.ceil(line.length / 22)),
          0,
        );
      surface.resizeSpeech(
        approvals.length ? 285 : 120 + Math.min(7, lines) * 24,
      );
      if (
        !inController() &&
        !composing &&
        settings.get().pet.visible &&
        (!dismissedTurn || kind === "ambient")
      )
        surface.show("speech", !!text || busy || !!approvals.length);
      if (
        !busy &&
        !approvals.length &&
        !hovering &&
        settings.get().pet.bubbleSeconds > 0
      )
        dismiss = ctx.timeout(() => {
          dismissedTurn = conversation.state().messages.at(-1)?.id;
          surface.show("speech", false);
        }, settings.get().pet.bubbleSeconds * 1000);
    };
    const sync = (state: ChatState) => {
      surface.send("composer", "familiar:chat", { busy: state.busy });
      const last = state.messages.at(-1);
      if (last?.id !== dismissedTurn) dismissedTurn = undefined;
      if (inController()) {
        surface.show("speech", false);
        if (!state.busy) dismissedTurn = last?.id;
      }
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
      // 启动期间的唤出等待页面加载完成，避免被末尾的初始隐藏覆盖。
      await ready;
      const config = settings.get();
      if (!config.pet.visible) {
        config.pet.visible = true;
        await settings.apply(config);
      }
      controllerUntil = 0;
      composing = true;
      surface.show("speech", false);
      surface.show("composer", true);
      surface.send("composer", "familiar:focus", {
        busy: conversation.state().busy,
      });
    };
    const close = () => {
      composing = false;
      surface.show("composer", false);
      sync(conversation.state());
    };
    for (const [name, command] of Object.entries({
      "chat.open": open,
      "chat.close": close,
      "chat.state": () => ({ busy: conversation.state().busy }),
      "chat.send": async (text: unknown) => {
        await conversation.send(text as string);
        close();
      },
      "chat.cancel": () => conversation.cancel(),
      "chat.clear": async () => {
        await conversation.clear();
        surface.show("speech", false);
      },
      "speech.state": () => view,
      "speech.hover": (value: unknown) => {
        hovering = value === true;
        if (hovering) dismiss?.();
        else display(view.text, view.busy, view.kind);
      },
      "speech.close": () => {
        dismissedTurn = conversation.state().messages.at(-1)?.id;
        surface.show("speech", false);
      },
      "speech.recall": () => {
        composing = false;
        surface.show("composer", false);
        dismissedTurn = undefined;
        sync(conversation.state());
        if (view.text && settings.get().pet.visible)
          surface.show("speech", true);
      },
    }))
      ctx.effect(commands.register(name, command));
    ctx.on<ChatState>("conversation.changed", sync);
    ctx.on("conversation.session", () => {
      dismiss?.();
      dismissedTurn = undefined;
      view.text = "";
      surface.show("speech", false);
    });
    ctx.on<string>("agent.activity", (text) => {
      activity = text;
      sync(conversation.state());
    });
    ctx.on<Approval[]>("agent.approvals", (pending) => {
      approvals = pending;
      if (pending.length) dismissedTurn = undefined;
      sync(conversation.state());
    });
    ctx.on<Settings>("settings.changed", (config) => {
      if (!config.pet.visible) composing = false;
      if (view.text) display(view.text, view.busy, view.kind);
    });
    ctx.on<string>("pet.speech", (text) => {
      if (
        !conversation.state().busy &&
        !inController() &&
        !settings.get().pet.quiet
      )
        display(text, false, "ambient");
    });
    ctx.effect(() => {
      surface.close("composer");
      surface.close("speech");
    });
    await surface.create("speech", "ui/bubble-chat/speech.html");
    surface.show("speech", false);
    await surface.create("composer", "ui/bubble-chat/composer.html");
    surface.show("composer", false);
    resolveReady();
  },
});
