// 记忆条目的纯文本规则：不依赖 Node 或宿主 API，可直接用于其它平台的存储实现。
import {
  memoryLimits,
  type MemoryAction,
} from "../../packages/contracts/index.ts";
export const characters = (text: string) => Array.from(text).length;
export const clip = (text: string, n: number) =>
  Array.from(text).slice(0, n).join("");
export const redact = (text: string) =>
  text.replace(
    /\b(sk-[a-zA-Z0-9_-]{12,}|Bearer\s+\S+|(?:api[_ -]?key|token|password|密钥|密码)\s*[:=]\s*\S+)/gi,
    "[已隐藏凭据]",
  );
export const datePath = (time: number) => {
  const d = new Date(time),
    day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `daily/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.md`;
};
export const normalize = (text: string) =>
  text.replace(/\s+/g, " ").trim().toLowerCase();
export interface Entry {
  /** 起始行（含）。 */
  start: number;
  /** 结束行（不含）。 */
  end: number;
  text: string;
}
// 条目是顶格的 "- " 列表项；缩进行属于同一条目，其它行原样保留。
export function parseEntries(text: string) {
  const lines = text.split(/\r?\n/),
    entries: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^[-*] /.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && /^[ \t]/.test(lines[end])) end++;
    entries.push({
      start: i,
      end,
      text: [
        lines[i].slice(2),
        ...lines.slice(i + 1, end).map((l) => l.replace(/^(?: {2}|\t)/, "")),
      ]
        .join("\n")
        .trim(),
    });
    i = end - 1;
  }
  return { lines, entries };
}
export const formatEntry = (text: string) =>
  text
    .trim()
    .replace(/^[-*]\s+/, "")
    .split(/\r?\n/)
    .map((line, i) => (i ? "  " : "- ") + line.trimEnd())
    .join("\n");
export function findEntry(entries: Entry[], old: string) {
  const needle = normalize(old);
  if (!needle) throw new Error("需要用 old_text 提供要修改的原条目片段");
  const exact = entries.filter((e) => normalize(e.text) === needle);
  if (exact.length === 1) return exact[0];
  const matches = entries.filter((e) => normalize(e.text).includes(needle));
  if (matches.length === 1) return matches[0];
  if (!matches.length)
    throw new Error(`没有找到包含「${clip(old, 60)}」的条目`);
  throw new Error(
    `「${clip(old, 60)}」匹配到 ${matches.length} 条，请提供更完整的原文：` +
      matches
        .slice(0, 5)
        .map((e) => `「${clip(e.text, 40)}」`)
        .join("、"),
  );
}
export function applyChange(
  text: string,
  action: MemoryAction,
  value = "",
  old = "",
) {
  const { lines, entries } = parseEntries(text);
  if (action === "add") {
    const body = text.replace(/\s+$/, ""),
      last = entries.at(-1),
      lastLine = body.split(/\r?\n/).length - 1;
    // 紧接已有条目时续写列表，跟在标题或说明之后时空一行。
    const separator = !body
      ? ""
      : last && last.start <= lastLine && lastLine < last.end
        ? "\n"
        : "\n\n";
    return body + separator + formatEntry(value) + "\n";
  }
  const entry = findEntry(entries, old);
  lines.splice(
    entry.start,
    entry.end - entry.start,
    ...(action === "replace" ? formatEntry(value).split("\n") : []),
  );
  return lines.join("\n");
}
const whenLine = /^>\s*何时读[：:]\s*(.*)$/;
export function noteHeader(text: string) {
  const lines = text.split(/\r?\n/);
  return {
    title: lines
      .find((l) => /^#\s+/.test(l))
      ?.replace(/^#\s+/, "")
      .trim(),
    when: lines.map((l) => whenLine.exec(l)?.[1]?.trim()).find(Boolean),
  };
}
export function setWhen(text: string, when: string) {
  const lines = text.split(/\r?\n/),
    line = `> 何时读：${when.trim().replace(/\s+/g, " ")}`,
    at = lines.findIndex((l) => whenLine.test(l));
  if (at >= 0) lines[at] = line;
  else lines.splice(lines.findIndex((l) => /^#\s+/.test(l)) + 1, 0, line);
  return lines.join("\n");
}
export function topicName(topic: string) {
  const name =
    typeof topic === "string"
      ? topic
          .trim()
          .replace(/[^\p{L}\p{N}_-]+/gu, "-")
          .replace(/^-+|-+$/g, "")
      : "";
  if (!name || characters(name) > 40)
    throw new Error("主题名需要 1—40 个字符");
  return name;
}
export const notePath = (path: string) =>
  /^(lessons|topics)\/[^/]+\.md$/.test(path) && !/core-overflow/.test(path);
/** 由各文件头部的“何时读”拼出索引；超出上限时注明未列出的数量，不静默丢弃。 */
export function buildIndex(
  files: { path: string; text: string }[],
  limit: number = memoryLimits.index,
) {
  const lines = [
    "- daily/年/月/日期.md：一起经历的重要事，按日期或关键词用 memory_search 查找",
  ];
  const fresh: string[] = [],
    legacy: string[] = [];
  const sorted = files
    .filter((f) => notePath(f.path))
    .map((f) => ({ ...f, header: noteHeader(f.text) }))
    .sort(
      (a, b) =>
        Number(!a.header.when) - Number(!b.header.when) ||
        Number(a.path.startsWith("lessons/")) -
          Number(b.path.startsWith("lessons/")) ||
        (a.header.when
          ? a.path.localeCompare(b.path)
          : b.path.localeCompare(a.path)),
    );
  for (const f of sorted)
    if (f.header.when)
      fresh.push(
        `- ${f.path}：${clip(f.header.when, 60)}（${parseEntries(f.text).entries.length} 条）`,
      );
    else
      legacy.push(
        clip(f.header.title || f.path.split("/").pop()!.slice(0, -3), 24).trim(),
      );
  const reserve = 30;
  let used = characters(lines[0]),
    omitted = 0;
  const fits = (line: string) =>
    used + 1 + characters(line) + reserve <= limit;
  for (const line of fresh)
    if (fits(line)) {
      lines.push(line);
      used += 1 + characters(line);
    } else omitted++;
  if (legacy.length) {
    let line = "- 旧教训标题（用 memory_search 按标题查找）：",
      shown = 0;
    for (const title of legacy) {
      const next = line + (shown ? "；" : "") + title;
      if (!fits(next)) break;
      line = next;
      shown++;
    }
    if (shown) {
      lines.push(line);
      used += 1 + characters(line);
    }
    omitted += legacy.length - shown;
  }
  if (omitted) lines.push(`- 另有 ${omitted} 个文件未列出，用 memory_search 查找`);
  const text = lines.join("\n");
  return { text, omitted, characters: characters(text) };
}
