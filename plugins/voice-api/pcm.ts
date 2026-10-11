import type { PcmChunk } from "../../packages/contracts/index.ts";

// PCM 是 16 位小端单声道；不能凭模型名称猜采样率，否则会变调、变速。
export function pcmRate(contentType: string): number {
  const rate = /(?:^|;)\s*(?:rate|sample_rate)\s*=\s*"?(\d+)/i.exec(
    contentType,
  );
  const channels = /(?:^|;)\s*channels\s*=\s*"?(\d+)/i.exec(contentType);
  const value = Number(rate?.[1]);
  if (
    !/^audio\/(?:pcm|x-pcm)(?:;|$)/i.test(contentType) ||
    ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(value) ||
    (channels && Number(channels[1]) !== 1)
  )
    throw new Error(
      "语音接口的 PCM 缺少有效采样率或不是单声道，请关闭流式播报或修正接口响应头",
    );
  return value;
}

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

export async function readPcm(
  response: Response,
  signal: AbortSignal,
  onPcm: (c: PcmChunk) => void,
) {
  if (!response.body) throw new Error("语音服务返回空响应");
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let carry = Buffer.alloc(0),
    size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  try {
    signal.throwIfAborted();
    const rate = pcmRate(response.headers.get("content-type") ?? "");
    signal.addEventListener("abort", cancel, { once: true });
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > 20 * 1024 * 1024) throw new Error("语音服务响应过大");
      const joined = Buffer.concat([carry, value]),
        end = joined.length - (joined.length % 2);
      carry = joined.subarray(end);
      if (!end) continue;
      const data = joined.subarray(0, end);
      parts.push(data);
      // 限制单个 IPC 片段，网络的任意分块不影响样本对齐。
      for (let offset = 0; offset < data.length; offset += 24000) {
        signal.throwIfAborted();
        onPcm({ data: data.subarray(offset, offset + 24000), rate });
      }
    }
    if (carry.length) throw new Error("语音流在半个 PCM 样本处中断");
    if (!size) throw new Error("语音为空");
    return pcmWav(Buffer.concat(parts), rate);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
  }
}
