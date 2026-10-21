import type { Kernel } from "../../../packages/kernel/index.ts";
import type { MobileMemoryDocument, MobileSkill } from "../../../packages/mobile-contracts/index.ts";
import type { SkillInfo } from "../../../packages/contracts/index.ts";
import { revision } from "../../../plugins/home-files/store.ts";
import { redact } from "../../../plugins/memory-files/entries.ts";

const input: (value: unknown) => asserts value = value => { if (!value) throw Error("INVALID_INPUT"); };
const documentPath = (value: unknown): value is string => typeof value === "string" && value.length <= 500 && value.endsWith(".md") && !/[\\\x00-\x1f:]/.test(value)
  && (value.toLowerCase() !== "core.md" || value === "CORE.md")
  && value.split("/").every(p => !!p && !p.startsWith(".") && !/[. ]$/.test(p));
const skillId = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const skillView = (s: SkillInfo): MobileSkill => ({ id: s.id, description: s.description.slice(0, 1024), enabled: s.enabled, supported: s.supported !== false, valid: !s.error });

/** 调用已有资料所有者；管理页不直接读 Android 路径，也不让文件内容进入轮询快照。 */
export function mobileLibrary(kernel: Kernel) {
  const memory = kernel.resolve("memory.files"), skills = kernel.resolve("skills.catalog");
  const read = async (path: string): Promise<MobileMemoryDocument> => {
    const file = await memory.read(path);
    let characters = 0; const preview: string[] = [];
    for (const char of file.text) { if (characters++ < 100000) preview.push(char); }
    return { path, text: preview.join(""), revision: file.revision, characters, truncated: characters > 100000, ...(path === "CORE.md" ? { limit: memory.status().core.limit } : {}) };
  };
  const findSkill = async (id: string) => { const s = (await skills.list()).find(s => s.id === id); if (!s) throw Error("NOT_FOUND"); return s; };
  return async (method: string, p: Record<string, unknown> = {}): Promise<unknown> => {
    try {
      input(p && typeof p === "object" && !Array.isArray(p));
      switch (method) {
        case "library.memory.list": {
          await memory.context();
          const status = memory.status();
          return { files: (await memory.list()).filter(documentPath), core: status.core, index: status.index };
        }
        case "library.memory.read": input(documentPath(p.path)); return await read(p.path);
        case "library.memory.search":
          input(typeof p.query === "string" && p.query.trim().length > 0 && p.query.length <= 200);
          return (await memory.search(p.query)).filter(r => documentPath(r.path));
        case "library.memory.write": {
          input(documentPath(p.path) && typeof p.text === "string" && typeof p.revision === "string" && /^[a-f0-9]{64}$/.test(p.revision));
          input(p.create === undefined || typeof p.create === "boolean");
          const path = p.path as string, text = p.text as string;
          if (Array.from(text).length > 100000) throw Error("LIMIT");
          if (p.create) {
            input(p.revision === revision(""));
            if ((await memory.list()).includes(path)) throw Error("CONFLICT");
          }
          await memory.write(path, text, p.revision as string);
          const saved = await read(path); return { ...saved, redacted: redact(text) !== text };
        }
        case "library.skills.list": {
          const offset = p.offset ?? 0; input(Number.isInteger(offset) && Number(offset) >= 0 && Number(offset) <= 5000);
          const list = (await skills.list()).filter(s => skillId(s.id)).sort((a, b) => a.id.localeCompare(b.id));
          const next = Number(offset) + 100;
          return { items: list.slice(Number(offset), next).map(skillView), total: list.length, nextOffset: next < list.length ? next : null };
        }
        case "library.skills.read": input(skillId(p.id)); await findSkill(p.id); return { id: p.id, text: await skills.read(p.id) };
        case "library.skills.source":
          input(typeof p.attachmentId === "string" && /^[a-f0-9-]{36}$/.test(p.attachmentId));
          return { text: await kernel.resolve("media.assets").text(p.attachmentId, 65536) };
        case "library.skills.install": {
          input((typeof p.content === "string") !== (typeof p.url === "string"));
          let source = "";
          if (typeof p.content === "string") { if (Buffer.byteLength(p.content) > 65536) throw Error("LIMIT"); input(p.content.trim().length > 0); }
          if (typeof p.url === "string") {
            input(p.url.length <= 2000); let url: URL;
            try { url = new URL(p.url); } catch { throw Error("INVALID_INPUT"); }
            input(url.protocol === "https:" && !url.username && !url.password && !url.hash);
            source = url.href;
          }
          return skillView(await skills.install(source, typeof p.content === "string" ? p.content : undefined));
        }
        case "library.skills.toggle":
          input(skillId(p.id) && typeof p.enabled === "boolean"); await findSkill(p.id);
          await skills.setEnabled(p.id, p.enabled); return skillView(await findSkill(p.id));
        case "library.skills.remove": input(skillId(p.id)); await findSkill(p.id); await skills.remove(p.id); return;
        default: throw Error("UNAVAILABLE");
      }
    } catch (error) {
      const e = error as Error & { code?: string };
      if (e.code === "ENOENT") throw Error("NOT_FOUND");
      if (/文件已被修改|文件已变化|同名 Skill 已存在/.test(e.message)) throw Error("CONFLICT");
      if (/核心规则上限|文本过长|超过 64 KB|Skill 超过|Skill 过大/.test(e.message)) throw Error("LIMIT");
      if (/SKILL.md 需要|Skill 名称或描述|YAML/.test(e.message) || e.name === "YAMLParseError") throw Error("INVALID_DOCUMENT");
      throw error;
    }
  };
}
