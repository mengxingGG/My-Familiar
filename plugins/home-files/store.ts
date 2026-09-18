import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  rename,
  lstat,
  readdir,
  copyFile,
  realpath,
} from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
export const revision = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export class FileStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new Error("目录不可为链接");
  }
  async path(name: string, create = false) {
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 500 ||
      isAbsolute(name) ||
      /[\x00-\x1f:]/.test(name)
    )
      throw new Error("需要目录内的相对路径");
    const parts = name.replaceAll("\\", "/").split("/");
    if (
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
      )
    )
      throw new Error("路径无效");
    await this.init();
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      try {
        const s = await lstat(current);
        if (s.isSymbolicLink() || (i < parts.length - 1 && !s.isDirectory()))
          throw new Error("不允许链接或非目录路径");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
        if (create && i < parts.length - 1) await mkdir(current);
      }
    }
    const parent = await realpath(dirname(current)).catch(() => this.root),
      rel = relative(await realpath(this.root), parent);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("路径越界");
    return current;
  }
  async read(name: string, max = 1024 * 1024) {
    const p = await this.path(name);
    const s = await lstat(p);
    if (!s.isFile() || s.size > max)
      throw new Error("文件不是可读取的小型文本");
    return readFile(p, "utf8");
  }
  async exists(name: string) {
    try {
      await lstat(await this.path(name));
      return true;
    } catch (e: any) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }
  async append(name: string, text: string) {
    const path = await this.path(name, true);
    await appendFile(path, text, { encoding: "utf8", mode: 0o600 });
  }
  async write(name: string, text: string, expected?: string, backup = true) {
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error("文件内容过大");
    const path = await this.path(name, true);
    let old: string | undefined;
    try {
      old = await this.read(name, 2 * 1024 * 1024);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (expected !== undefined && revision(old ?? "") !== expected)
      throw new Error("文件已被修改，请重新读取再保存");
    if (old === text) return;
    if (backup && old !== undefined) {
      const history = await this.path(
        `.history/${Date.now()}-${randomUUID()}/${name}`,
        true,
      );
      await copyFile(path, history);
    }
    const temp = path + "." + randomUUID() + ".tmp";
    await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
  }
  async list(prefix = "") {
    const result: string[] = [];
    await this.init();
    const visit = async (dir: string, rel: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const name = rel ? rel + "/" + entry.name : entry.name;
        if (result.length >= 5000) return;
        if (entry.isDirectory()) await visit(join(dir, entry.name), name);
        else if (entry.isFile()) result.push(name);
      }
    };
    await visit(prefix ? await this.path(prefix) : this.root, prefix);
    return result.sort();
  }
}
