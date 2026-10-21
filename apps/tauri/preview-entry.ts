import { mountApp } from "./ui/app.ts";
import { createPreviewBridge } from "./preview/fixture.ts";

const bridge = createPreviewBridge({
  nativeControls: new URLSearchParams(location.search).has("native"),
});
const unmount = mountApp(bridge);
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  unmount?.();
  bridge.dispose();
});
