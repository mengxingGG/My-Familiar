import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { androidLocalVoice, joinLocalWav } from "../plugins/platform-android/local-voice.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import { pcmWav } from "../plugins/voice-session/audio.ts";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import { isMobileSnapshot } from "../packages/mobile-bridge/index.ts";

test("Android 本地合成保留 4096 字符、代理对和 PCM，取消后回收私有文件", async () => {
  const root = await mkdtemp(resolve(".artifacts/android-local-")), id = 'android:' + 'a'.repeat(64), calls: any[] = [];
  let pending = false;
  const native: AndroidNative = { async call<T>(method: string, params = {}) {
    const p = params as any; calls.push({ method, ...p });
    if (method === "tts.scope") return id as T;
    if (method === "tts.start") { await writeFile(join(root, 'tts-inbox', `${p.operationId}.wav`), pcmWav(new Uint8Array([1, 0, 2, 0]))); }
    if (method === "tts.poll") return { state: pending ? 'pending' : 'ready' } as T;
    return null as T;
  } };
  try {
    const local = await androidLocalVoice(root, native);
    const text = '字'.repeat(3999) + '😀' + '末'.repeat(95);
    const wav = Buffer.from(await local.synthesize(text, 'direct', '', 1, new AbortController().signal));
    const chunks = calls.filter(c => c.method === 'tts.start').map(c => c.text);
    assert.equal(chunks.join(''), text); assert.equal(chunks.length, 2); assert(chunks.every(c => c.length <= 4000)); assert(chunks[1].startsWith('😀'));
    assert.deepEqual(wav.subarray(44), Buffer.from([1, 0, 2, 0, 1, 0, 2, 0])); assert.deepEqual(await readdir(join(root, 'tts-inbox')), []);
    pending = true; const abort = new AbortController(); const promise = local.synthesize('取消合成', 'direct', '', 1, abort.signal);
    const rejected = assert.rejects(promise);
    for (let i = 0; i < 100 && !calls.some(c => c.text === '取消合成'); i++) await new Promise(r => setTimeout(r, 5));
    const operation = calls.find(c => c.text === '取消合成'); assert(operation); abort.abort(); await rejected;
    assert(calls.some(c => c.method === 'tts.cancel' && c.operationId === operation.operationId)); assert.deepEqual(await readdir(join(root, 'tts-inbox')), []);
    assert.throws(() => joinLocalWav([pcmWav(new Uint8Array(4), 16000), pcmWav(new Uint8Array(4), 24000)]));
    const malformed = Buffer.from(pcmWav(new Uint8Array(4))); malformed.writeUInt32LE(9999, 40); assert.throws(() => joinLocalWav([malformed]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Android 本地音色走共享缓存，但卸载或更换引擎不能命中旧音频；移动端不接收本地密钥", async () => {
  const root = await mkdtemp(resolve('.artifacts/android-local-cache-')), keys: Record<string, string> = {};
  let voice = 'android:' + 'a'.repeat(64), available = true, synthesized = 0;
  const native: AndroidNative = { async call<T>(method: string, params = {}) {
    const p = params as any;
    if (method === 'secrets.readAll') return { ...keys } as T;
    if (method === 'secrets.write') { if (p.value) keys[p.name] = p.value; else delete keys[p.name]; }
    if (method === 'capabilities.status') return [] as T;
    if (method === 'runtime.status') return { running: false, overlayVisible: false, engine: 'ready', detail: 'fixture' } as T;
    if (method === 'tts.scope') { if (!available || p.voice && p.voice !== voice) throw Error('UNAVAILABLE'); return voice as T; }
    if (method === 'tts.catalog') return { models: [{ id: 'android', name: 'fixture' }], voices: available ? [{ id: voice, name: '中文' }] : [], voiceSource: 'api', note: '隔离本地音色' } as T;
    if (method === 'tts.start') { synthesized++; assert.equal(p.voice, voice); await writeFile(join(root, 'tts-inbox', `${p.operationId}.wav`), pcmWav(new Uint8Array([1, 0, 2, 0]))); }
    if (method === 'tts.poll') return { state: 'ready' } as T;
    return null as T;
  } };
  const kernel = await bootstrapAndroid(root, resolve('.'), native), mobile = mobileApi(kernel, native); let n = 0;
  const call = (method: string, params?: unknown) => mobile({ protocolVersion: 1, id: `local-${++n}`, method: method as any, params });
  try {
    const cloud = { kind: 'compatible', baseUrl: 'https://example.invalid/v1', model: 'old-model' };
    const config = { stt: cloud, tts: { ...cloud, kind: 'system', voice: '', speed: 1, stream: false }, autoRead: false, continuous: false };
    assert((await call('voice.save', config)).ok);
    const snapshot = (await call('snapshot.get')).result as any; assert(isMobileSnapshot(snapshot)); assert(snapshot.voice); assert.equal(snapshot.voice.settings.tts.kind, 'system'); assert(snapshot.voice.localTts);
    assert(!(await call('voice.save', { ...config, stt: { ...cloud, kind: 'system' } })).ok);
    assert(!(await call('voice.save', { ...config, tts: { ...config.tts, apiKey: 'forbidden-local-key' } })).ok); assert.deepEqual(keys, {});
    const c = (await call('voice.local.catalog')).result as any; assert.equal(c.voices[0].id, voice); assert.equal(c.models, undefined);
    const api = kernel.resolve('voice.api'), signal = new AbortController().signal;
    assert(!(await api.speak('同一段朗读', signal)).cached); assert((await api.speak('同一段朗读', signal)).cached); assert.equal(synthesized, 1);
    available = false; await assert.rejects(api.speak('同一段朗读', signal)); assert.equal(synthesized, 1);
    available = true; voice = 'android:' + 'b'.repeat(64); assert(!(await api.speak('同一段朗读', signal)).cached); assert.equal(synthesized, 2);
    const aborted = new AbortController(); aborted.abort(); await assert.rejects(api.speak('同一段朗读', aborted.signal));
  } finally { await kernel.dispose(); await rm(root, { recursive: true, force: true }); }
});
