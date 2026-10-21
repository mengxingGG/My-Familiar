import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { replaceFile } from "../storage-local/rename.ts";
export const audioKey = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class AudioCache {
  constructor(
    readonly directory: string,
    private now = () => Date.now(),
  ) {}
  private path(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("音频编号无效");
    return join(this.directory, id + ".json");
  }
  async read(id: string, days: number) {
    if (!days) return undefined;
    try {
      const path = this.path(id),
        info = await stat(path);
      if (info.size > 28 * 1024 * 1024) return undefined;
      const v = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof v.created !== "number" ||
        this.now() - v.created > days * 86400000 ||
        typeof v.data !== "string" ||
        !/^audio\//.test(v.mimeType)
      )
        return undefined;
      return {
        id,
        data: v.data as string,
        mimeType: v.mimeType as string,
        cached: true,
      };
    } catch {
      return undefined;
    }
  }
  async write(id: string, data: Uint8Array, mimeType: string, days: number) {
    if (!days) return;
    await mkdir(this.directory, { recursive: true });
    const target = this.path(id),
      temporary = target + "." + randomUUID() + ".tmp";
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          created: this.now(),
          mimeType,
          data: Buffer.from(data).toString("base64"),
        }),
      );
      await replaceFile(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async cleanup(days: number, maxMB: number) {
    await mkdir(this.directory, { recursive: true });
    const entries = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(this.directory, name),
        s = await stat(path).catch(() => undefined);
      if (s?.isFile()) entries.push({ path, size: s.size, time: s.mtimeMs });
    }
    entries.sort((a, b) => b.time - a.time);
    let bytes = 0,
      files = 0;
    for (const item of entries) {
      if (
        !days ||
        this.now() - item.time > days * 86400000 ||
        bytes + item.size > maxMB * 1024 * 1024
      )
        await unlink(item.path).catch(() => {});
      else {
        bytes += item.size;
        files++;
      }
    }
    return { files, bytes };
  }
}
