import { MobileBridgeError } from "../mobile-contracts/index.ts";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const validPath = (v: unknown) => text(v, 500) && v.endsWith(".md") && !/[\\\x00-\x1f:]/.test(v) && v.split("/").every(p => !!p && !p.startsWith("."));
const assert: (v: unknown) => asserts v = v => { if (!v) throw new MobileBridgeError("UNAVAILABLE", "资料返回格式不兼容，请重新打开。"); };
const skill = (v: unknown) => {
  assert(object(v) && text(v.id, 64) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.id) && text(v.description, 1024) && typeof v.enabled === "boolean" && typeof v.supported === "boolean" && typeof v.valid === "boolean");
  return { id: v.id, description: v.description, enabled: v.enabled, supported: v.supported, valid: v.valid };
};
/** 正文仅出现在按需响应；任何源路径、错误正文和宿主额外字段都不跨出桥。 */
export function projectLibraryResult(method: string, value: unknown, params: unknown): unknown {
  const p = object(params) ? params : {};
  switch (method) {
    case "library.memory.list": {
      assert(object(value) && Array.isArray(value.files) && value.files.length <= 5000 && value.files.every(validPath));
      const core = value.core, index = value.index;
      assert(object(core) && integer(core.characters) && integer(core.limit, 100000) && object(index) && integer(index.characters) && integer(index.limit) && integer(index.omitted));
      return { files: [...value.files], core: { characters: core.characters, limit: core.limit }, index: { characters: index.characters, limit: index.limit, omitted: index.omitted } };
    }
    case "library.memory.read":
    case "library.memory.write":
      assert(object(value) && validPath(value.path) && value.path === p.path && text(value.text, 200000) && text(value.revision, 64) && /^[a-f0-9]{64}$/.test(value.revision) && integer(value.characters) && typeof value.truncated === "boolean" && (value.limit === undefined || integer(value.limit)) && (value.redacted === undefined || typeof value.redacted === "boolean"));
      return { path: value.path, text: value.text, revision: value.revision, characters: value.characters, truncated: value.truncated, ...(value.limit === undefined ? {} : { limit: value.limit }), ...(value.redacted === undefined ? {} : { redacted: value.redacted }) };
    case "library.memory.search":
      assert(Array.isArray(value) && value.length <= 20 && value.every(v => object(v) && validPath(v.path) && text(v.excerpt, 800)));
      return value.map(v => ({ path: v.path, excerpt: v.excerpt }));
    case "library.skills.list":
      assert(object(value) && Array.isArray(value.items) && value.items.length <= 100 && integer(value.total, 5000) && (value.nextOffset === null || integer(value.nextOffset, 5000)));
      return { items: value.items.map(skill), total: value.total, nextOffset: value.nextOffset };
    case "library.skills.read":
      assert(object(value) && value.id === p.id && text(value.text, 65536)); return { id: value.id, text: value.text };
    case "library.skills.source":
      assert(object(value) && text(value.text, 65536)); return { text: value.text };
    case "library.skills.install": return skill(value);
    case "library.skills.toggle": { const result = skill(value); assert(result.id === p.id); return result; }
    case "library.skills.remove": return undefined;
    default: throw new MobileBridgeError("UNAVAILABLE", "资料操作尚未接入。");
  }
}
