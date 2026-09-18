import { definePlugin } from "../../packages/contracts/index.ts";
export const experienceCommands = [
  "history.list",
  "history.read",
  "history.new",
  "history.select",
  "history.rename",
  "history.remove",
  "history.state",
  "history.send",
  "history.cancel",
  "history.presentation",
  "care.get",
  "care.set",
  "care.preview",
  "care.location",
  "location.settings",
];
export const experienceControls = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.experience-controls",
    version: "0.3.0",
    provides: [],
    requires: [
      "commands",
      "conversation",
      "conversation.history",
      "companion.presentation",
      "companion.care",
      "platform.location",
    ],
  },
  start(ctx) {
    const history = ctx.use("conversation.history"),
      chat = ctx.use("conversation"),
      presentation = ctx.use("companion.presentation"),
      care = ctx.use("companion.care");
    const routes = {
      "history.list": (p: any) => history.list(p?.query),
      "history.read": (p: any) => history.read(p.id, p.offset),
      "history.new": () => history.create(),
      "history.select": (p: any) => history.select(p.id),
      "history.rename": (p: any) => history.rename(p.id, p.title),
      "history.remove": (p: any) => history.remove(p.id),
      "history.state": () => ({ ...chat.state(), current: history.current() }),
      "history.send": (p: any) => {
        if (p.id !== history.current()) throw new Error("请先点击继续此会话");
        presentation.controller(true);
        return chat.send(p.text);
      },
      "history.cancel": () => chat.cancel(),
      "history.presentation": (active: unknown) => {
        if (typeof active !== "boolean") throw new Error("状态无效");
        presentation.controller(active);
      },
      "care.get": () => care.get(),
      "care.set": (p: any) => care.set(p),
      "care.preview": () => care.preview(),
      "care.location": () => care.locate(),
      "location.settings": () => ctx.use("platform.location").openSettings(),
    };
    for (const [name, run] of Object.entries(routes))
      ctx.effect(ctx.use("commands").register(name, run));
  },
});
