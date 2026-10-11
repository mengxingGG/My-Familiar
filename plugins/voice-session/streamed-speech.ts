import type { AudioClip, PcmChunk } from "../../packages/contracts/index.ts";
type Part = { pcm: PcmChunk } | { clip: AudioClip };

// 合成可以预取下一句，播放逐块消费当前句；停止后不再交付迟到的音频。
export class StreamedSpeech {
  private parts: Part[] = [];
  private finished = false;
  private failure: unknown;
  private notify?: () => void;
  constructor(
    produce: (push: (pcm: PcmChunk) => void) => Promise<AudioClip>,
    private signal: AbortSignal,
  ) {
    let streamed = false;
    const abort = () => {
      this.parts = [];
      this.notify?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return produce((pcm) => {
          signal.throwIfAborted();
          streamed = true;
          this.parts.push({ pcm });
          this.notify?.();
        });
      })
      .then((clip) => {
        signal.throwIfAborted();
        if (!streamed) this.parts.push({ clip });
      })
      .catch((e) => {
        this.failure = e;
      })
      .finally(() => {
        this.finished = true;
        signal.removeEventListener("abort", abort);
        this.notify?.();
      });
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Part> {
    while (true) {
      this.signal.throwIfAborted();
      if (this.failure) throw this.failure;
      const part = this.parts.shift();
      if (part) {
        yield part;
        continue;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
      this.notify = undefined;
    }
  }
}
