const api = window.familiar;
let epoch = 0,
  playback = 0,
  audio,
  mic,
  capture,
  input,
  silent,
  workletReady,
  micGeneration = 0,
  playbackGeneration = 0,
  nextTime = 0,
  liveEnded = false,
  liveEndId,
  livePlaying = false,
  audioQueue = Promise.resolve();
const playing = new Set();
const report = (type, data = {}, version = epoch) =>
  api
    .request("voice.host", { type, epoch: version, playback, ...data })
    .catch(() => {});
const context = async () => {
  audio ??= new AudioContext({ sampleRate: 24000 });
  if (audio.state === "suspended") await audio.resume();
  return audio;
};
function clear() {
  playbackGeneration++;
  for (const node of playing) {
    node.onended = null;
    try {
      node.stop();
    } catch {}
    node.disconnect();
  }
  playing.clear();
  nextTime = 0;
  liveEnded = false;
  liveEndId = undefined;
  livePlaying = false;
}
function stopMic() {
  micGeneration++;
  capture?.disconnect();
  input?.disconnect();
  silent?.disconnect();
  capture = input = silent = undefined;
  mic?.getTracks().forEach((track) => track.stop());
  mic = undefined;
}
function decode(data) {
  const raw = atob(data),
    bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
async function listen(version) {
  stopMic();
  const generation = micGeneration,
    ctx = await context();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
  if (version !== epoch || generation !== micGeneration) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  mic = stream;
  workletReady ??= ctx.audioWorklet.addModule("capture.js");
  await workletReady;
  if (version !== epoch || generation !== micGeneration) return;
  input = ctx.createMediaStreamSource(stream);
  capture = new AudioWorkletNode(ctx, "familiar-capture");
  let carry = new Float32Array(0),
    position = 0,
    inflightBytes = 0;
  capture.port.onmessage = ({ data }) => {
    if (version !== epoch || generation !== micGeneration) return;
    const joined = new Float32Array(carry.length + data.samples.length);
    joined.set(carry);
    joined.set(data.samples, carry.length);
    const step = data.rate / 24000,
      values = [];
    while (position + 1 < joined.length) {
      const i = Math.floor(position),
        f = position - i;
      values.push(joined[i] * (1 - f) + joined[i + 1] * f);
      position += step;
    }
    const used = Math.floor(position);
    carry = joined.slice(used);
    position -= used;
    const buffer = new ArrayBuffer(values.length * 2),
      view = new DataView(buffer);
    for (let i = 0; i < values.length; i++)
      view.setInt16(
        i * 2,
        Math.round(Math.max(-1, Math.min(1, values[i])) * 32767),
        true,
      );
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    if (inflightBytes + bytes.length > 48000) {
      stopMic();
      void report(
        "error",
        { message: "音频处理过慢，已停止录音，请重新开始" },
        version,
      );
      return;
    }
    inflightBytes += bytes.length;
    api
      .request("voice.host", {
        type: "pcm",
        epoch: version,
        data: btoa(binary),
      })
      .catch(() => {})
      .finally(() => (inflightBytes -= bytes.length));
  };
  input.connect(capture);
  silent = ctx.createGain();
  silent.gain.value = 0;
  capture.connect(silent);
  silent.connect(ctx.destination);
  void report("listening", {}, version);
}
function ended(version) {
  if (liveEnded && !playing.size && version === epoch) {
    livePlaying = false;
    liveEnded = false;
    void report("playing-end", liveEndId ? { id: liveEndId } : {}, version);
    liveEndId = undefined;
  }
}
api.on("familiar:voice-host", (message) => {
  const version = message.epoch;
  if (version < epoch) return;
  playback = message.playback;
  if (version !== epoch) {
    epoch = version;
    stopMic();
    clear();
  }
  const failed = (e) => {
    if (version === epoch)
      void report(
        "error",
        {
          message:
            e.name === "NotAllowedError"
              ? "麦克风权限被拒绝，请检查 Windows 麦克风隐私设置"
              : e.message,
        },
        version,
      );
  };
  if (message.type === "stop") {
    stopMic();
    clear();
    return;
  }
  if (message.type === "mic-stop") {
    stopMic();
    return;
  }
  if (message.type === "clear") {
    clear();
    return;
  }
  if (message.type === "listen") {
    void listen(version).catch(failed);
    return;
  }
  const generation = playbackGeneration;
  // 解码和结束标记有序处理；停止操作立即越过队列，旧解码完成后不能恢复播放。
  audioQueue = audioQueue
    .then(async () => {
      if (version !== epoch || generation !== playbackGeneration) return;
      if (message.type === "audio-end") {
        liveEnded = true;
        liveEndId = message.id;
        ended(version);
        return;
      }
      if (message.type !== "pcm" && message.type !== "play") return;
      const ctx = await context(),
        bytes = decode(message.data);
      let buffer;
      if (message.type === "pcm") {
        if (
          ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(
            message.rate,
          ) ||
          bytes.length % 2
        )
          throw new Error("实时音频格式无效");
        buffer = ctx.createBuffer(1, bytes.length / 2, message.rate);
        const samples = buffer.getChannelData(0),
          view = new DataView(bytes.buffer);
        for (let i = 0; i < samples.length; i++)
          samples[i] = view.getInt16(i * 2, true) / 32768;
        livePlaying = true;
        liveEnded = false;
      } else buffer = await ctx.decodeAudioData(bytes.buffer);
      if (version !== epoch || generation !== playbackGeneration) return;
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      playing.add(node);
      const start = Math.max(ctx.currentTime + 0.025, nextTime);
      if (start - ctx.currentTime > 120) throw new Error("播放积压过多");
      nextTime = start + buffer.duration;
      node.onended = () => {
        playing.delete(node);
        node.disconnect();
        if (message.id) void report("playing-end", { id: message.id }, version);
        else ended(version);
      };
      node.start(start);
    })
    .catch(failed);
});
window.addEventListener("beforeunload", () => {
  stopMic();
  clear();
  void audio?.close();
});
