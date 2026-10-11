// 记忆诊断记录：保存 memory.trace 事件，作为后续向量检索与判断模型的对比基准。
// 记录不是记忆，写入 storage.local 的数据目录，与宠物之家的 memory/ 分开。
import {
  definePlugin,
  type MemoryTrace,
} from "../../packages/contracts/index.ts";
const types = new Set(["write", "judge", "recall", "inject"]);
export const traceDays = 30;
export const traceLimit = 2000;
export const traceKey = (time: number) => {
  const d = new Date(time);
  return `memory-trace-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
type Day = { version: 1; entries: MemoryTrace[]; dropped: number };
export const memoryTrace = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.memory-trace",
    version: "0.1.0",
    provides: [],
    requires: ["storage.local"],
  },
  async start(ctx) {
    const storage = ctx.use("storage.local");
    let days = await storage.read<string[]>("memory-trace-index", []),
      current: { key: string; value: Day } | undefined,
      queue = Promise.resolve();
    async function append(event: MemoryTrace) {
      const key = traceKey(event.time);
      if (current?.key !== key) {
        current = {
          key,
          value: await storage.read<Day>(key, {
            version: 1,
            entries: [],
            dropped: 0,
          }),
        };
        if (!days.includes(key)) {
          days = [...days, key].sort();
          // 只保留最近的天数，过期文件写为空值。
          while (days.length > traceDays) await storage.write(days.shift()!, null);
          await storage.write("memory-trace-index", days);
        }
      }
      if (
        current.value.entries.length >= traceLimit ||
        JSON.stringify(event).length > 64 * 1024
      )
        current.value.dropped++;
      else current.value.entries.push(event);
      await storage.write(key, current.value);
    }
    ctx.on<MemoryTrace>("memory.trace", (event) => {
      if (
        !event ||
        event.v !== 1 ||
        !types.has(event.type) ||
        !Number.isFinite(event.time)
      ) {
        ctx.report(new Error("记忆记录格式无效"));
        return;
      }
      const copy = structuredClone(event);
      queue = queue.then(() => append(copy)).catch((e) => ctx.report(e));
    });
    ctx.effect(() => queue);
  },
});
