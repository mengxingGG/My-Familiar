import type { PcmChunk } from "../../packages/contracts/voice.ts";

// 有界音频交接，不让语音业务依赖 Windows WAV 或原生句柄。
export function wakePcm(audio: PcmChunk): Uint8Array {
  const { data, rate } = audio;
  if (
    !Number.isInteger(rate) ||
    rate < 8000 ||
    rate > 48000 ||
    data.length % 2 ||
    data.length > rate * 2 * 8
  )
    throw new Error("唤醒交接音频格式无效或超过 8 秒");
  if (rate === 24000) return data.slice();
  const frames = data.length / 2;
  const result = new Uint8Array(Math.floor((frames * 24000) / rate) * 2);
  const source = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const target = new DataView(result.buffer);
  for (let i = 0; i < result.length / 2; i++) {
    const pos = (i * rate) / 24000,
      left = Math.floor(pos),
      fraction = pos - left;
    const a = source.getInt16(left * 2, true),
      b = source.getInt16(Math.min(left + 1, frames - 1) * 2, true);
    target.setInt16(i * 2, Math.round(a + (b - a) * fraction), true);
  }
  return result;
}

// 只删除明确的句首名字与纯唤醒问候；正文、否定和后续请求完整保留。
export function wakeCommand(text: string, phrases: string[]): string {
  const names = phrases
    .filter(Boolean)
    .slice()
    .sort((a, b) => b.length - a.length);
  if (!names.length) return text.trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = new RegExp(
    `^(?:(?:你好|您好|嘿|嗨|喂)[，,。.!！?？\\s]*)?(?:${names.map(escape).join("|")})[，,。.!！?？、：:\\s]*`,
    "i",
  );
  const value = text.trim();
  if (!start.test(value)) return value;
  const rest = value.replace(start, "").trim();
  return /^(?:在吗|你在吗|在不在|你好|您好|起床啦|起床了|醒醒|醒来|在不在呀|在吗呀)?[，,。.!！?？\s]*$/.test(
    rest,
  )
    ? ""
    : rest;
}
