import type { IntegrationJob } from "../../packages/contracts/index.ts";
import { redact } from "./index.ts";
export function jobs(parent: AbortSignal) {
  let state: IntegrationJob | undefined,
    active: { abort: AbortController; task: Promise<void> } | undefined;
  const append = (text: string) => {
    if (!state) return;
    state.output = redact(state.output + text).slice(-8000);
    for (const raw of state.output.match(/https:\/\/[^\s<>"\\]+/g) ?? []) {
      try {
        const url = new URL(raw);
        if (
          ["github.com", "feishu.cn", "larkoffice.com", "larksuite.com"].some(
            (host) =>
              url.hostname === host || url.hostname.endsWith("." + host),
          )
        )
          state.url = url.href;
      } catch {}
    }
  };
  return {
    state: () => (state ? { ...state } : undefined),
    busy: () => !!active,
    start(
      kind: string,
      fn: (
        signal: AbortSignal,
        append: (text: string) => void,
      ) => Promise<void>,
    ) {
      if (active) throw new Error("请先完成或取消当前安装 / 登录操作");
      const abort = new AbortController();
      state = { kind, running: true, output: "" };
      const task = Promise.resolve()
        .then(() => fn(AbortSignal.any([parent, abort.signal]), append))
        .catch((e) => {
          if (state)
            state.error = redact(e instanceof Error ? e.message : "操作失败");
        })
        .finally(() => {
          if (state) {
            state.running = false;
            state.url = undefined;
          }
          active = undefined;
        });
      active = { abort, task };
    },
    async cancel() {
      active?.abort.abort();
      await active?.task;
    },
  };
}
