import { mountApproval } from "./ui/app.ts";
import type { MobileApprovalBridge, MobileApprovalSnapshot } from "../../packages/mobile-contracts/index.ts";

declare global {
  interface Window {
    FamiliarApproval: { snapshot(): string; respond(request: string): void; close(): void };
    familiarApprovalUpdate?: (snapshot: MobileApprovalSnapshot) => void;
    familiarApprovalResult?: (id: string, ok: boolean) => void;
  }
}
const listeners = new Set<(snapshot: MobileApprovalSnapshot) => void>();
const requests = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let sequence = 0;
window.familiarApprovalUpdate = (snapshot) => {
  for (const listener of listeners) listener(snapshot);
};
window.familiarApprovalResult = (id, ok) => {
  const item = requests.get(id);
  if (!item) return;
  requests.delete(id); clearTimeout(item.timer);
  ok ? item.resolve() : item.reject(Error("操作未完成，请确认任务仍在等待。"));
};
const bridge: MobileApprovalBridge = {
  subscribe(listener) {
    listeners.add(listener);
    listener(JSON.parse(window.FamiliarApproval.snapshot()));
    return () => { listeners.delete(listener); };
  },
  respond(id, action, choice = "once") {
    return new Promise<void>((resolve, reject) => {
      const requestId = String(++sequence);
      const timer = setTimeout(() => {
        requests.delete(requestId);
        reject(Error("暂时无法确认结果，请查看最新任务状态。"));
      }, 30000);
      requests.set(requestId, { resolve, reject, timer });
      window.FamiliarApproval.respond(JSON.stringify({ requestId, id, action, choice }));
    });
  },
  close() { window.FamiliarApproval.close(); },
};
const unmount = mountApproval(bridge);
window.addEventListener("pagehide", () => {
  unmount();
  for (const item of requests.values()) { clearTimeout(item.timer); item.reject(Error("页面已关闭")); }
  requests.clear();
});
