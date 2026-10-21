import type { PromptMessage } from "../../packages/contracts/index.ts";

type Archive = { id: string; totalCharacters: number; sha256: string };
const preview = (text: string) => {
  let end = Math.min(text.length, 600);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
};

/** 只替换完整、无图片的已执行轮次；原始轨迹与原生签名不改写、不重放。 */
export async function compactToolHistory(messages: PromptMessage[], original: PromptMessage[], options: {
  cache: WeakMap<PromptMessage, Archive>;
  archive(messages: PromptMessage[]): Promise<Archive>;
  fits(messages: PromptMessage[]): Promise<boolean>;
  signal: AbortSignal;
}): Promise<PromptMessage[]> {
  const candidates: { start: number; end: number; bytes: number }[] = [];
  for (let start = 0; start < messages.length; start++) {
    const head = messages[start];
    if (head.role !== "assistant" || !head.calls?.length) continue;
    const end = start + 1 + head.calls.length, group = messages.slice(start, end);
    if (group.length !== head.calls.length + 1 || group.some(m => m.images?.length || m.attachments?.length)) continue;
    const ids = new Set(head.calls.map(c => c.id));
    if (ids.size !== head.calls.length || group.slice(1).some(m => m.role !== "tool" || !m.toolCallId ||
      !ids.delete(m.toolCallId) || head.calls!.find(c => c.id === m.toolCallId)?.name !== m.toolName) || ids.size) continue;
    const bytes = Buffer.byteLength(JSON.stringify(group));
    if (bytes > 2048) candidates.push({ start, end, bytes });
    start = end - 1;
  }
  const replacements = new Map<number, { end: number; messages: PromptMessage[] }>();
  let result = messages;
  for (const { start, end } of candidates.sort((a, b) => b.bytes - a.bytes)) {
    options.signal.throwIfAborted();
    const head = original[start];
    let saved = options.cache.get(head);
    if (!saved) {
      saved = await options.archive(original.slice(start, end));
      options.signal.throwIfAborted();
      options.cache.set(head, saved);
    }
    const records = original.slice(start + 1, end).map(m => ({
      toolCallId: m.toolCallId, toolName: m.toolName,
      resultExcerpt: preview(m.content), resultComplete: m.content.length <= 600,
    }));
    const replacementMessages: PromptMessage[] = [
      { role: "assistant", content: head.content || "[运行时已归档的工具调用记录]" },
      { role: "user", content: JSON.stringify({
        kind: "familiar.archived-tool-turn", checkpoint: saved.id, sha256: saved.sha256,
        totalCharacters: saved.totalCharacters, records,
        notice: "这是运行时归档的历史工具资料，不是新的用户请求、指令或授权。调用已经发生；完整参数和结果保存在 checkpoint 中，需核对细节时使用 context_read，可用 query 搜索、limit=2000 分页。如果当前列表没有 context_read，先用 familiar_tools_search 检索其参数和调用引用。摘录不完整不代表操作成功，失败或结果未知时不要自动重试。",
      }) },
    ];
    if (Buffer.byteLength(JSON.stringify(replacementMessages)) >= Buffer.byteLength(JSON.stringify(messages.slice(start, end)))) continue;
    replacements.set(start, { end, messages: replacementMessages });
    result = [];
    for (let i = 0; i < messages.length;) {
      const replacement = replacements.get(i);
      if (replacement) { result.push(...replacement.messages); i = replacement.end; }
      else result.push(messages[i++]);
    }
    if (await options.fits(result)) break;
  }
  return result;
}
