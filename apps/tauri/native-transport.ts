import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  MobileTransport,
  MobileResponse,
} from "../../packages/mobile-bridge/index.ts";

/** 页面仅轮询权威快照；生成、存储和后台生命周期不依赖此计时器。 */
export function nativeTransport(): MobileTransport | undefined {
  if (!isTauri()) return;
  return {
    invoke: (payload) =>
      invoke<MobileResponse>("plugin:familiar-android|invoke", { payload }),
    listen(listener) {
      let disposed = false;
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const response = await invoke<MobileResponse>(
            "plugin:familiar-android|invoke",
            {
              payload: {
                protocolVersion: 1,
                id: crypto.randomUUID(),
                method: "snapshot.get",
              },
            },
          );
          if (!disposed && response.ok) listener(response.result);
        } catch {
          /* 短暂断连由请求桥展示；恢复后以全量快照对齐。 */
        }
        if (!disposed) timer = setTimeout(poll, document.hidden ? 3000 : 500);
      };
      void poll();
      return () => {
        disposed = true;
        clearTimeout(timer);
      };
    },
  };
}
