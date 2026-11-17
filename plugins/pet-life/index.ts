import { definePlugin } from "../../packages/contracts/index.ts";
import {
  lifeCommands,
  type PetLifeService,
} from "../../packages/contracts/life.ts";
import {
  advanceLife,
  applyLifeCommand,
  awardChat,
  createLifeStore,
  lifeSnapshot,
  validateLifeStore,
  type LifeStore,
} from "./state.ts";

export interface PetLifeOptions {
  now?: () => number;
  id?: () => string;
  timezone?: string;
  isOnline?: () => boolean | Promise<boolean>;
  intervalMs?: number;
}
/** 一个事务文件保存全部关联状态，落盘成功前不公布余额、库存或奖励变化。 */
export function createPetLife(options: PetLifeOptions = {}) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.pet-life",
      version: "2.0.0",
      provides: ["pet.life"],
      requires: ["storage.local", "commands"],
    },
    async start(ctx) {
      const storage = ctx.use("storage.local"),
        now = options.now ?? Date.now,
        id = options.id ?? (() => globalThis.crypto.randomUUID());
      let state: LifeStore | undefined, failure: Error | undefined;
      let queue = Promise.resolve<unknown>(undefined);
      try {
        const saved = await storage.read<unknown>("pet-life", null);
        if (saved === null) {
          state = createLifeStore(now(), id, options.timezone);
          await storage.write("pet-life", state);
        } else {
          validateLifeStore(saved);
          state = saved;
        }
        const restored = structuredClone(state);
        advanceLife(restored, now(), false, id);
        restored.revision++;
        validateLifeStore(restored);
        await storage.write("pet-life", restored);
        state = restored;
      } catch (error) {
        failure = new Error(
          "养成数据暂时不可用，原存档已保留；聊天和工作仍可使用",
        );
        ctx.report(error);
      }
      const current = () => {
        if (failure || !state) throw failure ?? new Error("养成尚未就绪");
        return state;
      };
      const transact = (
        operation: (draft: LifeStore, at: number, online: boolean) => void,
        onlineOverride?: boolean,
        atOverride?: number,
      ) => {
        const task = queue.then(async () => {
          ctx.assertActive();
          const draft = structuredClone(current()),
            at = atOverride ?? now();
          let online = onlineOverride ?? false;
          if (onlineOverride === undefined)
            try {
              online = (await options.isOnline?.()) ?? true;
            } catch {
              online = false;
            }
          advanceLife(draft, at, online, id);
          operation(draft, Math.max(at, draft.lastAt), online);
          draft.revision++;
          validateLifeStore(draft);
          await storage.write("pet-life", draft);
          state = draft;
          if (ctx.active) ctx.emit("life.changed", lifeSnapshot(draft));
          return lifeSnapshot(draft);
        });
        queue = task.catch(() => {});
        return task;
      };
      const service: PetLifeService = {
        snapshot: () =>
          lifeSnapshot(current(), Math.max(now(), current().lastAt)),
        act: (command) =>
          transact((draft, at) => {
            applyLifeCommand(draft, command, at, id);
          }),
        advance: async (at, online) => {
          if (failure) return;
          await transact(() => {}, online, at);
        },
      };
      ctx.provide("pet.life", service);
      ctx.effect(
        ctx.use("commands").register(lifeCommands[0], async () => {
          await service.advance();
          return service.snapshot();
        }),
      );
      ctx.effect(
        ctx
          .use("commands")
          .register(lifeCommands[1], (value) => service.act(value)),
      );
      ctx.on<{ id: string; text: string; at: number }>(
        "conversation.completed",
        (event) => {
          if (failure) return;
          return transact((draft, at) => {
            awardChat(draft, { ...event, at }, id);
          }).then(() => {});
        },
      );
      ctx.interval(() => service.advance(), options.intervalMs ?? 30_000);
      ctx.effect(() => queue.then(() => {}));
      if (state && !failure) ctx.emit("life.changed", lifeSnapshot(state));
    },
  });
}
