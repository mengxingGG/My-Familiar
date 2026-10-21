import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Windows 短暂占用时重试同一次原子替换；不先删除目标，永久错误仍交给调用者。 */
export async function replaceFile(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error: any) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt >= 4) throw error;
      await delay(50 * 2 ** attempt);
    }
  }
}
