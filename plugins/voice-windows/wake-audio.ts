import type { PcmChunk } from "../../packages/contracts/voice.ts";

// Windows helper 的 WAV 留在适配层，向业务层只传 PCM 和格式。
export function decodeWakeAudio(wav: Uint8Array): PcmChunk {
  if (wav.length < 44 || wav.length > 2 * 1024 * 1024)
    throw new Error("唤醒音频长度无效");
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const id = (offset: number) =>
    String.fromCharCode(...wav.subarray(offset, offset + 4));
  if (
    id(0) !== "RIFF" ||
    id(8) !== "WAVE" ||
    v.getUint32(4, true) + 8 !== wav.length
  )
    throw new Error("唤醒 WAV 无效");
  let rate = 0,
    data: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const length = v.getUint32(offset + 4, true),
      start = offset + 8;
    if (start + length > wav.length) throw new Error("唤醒 WAV 数据不完整");
    if (id(offset) === "fmt ") {
      if (
        length < 16 ||
        v.getUint16(start, true) !== 1 ||
        v.getUint16(start + 2, true) !== 1 ||
        v.getUint16(start + 14, true) !== 16 ||
        v.getUint16(start + 12, true) !== 2
      )
        throw new Error("唤醒音频需为 16 位单声道 PCM");
      rate = v.getUint32(start + 4, true);
    }
    if (id(offset) === "data")
      data = new Uint8Array(wav.subarray(start, start + length));
    offset = start + length + (length % 2);
  }
  if (
    !data?.length ||
    data.length % 2 ||
    rate < 8000 ||
    rate > 48000 ||
    data.length > rate * 2 * 8
  )
    throw new Error("唤醒音频格式或时长无效");
  return { data, rate };
}
