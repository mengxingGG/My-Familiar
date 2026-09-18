import type { PromptMessage } from "../../packages/contracts/index.ts";
// 只有接近上下文上限才移除最旧整轮，稳定保留其余前缀，不逐轮滑动固定消息数。
export async function fitContext<T extends PromptMessage>(
  system: PromptMessage,
  history: T[],
  budget: number,
  count: (
    messages: PromptMessage[],
  ) => Promise<{ tokens: number; exact: boolean }>,
) {
  const full = await count([system, ...history]);
  if (full.tokens <= budget) return { messages: history, ...full, dropped: 0 };
  const starts = history
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);
  if (starts.length < 2)
    throw new Error(
      "当前输入和人格已超过上下文预算，请缩短输入或提高已确认的上下文上限",
    );
  const last = starts.at(-1)!;
  let best = await count([system, ...history.slice(last)]);
  if (best.tokens > budget)
    throw new Error(
      "当前输入和人格已超过上下文预算，请缩短输入或提高已确认的上下文上限",
    );
  let low = 1,
    high = starts.length - 1,
    bestIndex = high;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2),
      value = await count([system, ...history.slice(starts[mid])]);
    if (value.tokens <= budget) {
      bestIndex = mid;
      best = value;
      high = mid - 1;
    } else low = mid + 1;
  }
  return {
    messages: history.slice(starts[bestIndex]),
    ...best,
    dropped: starts[bestIndex],
  };
}
