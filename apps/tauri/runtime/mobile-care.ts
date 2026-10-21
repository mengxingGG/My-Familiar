import { createHash } from "node:crypto";
import type { Kernel } from "../../../packages/kernel/index.ts";
import type {
  MobileCareState,
  MobileCareSettings,
} from "../../../packages/mobile-contracts/index.ts";
import type { DeviceLocation } from "../../../packages/contracts/index.ts";
import type { AndroidNative } from "../../../plugins/platform-android/index.ts";
import { validateCare } from "../../../plugins/companion-care/schedule.ts";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** 关怀、日程和历史仍由共享插件持有；页面只管理草稿和可取消请求。 */
export function mobileCare(kernel: Kernel, native: AndroidNative) {
  const care = kernel.resolve("companion.care"),
    cache = kernel.resolve("android.location");
  let saving = Promise.resolve<unknown>(undefined);
  const state = async (): Promise<MobileCareState> => {
    const s = care.get(),
      locationStatus = await native.call<{
        permission: boolean;
        enabled: boolean;
      }>("location.status");
    if (
      !locationStatus?.permission ||
      !locationStatus.enabled ||
      !s.settings.location
    )
      cache.clear();
    const location = cache.peek();
    return {
      settings: s.settings,
      revision: digest(s.settings),
      busy: s.busy,
      ...(s.lastMessage ? { lastMessage: s.lastMessage.slice(0, 4000) } : {}),
      ...(s.lastError
        ? {
            lastError:
              s.lastError === '关怀已取消' ? '关怀已取消。' : "关怀或附近资料暂不可用。请检查模型、位置和高德连接；没有资料时只作普通问候。",
          }
        : {}),
      ...(location
        ? {
            location: {
              accuracy: location.accuracy,
              time: location.time,
              mock: !!location.mock,
            },
          }
        : {}),
      locationPermission: !!locationStatus?.permission,
      locationEnabled: !!locationStatus?.enabled,
    };
  };
  const check = (p: Record<string, unknown>) => {
    if (typeof p.revision !== "string" || !/^[a-f0-9]{64}$/.test(p.revision))
      throw Error("INVALID_INPUT");
    if (p.revision !== digest(care.get().settings)) throw Error("CONFLICT");
  };
  return async (method: string, p: Record<string, unknown> = {}) => {
    if (method === "care.get") return state();
    if (method === "care.save") {
      let next: MobileCareSettings;
      try {
        next = validateCare(p.settings as MobileCareSettings);
      } catch {
        throw Error("INVALID_INPUT");
      }
      const task = saving.then(async () => {
        check(p);
        await care.set(next);
        if (!next.location) cache.clear();
        return state();
      });
      saving = task.catch(() => {});
      return task;
    }
    if (method === "care.preview") {
      if (care.get().busy || kernel.resolve("conversation").state().busy || kernel.resolve('voice.session').state().active)
        throw Error("BUSY");
      if (!kernel.resolve("settings").get().provider.model)
        throw Error("INVALID_INPUT");
      void care.preview().catch(() => {});
      return state();
    }
    if (method === "care.stop") {
      care.stop();
      return state();
    }
    if (method === "care.location.check") {
      check(p);
      if (!care.get().settings.location) throw Error("UNAVAILABLE");
      return;
    }
    if (method === "care.location.import") {
      check(p);
      if (!care.get().settings.location) throw Error("UNAVAILABLE");
      cache.accept(p.value as DeviceLocation);
      await care.locate();
      return state();
    }
    throw Error("UNAVAILABLE");
  };
}
