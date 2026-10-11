import { spokenText } from "../voice-api/config.ts";
// 只提交稳定前缀。代码块和未闭合 Markdown 链接等到完整后处理，不朗读推理通道。
export class SpeechTextBuffer {
  private offset = 0;
  private code = false;
  take(text: string, final = false): string[] {
    const result: string[] = [];
    while (this.offset < text.length) {
      const rest = text.slice(this.offset);
      if (this.code) {
        const end = rest.indexOf("```");
        if (end < 0) {
          if (final) this.offset = text.length;
          break;
        }
        this.offset += end + 3;
        this.code = false;
        continue;
      }
      if (rest.startsWith("```")) {
        this.offset += 3;
        this.code = true;
        result.push("代码请看文字。");
        continue;
      }
      const fence = rest.indexOf("```"),
        punctuation = /[。！？!?；;\n]|[，,](?=\s|[^0-9])/.exec(rest);
      let end = punctuation ? punctuation.index + 1 : -1;
      if (fence >= 0 && (end < 0 || fence < end)) end = fence;
      if (end < 0 && rest.length >= 180) end = 180;
      if (end < 0) {
        if (!final) break;
        end = rest.length;
      }
      if (end === 0) continue;
      const raw = rest.slice(0, end);
      if (!final && /\[[^\]]*$|\]\([^)]*$|`{1,2}$/.test(raw)) break;
      this.offset += end;
      const value = spokenText(raw);
      if (value) result.push(value);
    }
    return result;
  }
}
// 队列只预取下一句，避免模型生成很快时提前合成一整段随后被打断的音频。
export class SpeechQueue<T> {
  private items: string[] = [];
  private pending?: Promise<void>;
  private failure: unknown;
  constructor(
    private synth: (text: string) => Promise<T>,
    private play: (clip: T) => Promise<void>,
    private signal: AbortSignal,
  ) {}
  add(parts: string[]) {
    if (this.signal.aborted || this.failure) return;
    this.items.push(...parts);
    this.pump();
  }
  private pump() {
    if (
      this.pending ||
      !this.items.length ||
      this.signal.aborted ||
      this.failure
    )
      return;
    this.pending = (async () => {
      let next: Promise<T> | undefined = this.synth(this.items.shift()!);
      while (next) {
        const clip = await next;
        this.signal.throwIfAborted();
        next = this.items.length ? this.synth(this.items.shift()!) : undefined;
        next?.catch(() => {});
        await this.play(clip);
        this.signal.throwIfAborted();
        if (!next && this.items.length) next = this.synth(this.items.shift()!);
      }
    })()
      .catch((e) => {
        this.failure = e;
        this.items = [];
      })
      .finally(() => {
        this.pending = undefined;
        this.pump();
      });
  }
  async done() {
    while (this.pending) await this.pending;
    this.signal.throwIfAborted();
    if (this.failure) throw this.failure;
  }
}
