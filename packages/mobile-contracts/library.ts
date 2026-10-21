/** 管理页按需读取文档；正文不进入每半秒更新的主快照。 */
export interface MobileMemoryDocument {
  path: string;
  text: string;
  revision: string;
  characters: number;
  truncated: boolean;
  limit?: number;
  redacted?: boolean;
}
export interface MobileMemoryList {
  files: string[];
  core: { characters: number; limit: number };
  index: { characters: number; limit: number; omitted: number };
}
export interface MobileSkill {
  id: string;
  description: string;
  enabled: boolean;
  supported: boolean;
  valid: boolean;
}
export interface MobileLibraryCommands {
  "library.memory.list": { params: undefined; result: MobileMemoryList };
  "library.memory.read": { params: { path: string }; result: MobileMemoryDocument };
  "library.memory.write": { params: { path: string; text: string; revision: string; create?: boolean }; result: MobileMemoryDocument };
  "library.memory.search": { params: { query: string }; result: { path: string; excerpt: string }[] };
  "library.skills.list": { params: { offset?: number }; result: { items: MobileSkill[]; total: number; nextOffset: number | null } };
  "library.skills.read": { params: { id: string }; result: { id: string; text: string } };
  /** 读取通过系统选择器导入的完整文本，安装仍需另行确认；不使用截断预览。 */
  "library.skills.source": { params: { attachmentId: string }; result: { text: string } };
  "library.skills.install": { params: { content?: string; url?: string }; result: MobileSkill };
  "library.skills.toggle": { params: { id: string; enabled: boolean }; result: MobileSkill };
  "library.skills.remove": { params: { id: string }; result: void };
}
