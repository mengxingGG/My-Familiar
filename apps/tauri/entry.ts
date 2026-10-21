import { mountApp } from "./ui/app.ts";
import { nativeTransport } from "./native-transport.ts";
import {
  createMobileBridge,
  type MobileTransport,
} from "../../packages/mobile-bridge/index.ts";
import {
  MobileBridgeError,
  type MobileBridge,
} from "../../packages/mobile-contracts/index.ts";

declare global {
  interface Window {
    familiarMobileTransport?: MobileTransport;
  }
}

// 原生宿主必须显式注入传输；生产入口不会回退到演示数据。
const transport = window.familiarMobileTransport ?? nativeTransport();
const bridge = transport
  ? createMobileBridge(transport)
  : ({
      async request() {
        throw new MobileBridgeError(
          "UNAVAILABLE",
          "Android 核心尚未连接，请在完整应用中打开。",
        );
      },
      subscribe() {
        return () => {};
      },
    } satisfies MobileBridge);
const unmount = mountApp(bridge);
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  unmount?.();
  if ("dispose" in bridge) bridge.dispose();
});
