import { definePlugin } from "../../packages/contracts/index.ts";
export function controlCenter(launch: () => void) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.control-center",
      version: "0.1.0",
      provides: [],
      requires: ["commands", "transport.client", "platform.surface"],
    },
    async start(ctx) {
      const commands = ctx.use("commands"),
        client = ctx.use("transport.client"),
        surface = ctx.use("platform.surface");
      for (const name of [
        "runtime.status",
        "settings.apply",
        "secret.set",
        "provider.test",
        "pet.reset",
        "pet.show",
        "pet.sleep",
        "chat.open",
        "chat.clear",
        "runtime.stop",
        "autostart.set",
      ])
        ctx.effect(
          commands.register(name, (params) => client.call(name, params)),
        );
      ctx.effect(
        commands.register("runtime.start", () => {
          launch();
          return true;
        }),
      );
      ctx.effect(() => surface.close("controller"));
      await surface.create("controller", "ui/control-center/index.html");
    },
  });
}
