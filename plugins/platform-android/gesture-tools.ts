import { randomUUID } from "node:crypto";
import type { ToolEntry } from "../../packages/contracts/index.ts";
import type { AndroidNative } from "./index.ts";

/** 手势仍经共享审批；坐标相对刚观察的节点，原生执行前重新校验。 */
export function androidGestureTool(native: AndroidNative): ToolEntry {
  const point = { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } }, required: ["x", "y"], additionalProperties: false };
  return {
    name: "android_gesture",
    description: "批准后在 android_screen 刚观察的节点内点击(tap)、长按(longPress)或滑动(swipe)，用于自绘控件。start/end 是节点内 0–1 坐标，引用120秒有效。结果只证明触摸状态，必须重新观察，失败不可盲目重试。",
    category: "outsideWrite",
    parameters: {
      type: "object", properties: {
        snapshotId: { type: "string", minLength: 1, maxLength: 80 }, nodeId: { type: "string", pattern: "^[0-9]{1,3}$" },
        gesture: { enum: ["tap", "longPress", "swipe"] }, start: point, end: point,
        durationMs: { type: "integer", minimum: 100, maximum: 1500 },
      }, required: ["snapshotId", "nodeId", "gesture", "start"], additionalProperties: false,
      allOf: [{ if: { properties: { gesture: { const: "swipe" } } }, then: { required: ["end"] }, else: { not: { anyOf: [{ required: ["end"] }, { required: ["durationMs"] }] } } }],
    },
    async execute(args, { signal }) {
      signal.throwIfAborted();
      const operationId = randomUUID();
      const cancel = () => { void native.call("accessibility.gesture.cancel", { operationId }).catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await native.call("accessibility.gesture", { ...args, operationId });
        signal.throwIfAborted();
        return result;
      } finally { signal.removeEventListener("abort", cancel); }
    },
  };
}
