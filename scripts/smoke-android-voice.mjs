import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
const app = 'app.familiar.mobile.debug', output = '.artifacts/android-device'; await mkdir(output, { recursive: true });
const adb = (...args) => execFileSync('C:/AndroidSDK/platform-tools/adb.exe', ['-s', 'emulator-5554', ...args], { encoding: 'utf8', windowsHide: true }).trim();
const pause = ms => new Promise(r => setTimeout(r, ms));
let slow = false, stt = 0, tts = 0; const results = [], requests = [];
const pcm = Buffer.alloc(48000); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 220 / 24000) * 500), i * 2);
const server = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'voice-chat-fixture' }] })); return; }
  const parts = []; for await (const part of req) parts.push(part); const body = Buffer.concat(parts);
  if (req.url.endsWith('/transcriptions')) {
    stt++; assert.equal(req.headers.authorization, 'Bearer VOICE_TEST_STT'); assert(body.includes(Buffer.from('RIFF')));
    requests.push({ kind: 'stt', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    const timer = setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: '模拟识别结果：录音链路已收到' })); }, slow ? 8000 : 20); res.on('close', () => clearTimeout(timer));
  } else if (req.url.endsWith('/speech')) {
    tts++; assert.equal(req.headers.authorization, 'Bearer VOICE_TEST_TTS'); assert.equal(JSON.parse(body).voice, 'fixture');
    res.writeHead(200, { 'Content-Type': 'audio/pcm;rate=24000;channels=1' });
    let count = 0; const timer = setInterval(() => { if (++count <= 3) res.write(pcm); else { clearInterval(timer); res.end(); } }, 150); res.on('close', () => clearInterval(timer));
  } else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"这是本地语音播放测试。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; adb('reverse', `tcp:${port}`, `tcp:${port}`);
let browser, page, before, conversation, config, sequence = 0;
const raw = (method, params) => page.evaluate(payload => window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke', { payload }), { protocolVersion: 1, id: `voice-${++sequence}`, method, params });
const call = async (method, params) => { const r = await raw(method, params); assert(r.ok, `${method}: ${r.error?.code}`); return r.result; };
async function attach() {
  adb('shell', 'am', 'start', '-n', `${app}/app.familiar.mobile.MainActivity`);
  for (let i = 0; i < 60; i++) try { const pid = adb('shell', 'pidof', app); adb('forward', 'tcp:9226', `localabstract:webview_devtools_remote_${pid}`); browser = await chromium.connectOverCDP('http://127.0.0.1:9226'); break; } catch { await pause(200); }
  assert(browser); page = browser.contexts()[0].pages()[0]; await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__));
}
async function until(predicate) { const end = Date.now() + 25000; let s; while (Date.now() < end) { s = await call('snapshot.get'); if (predicate(s)) return s; await pause(100); } throw Error(`voice device timed out: ${JSON.stringify(s?.voice?.state)}`); }
const services = () => adb('shell', 'dumpsys', 'activity', 'services', app);
function nodes() { adb('shell', 'uiautomator', 'dump', '/sdcard/familiar-voice-window.xml'); return [...adb('shell', 'cat', '/sdcard/familiar-voice-window.xml').matchAll(/<node\b[^>]+>/g)].map(m => Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]))); }
function tap(node) { assert(node, 'Notification stop control missing'); const b = [...node.bounds.matchAll(/\d+/g)].map(m => Number(m[0])); adb('shell', 'input', 'tap', String((b[0] + b[2]) / 2), String((b[1] + b[3]) / 2)); }
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
try {
  await attach(); before = await until(s => s.runtime.engine === 'ready');
  assert(before.voice && !before.voice.settings.stt.keyConfigured && !before.voice.settings.tts.keyConfigured && before.providers.every(p => !p.profile.keyConfigured));
  assert(before.capabilities.some(c => c.id === 'microphone' && c.state === 'granted'));
  assert.equal((await raw('voice.host', { type: 'pcm', epoch: 0, data: '' })).ok, false);
  config = { stt: { kind: 'compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fixture-stt', apiKey: 'VOICE_TEST_STT' }, tts: { kind: 'compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fixture-tts', voice: 'fixture', speed: 1, apiKey: 'VOICE_TEST_TTS' }, autoRead: false, continuous: true };
  await call('voice.save', config); await call('provider.save', { kind: 'compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'voice-chat-fixture' }); conversation = (await call('conversation.create')).id;
  await page.reload(); await page.locator('#familiar-root[data-ready="true"]').waitFor(); if (!(await page.locator('.page-chat').isVisible())) await page.getByRole('button', { name: '说句话', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '想说的话', exact: true }); await composer.fill('原始草稿');
  await page.getByRole('button', { name: '录音转文字', exact: true }).click(); await until(s => s.voice.state.phase === 'recording');
  assert(services().includes('VoiceService')); assert(adb('shell', 'cmd', 'appops', 'get', app, 'RECORD_AUDIO').includes('running'));
  await page.screenshot({ path: `${output}/voice-recording.png` });
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await pause(1200); assert((await call('snapshot.get')).voice.state.active); assert(services().includes('VoiceService'));
  adb('shell', 'am', 'start', '-n', `${app}/app.familiar.mobile.MainActivity`); await page.getByRole('button', { name: '完成录音', exact: true }).click();
  await until(s => s.voice.dictation?.text.includes('模拟识别')); await page.waitForFunction(() => document.querySelector('.composer-input').value.includes('模拟识别'));
  assert((await composer.inputValue()).startsWith('原始草稿\n')); assert.equal(stt, 1); await pause(800); assert(!adb('shell', 'cmd', 'appops', 'get', app, 'RECORD_AUDIO').includes('(running)'));
  pass('真实 AudioRecord → 24kHz WAV → 本地识别服务 → 原草稿；退到桌面仍录音，完成后释放麦克风');
  slow = true; await page.getByRole('button', { name: '录音转文字', exact: true }).click(); await until(s => s.voice.state.phase === 'recording'); await pause(500);
  await page.getByRole('button', { name: '完成录音', exact: true }).click(); await until(s => s.voice.state.phase === 'thinking'); await page.getByRole('button', { name: '停止语音', exact: true }).click();
  await until(s => s.voice.state.phase === 'off'); assert.equal((await call('snapshot.get')).voice.dictation, undefined); slow = false;
  pass('转写请求处理中可停止，不把迟到结果写入草稿');
  await call('message.send', { conversationId: conversation, text: '本地朗读测试' });
  const complete = await until(s => !s.activeReply && s.conversations.some(c => c.id === conversation && c.messages.some(m => m.role === 'assistant' && m.status === 'complete')));
  const reply = complete.conversations.find(c => c.id === conversation).messages.findLast(m => m.role === 'assistant');
  await call('voice.read', { conversationId: conversation, messageId: reply.id }); await until(s => s.voice.state.phase === 'speaking'); assert(services().includes('VoiceService'));
  await until(s => s.voice.state.phase === 'off'); assert.equal(tts, 1); await pause(700);
  await call('voice.read', { conversationId: conversation, messageId: reply.id }); await until(s => s.voice.state.phase === 'speaking'); await until(s => s.voice.state.phase === 'off'); assert.equal(tts, 1);
  pass('流式 PCM 实际播放并收到结束回执；缓存 WAV 通过 MediaPlayer 回放，无重复 TTS 请求');
  await call('voice.read', { conversationId: conversation, messageId: reply.id }); await until(s => s.voice.state.phase === 'speaking'); await call('voice.stop'); await until(s => s.voice.state.phase === 'off');
  await pause(800); assert(!services().includes('VoiceService')); pass('中止缓存回放后播放器与语音前台服务释放');
  await call('voice.start', { mode: 'conversation', conversationId: conversation }); await until(s => s.voice.state.phase === 'listening');
  assert.equal((await raw('conversation.create')).error?.code, 'BUSY');
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await pause(800); assert((await call('snapshot.get')).voice.state.active);
  adb('shell', 'cmd', 'statusbar', 'expand-notifications'); await pause(400); let visible = nodes();
  let stop = visible.find(n => n.text === '停止语音'); if (!stop) { const expand = visible.find(n => n['content-desc']?.includes('展开') && n.package === 'com.android.systemui'); if (expand) { tap(expand); visible = nodes(); stop = visible.find(n => n.text === '停止语音'); } }
  tap(stop); await until(s => s.voice.state.phase === 'off'); await pause(800); assert(!services().includes('VoiceService'));
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); adb('shell', 'am', 'start', '-n', `${app}/app.familiar.mobile.MainActivity`);
  pass('连续语音绑定会话，桌面常驻录音可从通知栏真实点击停止');
  // 新版 Activity 边界要求真实前台焦点；am start 返回不表示焦点已交还。
  await page.waitForFunction(() => document.hasFocus());
  await call('voice.start', { mode: 'dictation', conversationId: conversation }); await until(s => s.voice.state.phase === 'recording');
  adb('shell', 'am', 'start', '-n', 'app.familiar.fixture/.FixtureActivity', '--ez', 'takeAudioFocus', 'true');
  await until(s => s.voice.state.phase === 'error' && !s.voice.state.active); await pause(800); assert(!services().includes('VoiceService'));
  adb('shell', 'am', 'force-stop', 'app.familiar.fixture'); adb('shell', 'am', 'start', '-n', `${app}/app.familiar.mobile.MainActivity`);
  await pause(500); assert(!(await call('snapshot.get')).voice.state.active); pass('其他应用抢占音频焦点时停录并报告错误，焦点归还后不自动重开麦克风');
} finally {
  try {
    if (before && page) {
      await call('voice.stop');
      if (config) await call('voice.save', { ...config, stt: { ...config.stt, apiKey: undefined, clearApiKey: true }, tts: { ...config.tts, apiKey: undefined, clearApiKey: true } });
      await call('voice.save', before.voice.settings); await call('reply.cancel');
      if (before.activeConversationId) await call('conversation.select', { id: before.activeConversationId });
      if (conversation) await call('conversation.delete', { id: conversation });
      const prior = before.providers.find(p => p.id === 'compatible').profile; await call('provider.save', { ...prior }); if (before.provider.kind !== 'compatible') await call('provider.save', before.provider);
      if (before.activeConversationId) await call('conversation.select', { id: before.activeConversationId });
      await call('runtime.set', { enabled: before.runtime.running });
    }
  } finally { await browser?.close(); adb('reverse', '--remove', `tcp:${port}`); server.closeAllConnections(); await new Promise(r => server.close(r)); await writeFile(`${output}/voice-smoke.json`, JSON.stringify({ results, requests, stt, tts }, null, 2)); }
}
