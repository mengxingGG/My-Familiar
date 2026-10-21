import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { bootstrapAndroid } from '../apps/tauri/runtime/bootstrap.ts';
import { mobileApi } from '../apps/tauri/runtime/mobile-api.ts';
import { createMobileBridge } from '../packages/mobile-bridge/index.ts';
import { projectLibraryResult } from '../packages/mobile-bridge/library.ts';
import { revision } from '../plugins/home-files/store.ts';
import type { AndroidNative } from '../plugins/platform-android/index.ts';

async function fixture() {
  await mkdir('.artifacts', { recursive: true });
  const root = await mkdtemp(resolve('.artifacts/android-library-'));
  const native: AndroidNative = { async call<T>(method: string): Promise<T> { return (method === 'secrets.readAll' ? {} : method === 'capabilities.status' ? [] : method === 'runtime.status' ? { running: true, engine: 'ready', overlayVisible: false, detail: 'fixture' } : null) as T; } };
  let kernel = await bootstrapAndroid(root, resolve('.'), native), api = mobileApi(kernel, native);
  const bridge = createMobileBridge({ listen: () => () => {}, invoke: request => api(request) });
  return { root, bridge, get kernel() { return kernel; }, async restart() { await kernel.dispose(); kernel = await bootstrapAndroid(root, resolve('.'), native); api = mobileApi(kernel, native); }, async dispose() { bridge.dispose(); await kernel.dispose(); await rm(root, { recursive: true, force: true }); } };
}
const skill = (name: string, body = '测试步骤') => `---\nname: ${name}\ndescription: 资料管理验收技能\n---\n${body}`;
const code = (expected: string) => (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; };

test('Android 记忆使用共享文件及修订锁：并发冲突、备份、Unicode 上限、重启与路径边界', async () => {
  const f = await fixture(), b = f.bridge;
  try {
    assert.deepEqual((await b.request('snapshot.get', undefined)).library, { memory: true, skills: true });
    const list = await b.request('library.memory.list', undefined); assert(list.files.includes('CORE.md'));
    const path = 'topics/library-check.md';
    const first = await b.request('library.memory.write', { path, text: '# 资料验收\n\n> 何时读：资料测试\n\n- 香蕉计划', revision: revision(''), create: true });
    const writes = await Promise.allSettled(['版本甲', '版本乙'].map(text => b.request('library.memory.write', { path, text, revision: first.revision })));
    assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((writes.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'CONFLICT');
    await assert.rejects(b.request('library.memory.write', { path, text: '不能覆盖', revision: revision(''), create: true }), code('CONFLICT'));
    const current = await b.request('library.memory.read', { path });
    await b.request('library.memory.write', { path, text: '香蕉计划\n' + '🪴'.repeat(99995), revision: current.revision });
    assert.equal((await b.request('library.memory.read', { path })).characters, 100000);
    assert((await b.request('library.memory.search', { query: '香蕉计划' })).some(r => r.path === path));
    const core = await b.request('library.memory.read', { path: 'CORE.md' });
    await assert.rejects(b.request('library.memory.write', { path: core.path, text: '🪴'.repeat(2001), revision: core.revision }), code('LIMIT'));
    assert.equal((await b.request('library.memory.read', { path: core.path })).revision, core.revision);
    for (const path of ['../secret.md', '/secret.md', 'C:/secret.md', '.history/secret.md', 'topics\\x.md', 'core.md']) await assert.rejects(b.request('library.memory.read', { path }), code('INVALID_INPUT'));
    await assert.rejects(b.request('library.memory.read', { path: 'topics/missing.md' }), code('NOT_FOUND'));
    const home = f.kernel.resolve('familiar.home').root;
    assert((await readdir(join(home, 'memory', '.history'))).length > 0);
    await writeFile(join(home, 'memory', 'topics', 'large.md'), '🪴'.repeat(100001));
    const clipped = await b.request('library.memory.read', { path: 'topics/large.md' });
    assert.equal(clipped.truncated, true); assert.equal(Array.from(clipped.text).length, 100000); assert.equal(clipped.characters, 100001);
    await f.restart(); assert.equal((await b.request('library.memory.read', { path })).characters, 100000);
  } finally { await f.dispose(); }
});

test('Android 技能读取完整导入文本、校验 YAML、停用持久化、移除备份及平台限制', async () => {
  const f = await fixture(), b = f.bridge;
  try {
    const content = skill('library-check', '步骤\n'.repeat(5000) + 'TAIL-COMPLETE');
    const asset = await f.kernel.resolve('media.assets').add('SKILL.md', 'text/plain', Buffer.from(content), 'file');
    const source = await b.request('library.skills.source', { attachmentId: asset.id }); assert.equal(source.text, content);
    assert((await b.request('library.skills.install', { content: source.text })).enabled);
    assert.equal((await b.request('library.skills.read', { id: 'library-check' })).text, content);
    await assert.rejects(b.request('library.skills.install', { content }), code('CONFLICT'));
    await assert.rejects(b.request('library.skills.install', { content: 'not frontmatter' }), code('INVALID_DOCUMENT'));
    await assert.rejects(b.request('library.skills.install', { content: '界'.repeat(22000) }), code('LIMIT'));
    for (const url of ['http://example.test/SKILL.md', 'file:///etc/passwd', 'https://user:password@example.test/SKILL.md', 'https://example.test/SKILL.md#fragment']) await assert.rejects(b.request('library.skills.install', { url }), code('INVALID_INPUT'));
    await assert.rejects(b.request('library.skills.install', { content, url: 'https://example.test/SKILL.md' }), code('INVALID_INPUT'));
    await assert.rejects(b.request('library.skills.install', { content: skill('feishu-office') }), code('UNAVAILABLE'));
    const large = await f.kernel.resolve('media.assets').add('large.md', 'text/plain', Buffer.alloc(65537, 65), 'file');
    await assert.rejects(b.request('library.skills.source', { attachmentId: large.id }), code('LIMIT'));
    const image = await f.kernel.resolve('media.assets').add('image.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9SAAAAAASUVORK5CYII=', 'base64'), 'file');
    await assert.rejects(b.request('library.skills.source', { attachmentId: image.id }), code('INVALID_DOCUMENT'));
    assert.equal((await b.request('library.skills.toggle', { id: 'library-check', enabled: false })).enabled, false);
    await f.restart(); assert.equal((await b.request('library.skills.list', {})).items.find(s => s.id === 'library-check')?.enabled, false);
    const home = f.kernel.resolve('familiar.home').root;
    await b.request('library.skills.remove', { id: 'library-check' });
    assert(!(await b.request('library.skills.list', {})).items.some(s => s.id === 'library-check'));
    const backup = (await readdir(join(home, 'skills', '.removed'))).find(p => p.endsWith('-library-check')); assert(backup);
    assert.equal(await readFile(join(home, 'skills', '.removed', backup, 'SKILL.md'), 'utf8'), content);
    await b.request('library.skills.install', { content });
    assert.equal((await b.request('library.skills.list', {})).items.find(s => s.id === 'library-check')?.enabled, true);
  } finally { await f.dispose(); }
});

test('资料返回投影不泄露宿主路径，并拒绝错文件、错技能和不完整响应', () => {
  const value = { path: 'CORE.md', text: '规则', characters: 2, truncated: false, revision: revision('规则'), source: '/private/app/CORE.md' };
  assert(!JSON.stringify(projectLibraryResult('library.memory.read', value, { path: 'CORE.md' })).includes('/private'));
  assert.throws(() => projectLibraryResult('library.memory.read', value, { path: 'USER.md' }));
  assert.throws(() => projectLibraryResult('library.memory.read', { ...value, revision: 'bad' }, { path: 'CORE.md' }));
  assert.throws(() => projectLibraryResult('library.skills.toggle', { id: 'wrong', description: 'demo', enabled: true, supported: true, valid: true }, { id: 'right' }));
  assert.throws(() => projectLibraryResult('library.skills.source', { text: 'x'.repeat(65537) }, {}));
});

test('技能下载等待不会阻塞取消语音或读取快照', async () => {
  const f = await fixture(); let finish!: () => void;
  const catalog = f.kernel.resolve('skills.catalog'), install = catalog.install;
  catalog.install = async (source) => { assert.equal(source, 'https://example.test/SKILL.md'); await new Promise<void>(resolve => { finish = resolve; }); return { id: 'pending', description: 'pending', enabled: true, source: 'private' }; };
  const pending = f.bridge.request('library.skills.install', { url: ' HTTPS://example.test/SKILL.md ' });
  try {
    while (!finish) await new Promise(r => setImmediate(r));
    const timeout = setTimeout(() => finish(), 2000); const start = Date.now();
    await f.bridge.request('voice.stop', undefined); await f.bridge.request('snapshot.get', undefined);
    clearTimeout(timeout); assert(Date.now() - start < 1500);
    finish(); await pending;
  } finally { finish?.(); catalog.install = install; await pending; await f.dispose(); }
});
