import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, join } from "node:path";
import { revision } from "../home-files/store.ts";

// 工作目录是默认落点；用户可明确指定绝对路径，不把它当作文件系统沙箱。
export class WorkspaceFiles {
  constructor(
    readonly root: string,
    readonly home: string,
  ) {}
  async init() {
    await mkdir(this.root, { recursive: true });
  }
  async path(input: string = "."): Promise<string> {
    if (
      typeof input !== "string" ||
      !input.trim() ||
      input.includes("\0") ||
      input.length > 2048
    )
      throw new Error("文件路径无效");
    const target = resolve(this.root, input);
    try {
      return await realpath(target);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      const parent = dirname(target);
      if (parent === target) throw e;
      return join(await this.path(parent), relative(parent, target));
    }
  }
  async internal(path: string) {
    const r = relative(await realpath(this.home), await this.path(path));
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  }
  async read(path: string) {
    const p = await this.path(path);
    if ((await stat(p)).size > 1024 * 1024)
      throw new Error("文件超过 1 MB，请用 Shell 分段读取");
    return readFile(p, "utf8");
  }
  async write(path: string, text: string, expected?: string) {
    const p = await this.path(path);
    if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024)
      throw new Error("文本过大");
    if (
      expected !== undefined &&
      revision(
        await this.read(p).catch((e) => {
          if (e.code === "ENOENT") return "";
          throw e;
        }),
      ) !== expected
    )
      throw new Error("文件已变化，请重新读取");
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, "utf8");
  }
  async list(path = ".") {
    const base = await this.path(path),
      result: string[] = [];
    const walk = async (dir: string, depth: number) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (result.length >= 1000) return;
        const p = join(dir, entry.name);
        if (entry.isFile()) result.push(p);
        else if (
          entry.isDirectory() &&
          depth < 5 &&
          !["node_modules", ".git"].includes(entry.name)
        )
          await walk(p, depth + 1);
      }
    };
    await walk(base, 0);
    return result;
  }
}
