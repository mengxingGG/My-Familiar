import {
  definePlugin,
  type DeviceLocation,
} from "../../packages/contracts/index.ts";
import { careDefaults, validateCare, careSlot, localDay } from "./schedule.ts";
export const companionCare = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.companion-care",
    version: "0.3.0",
    provides: ["companion.care"],
    requires: [
      "storage.local",
      "settings",
      "llm.chat",
      "memory.files",
      "conversation",
      "conversation.history",
      "companion.presentation",
      "platform.location",
      "companion.places",
    ],
  },
  async start(ctx) {
    const store = ctx.use("storage.local"),
      settings = ctx.use("settings"),
      chat = ctx.use("conversation"),
      presentation = ctx.use("companion.presentation");
    let config = validateCare(await store.read("care-settings", careDefaults));
    let diary = await store.read("care-schedule", {
      day: "",
      used: [] as string[],
      last: 0,
    });
    let busy = false,
      lastError: string | undefined,
      lastMessage: string | undefined,
      location: DeviceLocation | undefined,
      controller: AbortController | undefined;
    const started = Date.now();
    let lastUser = 0;
    ctx.on("conversation.changed", () => {
      if (chat.state().busy) {
        lastUser = Date.now();
        controller?.abort();
      }
    });
    ctx.on("conversation.session", () => controller?.abort());
    const locate = async (prompt: boolean, signal: AbortSignal) => {
      if (!config.location) throw new Error("请先开启设备位置授权");
      const value = await ctx.use("platform.location").locate(prompt, signal);
      if (!config.location) throw new Error("位置授权已撤销");
      location = value;
      return value;
    };
    const speak = async (slot: string, manual = false) => {
      if (busy || chat.state().busy) throw new Error("正在对话，请稍后再试");
      busy = true;
      lastError = undefined;
      controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        ctx.abort.signal,
        AbortSignal.timeout(90000),
      ]);
      const current = settings.get();
      try {
        let nearby = "";
        if (config.location) {
          try {
            const position = await locate(false, signal);
            if (config.nearby && ["noon", "evening", "preview"].includes(slot))
              nearby = await ctx
                .use("companion.places")
                .nearby(position, signal);
          } catch (e) {
            signal.throwIfAborted();
            lastError = e instanceof Error ? e.message : "位置或高德暂不可用";
          }
        }
        const instruction: Record<string, string> = {
          greeting: "刚启动桌面陪伴，打一个自然的招呼。",
          work: "启动一会儿了，关心用户这会儿在忙什么，是否需要一起做点什么；不要假设用户正在工作，别连续追问。",
          morning:
            "早上自然问候，结合近况关心今天的心情或安排，不重复刚问过的问题。",
          noon: "午间根据近况智能关心用餐或休息；如果已说吃过就换个合适的话题，不催促。",
          evening:
            "晚上根据近况关心晚饭、休息或今天的感受，不重复刚问过的问题。",
          preview: "给用户一句符合此刻时间的温暖问候。",
        };
        const custom = slot.startsWith("custom:")
          ? config.custom.find((r) => r.id === slot.slice(7) && r.enabled)
          : undefined;
        if (slot.startsWith("custom:") && !custom) return "";
        const recent = chat
          .state()
          .messages.slice(-4)
          .map((m) => `${m.role}: ${m.text.slice(0, 600)}`)
          .join("\n");
        const messages = [
          {
            role: "system",
            content: `你的名字是${current.persona.name}。${current.persona.instruction}\n用自然的中文说一两句话，不超过100字。不要展示思考，不要说自己看到了用户屏幕或活动。不要猜测城市、天气、餐馆、价格或用户是否已经吃饭。没有工具就不声称执行了操作。\n${await ctx.use("memory.files").context()}`,
          },
          {
            role: "user",
            content: `本机时间：${new Date().toLocaleString("zh-CN")}。${custom ? "按用户自定义内容给出提醒（不执行任何操作）：" + custom.prompt : instruction[slot]}\n最近交流供你避免重复：${recent || "暂无"}\n${nearby ? "附近餐馆信息由应用单独附上，你只写温暖的开场。" : "没有可用的周边资料，只做普通关怀。"}`,
          },
        ];
        let text = "";
        for await (const delta of ctx
          .use("llm.chat")
          .stream({
            settings: {
              ...current.provider,
              timeoutSeconds: Math.min(60, current.provider.timeoutSeconds),
            },
            messages,
            signal,
          })) {
          text += delta;
          if (text.length > 1000) break;
        }
        signal.throwIfAborted();
        if (!text.trim()) throw new Error("模型没有返回问候");
        if (
          !manual &&
          (!config.enabled ||
            settings.get().pet.quiet ||
            !settings.get().pet.visible ||
            presentation.inController() ||
            chat.state().busy)
        )
          return "";
        lastMessage =
          text.trim().slice(0, 350) + (nearby ? "\n\n" + nearby : "");
        await ctx.use("conversation.history").note(lastMessage);
        return lastMessage;
      } catch (e) {
        lastError = controller.signal.aborted
          ? "关怀已取消"
          : e instanceof Error
            ? e.message
            : "问候生成失败";
        if (manual) throw new Error(lastError);
        return "";
      } finally {
        busy = false;
        controller = undefined;
      }
    };
    let saving = Promise.resolve();
    ctx.provide("companion.care", {
      get: () =>
        structuredClone({
          settings: config,
          busy,
          lastError,
          lastMessage,
          location,
        }),
      set(value) {
        const next = validateCare(value);
        const operation = saving.then(async () => {
          await store.write("care-settings", next);
          config = next;
          controller?.abort();
          if (!next.location) location = undefined;
          return structuredClone(config);
        });
        saving = operation.then(
          () => {},
          () => {},
        );
        return operation;
      },
      locate: () =>
        locate(
          true,
          AbortSignal.any([ctx.abort.signal, AbortSignal.timeout(60000)]),
        ),
      preview: () => speak("preview", true),
    });
    ctx.interval(async () => {
      if (
        busy ||
        chat.state().busy ||
        presentation.inController() ||
        settings.get().pet.quiet ||
        !settings.get().pet.visible ||
        !settings.get().provider.model ||
        Date.now() - lastUser < 5 * 60000
      )
        return;
      const now = new Date(),
        day = localDay(now);
      if (diary.day !== day) diary = { day, used: [], last: 0 };
      const slot = careSlot(config, now, Date.now() - started, diary.used);
      if (
        !slot ||
        (!slot.startsWith("custom:") &&
          diary.used.filter((v) => !v.startsWith("custom:")).length >= 5) ||
        Date.now() - diary.last <
          (slot.startsWith("custom:") ? 1 : slot === "work" ? 15 : 60) * 60000
      )
        return;
      // 请求前记下时间槽，失败或重启都不会循环消耗模型费用。
      diary = { ...diary, used: [...diary.used, slot], last: Date.now() };
      await store.write("care-schedule", diary);
      await speak(slot);
    }, 15000);
    ctx.effect(async () => {
      controller?.abort();
      await saving;
    });
  },
});
