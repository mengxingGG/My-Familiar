export function pcmWav(pcm: Uint8Array, rate = 24000): Uint8Array {
  const out = Buffer.alloc(44 + pcm.length);
  out.write("RIFF");
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(pcm.length, 40);
  Buffer.from(pcm).copy(out, 44);
  return out;
}
export function pcmLevel(bytes: Uint8Array): number {
  if (bytes.length < 2) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2)
    sum += (view.getInt16(i, true) / 32768) ** 2;
  return Math.sqrt(sum / Math.floor(bytes.length / 2));
}
// 帧时间由音频字节数决定，避免后台定时器抖动截断用户说话。
export class UtteranceDetector {
  private chunks: Uint8Array[] = [];
  private pre: Uint8Array[] = [];
  private speaking = false;
  private silence = 0;
  private duration = 0;
  private voiced = 0;
  private candidate = 0;
  constructor(
    readonly silenceMs = 900,
    readonly threshold = 0.015,
  ) {}
  push(bytes: Uint8Array): { started?: boolean; pcm?: Uint8Array } {
    const ms = bytes.length / 48,
      loud = pcmLevel(bytes) >= this.threshold;
    let started = false;
    if (!this.speaking) {
      this.pre.push(bytes);
      while (this.pre.reduce((n, c) => n + c.length, 0) > 24000)
        this.pre.shift();
      this.candidate = loud ? this.candidate + ms : 0;
      if (this.candidate < 200) return {};
      this.speaking = true;
      started = true;
      this.chunks = this.pre;
      this.pre = [];
      this.voiced = this.candidate - ms;
    } else this.chunks.push(bytes);
    this.duration += ms;
    if (loud) {
      this.silence = 0;
      this.voiced += ms;
    } else this.silence += ms;
    if (this.silence >= this.silenceMs || this.duration >= 90000) {
      const pcm = this.voiced >= 180 ? Buffer.concat(this.chunks) : undefined;
      this.reset();
      return { started, pcm };
    }
    return { started };
  }
  reset() {
    this.chunks = [];
    this.pre = [];
    this.speaking = false;
    this.silence = this.duration = this.voiced = this.candidate = 0;
  }
}
