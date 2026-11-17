import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// 对实际渲染结果检查：SVG 解码、路径错误、透明边缘、不同帧及局部动作。
const root = resolve(import.meta.dirname, '..');
const output = join(root, '.artifacts/v2-art-existing');
const report = JSON.parse(await readFile(join(output, 'asset-report.json'), 'utf8'));
const jobs = [];
let totalBytes = 0;
for (const c of report.characters) {
  const m = JSON.parse(await readFile(join(root, 'characters', c.id, 'character.json'), 'utf8'));
  assert.equal(m.actions.length, 15);
  for (const action of m.actions) {
    const paths = m.representations.sprite.frames[action];
    assert.equal(paths.length, m.representations.sprite.timings[action].length);
    assert.ok(paths.length >= (action === 'eat' || action === 'play' ? 8 : 4));
    for (const [frame, filename] of paths.entries()) {
      assert.match(filename, /^[a-z]+-\d+\.svg$/);
      const file = join(root, 'characters', c.id, filename);
      const svg = await readFile(file, 'utf8');
      assert.ok(!/NaN|Infinity|<script|<foreignObject|href=/.test(svg));
      totalBytes += (await stat(file)).size;
      jobs.push({ id: c.id, action, frame, svg });
    }
  }
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1240, height: 840 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.setContent('<main id="stage"></main>');
  const results = [];
  for (let start = 0; start < jobs.length; start += 60) {
    const batch = await page.evaluate(async items => {
      const stage = document.getElementById('stage');
      const canvas = document.createElement('canvas');
      canvas.width = 220; canvas.height = 205;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const output = [];
      for (const item of items) {
        const xml = new DOMParser().parseFromString(item.svg, 'image/svg+xml');
        if (xml.querySelector('parsererror')) throw new Error(`Bad SVG: ${item.id}/${item.action}/${item.frame}`);
        stage.innerHTML = item.svg;
        const box = stage.firstElementChild.getBBox();
        const img = new Image();
        img.src = 'data:image/svg+xml;base64,' + btoa(item.svg);
        await img.decode();
        ctx.clearRect(0, 0, 220, 205); ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, 220, 205).data;
        let hash = 2166136261, nonzero = 0, edge = 0;
        for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619);
        for (let y = 0; y < 205; y++) for (let x = 0; x < 220; x++) {
          const a = pixels[(y * 220 + x) * 4 + 3];
          if (a) nonzero++;
          if (a && (x === 0 || y === 0 || x === 219 || y === 204)) edge++;
        }
        output.push({ id: item.id, action: item.action, frame: item.frame, hash: hash >>> 0, nonzero, edge, bounds: { x: box.x, y: box.y, width: box.width, height: box.height } });
      }
      return output;
    }, jobs.slice(start, start + 60));
    results.push(...batch);
  }
  assert.deepEqual(errors, [], 'SVG renderer emitted errors');
  const clipped = results.filter(r => r.edge > 0);
  assert.deepEqual(clipped, [], 'Artwork reaches canvas edge and may clip');
  assert.ok(results.every(r => r.nonzero > 2000 && r.nonzero < 36000), 'Unexpected empty or opaque canvas');
  const clips = {};
  for (const r of results) (clips[`${r.id}/${r.action}`] ??= []).push(r.hash);
  for (const [key, hashes] of Object.entries(clips)) assert.ok(new Set(hashes).size >= 4, `Too few visually distinct frames: ${key}`);

  await page.goto(pathToFileURL(join(output, 'preview.html')).href);
  await page.evaluate(() => { playing = false; clearTimeout(timer); });
  for (const [action, frame] of [['idle', 0], ['eat', 5], ['play', 3], ['sleep', 2], ['weak', 2], ['dejected', 2], ['recover', 4]]) {
    await page.evaluate(({ action: next, frame }) => { action = next; index = frame; document.querySelector('#action').value = next; draw(); }, { action, frame });
    await page.locator('img').evaluateAll(async images => { await Promise.all(images.map(img => img.decode())); });
    await page.screenshot({ path: join(output, `${action}-preview.png`), fullPage: true });
  }
  const before = await page.locator('#mori').getAttribute('src');
  await page.locator('#next').click();
  assert.notEqual(await page.locator('#mori').getAttribute('src'), before, 'Frame control does not advance');
  await page.locator('#action').selectOption('walk');
  assert.match(await page.locator('#mori').getAttribute('src'), /walk-0\.svg$/);
  await page.setViewportSize({ width: 1970, height: 1080 });
  await page.goto(pathToFileURL(join(output, 'matrix.html')).href);
  await page.locator('img').evaluateAll(async images => { await Promise.all(images.map(img => img.decode())); });
  assert.equal(await page.locator('td img').count(), 105);
  await page.screenshot({ path: join(output, 'full-matrix.png'), fullPage: true });
  const verification = { passed: true, frames: results.length, clips: Object.keys(clips).length, totalBytes, transparentEdges: true, svgDecodeErrors: errors, minimumDistinctFrames: Math.min(...Object.values(clips).map(a => new Set(a).size)), viewport: [1240, 840], browser: 'Playwright Chromium headless', previewControls: 'action selection and frame stepping passed', results };
  await writeFile(join(output, 'verification.json'), JSON.stringify(verification, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ passed: true, frames: results.length, clips: Object.keys(clips).length, totalBytes, minimumDistinctFrames: verification.minimumDistinctFrames }));
} finally { await browser.close(); }
