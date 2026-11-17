import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

// 七个既有原创矢量角色的可复现逐帧动画；身体、五官、四肢与道具分别绘制。
// 不依赖运行时定时器或外部图片，动画仅表达动作，不产生养成业务副作用。
const root = resolve(import.meta.dirname, '..');
const reportRoot = join(root, '.artifacts/v2-art-existing');
const ids = ['mori', 'luna', 'mianmian', 'lili', 'fangfang', 'youzi', 'diandian'];
const clips = {
  idle: [1700, 420, 110, 110, 850, 520, 110, 950],
  greet: [160, 160, 220, 200, 200, 260, 160, 280],
  happy: [140, 120, 140, 180, 140, 120, 140, 300],
  think: [450, 340, 450, 600, 340, 650],
  sleep: [850, 850, 1000, 850, 850, 1000],
  drag: [150, 150, 150, 150, 150, 150],
  walk: [120, 120, 120, 120, 120, 120, 120, 120],
  eat: [220, 220, 180, 200, 240, 200, 240, 200, 240, 220, 220, 320],
  full: [200, 220, 220, 240, 220, 220, 240, 420],
  play: [150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 250],
  drowsy: [500, 450, 450, 650, 400, 500],
  hungry: [550, 300, 450, 550, 300, 650],
  weak: [900, 650, 900, 650, 850, 1050],
  dejected: [1100, 900, 1100, 900, 1100, 1300],
  recover: [240, 200, 180, 220, 220, 180, 200, 350],
};
const labels = { idle: '待机', greet: '问候', happy: '开心', think: '思考', sleep: '睡眠', drag: '拖动', walk: '行走', eat: '吃饭', full: '吃饱', play: '玩耍', drowsy: '困倦', hungry: '饥饿', weak: '虚弱', dejected: '颓废', recover: '恢复' };
const once = new Set(['greet', 'happy', 'eat', 'full', 'play', 'drowsy', 'recover']);
const palette = {
  mori: { skin: '#d9e8b7', edge: '#778468', accent: '#779762', limb: '#d9e8b7' },
  luna: { skin: '#dedaf3', edge: '#88809f', accent: '#9b8abe', limb: '#dedaf3' },
  mianmian: { skin: '#fffaf0', edge: '#e1d5bd', accent: '#eddfc6', limb: '#9d8d79' },
  lili: { skin: '#aa7858', edge: '#855e4c', accent: '#f6e4c9', limb: '#855e4c' },
  fangfang: { skin: '#c5dce5', edge: '#6e8b9a', accent: '#eff7eb', limb: '#6e8b9a' },
  youzi: { skin: '#eea365', edge: '#ce804d', accent: '#fff1d6', limb: '#e89a58' },
  diandian: { skin: '#577886', edge: '#3d5966', accent: '#f8f4e9', limb: '#3d5966' },
};
const n = value => Number(value.toFixed(2));
const g = (transform, content, extra = '') => `<g transform="${transform}" ${extra}>${content}</g>`;
const path = (d, fill, stroke = 'none', width = 2.5, extra = '') => `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const ellipse = (x, y, rx, ry, fill, stroke = 'none', width = 2, extra = '') => `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rx)}" ry="${n(ry)}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" ${extra}/>`;

function pose(action, f) {
  const t = f / (clips[action].length - 1), wave = Math.sin(t * Math.PI * 2), breath = Math.sin(t * Math.PI);
  let crouch = 0, tilt = 0, lift = 0, ears = wave * 2, gaze = 0, left = [66, 153], right = [151, 153];
  let eyes = 1, mouth = 'smile', step = 0, tail = wave * 6;
  if (action === 'idle') { eyes = [2, 3, 6].includes(f) ? 0.08 : 1; lift = breath * 0.7; ears = breath * 3; }
  if (action === 'greet') { right = [155 + wave * 6, 118 - Math.sin(t * Math.PI) * 35]; tilt = wave * 3; mouth = 'joy'; }
  if (action === 'happy') { left = [55, 133 - breath * 26]; right = [164, 133 - breath * 26]; mouth = 'joy'; lift = Math.max(0, wave) * 5; tail = wave * 15; }
  if (action === 'think') { right = [126 + wave * 2, 132]; gaze = -3 + f; tilt = -3 + wave * 2; ears = -4; }
  if (action === 'sleep') { crouch = 1; eyes = 0; mouth = 'sleep'; left = [88, 168]; right = [135, 168]; ears = 35 + breath; tilt = -9; tail = 34; }
  if (action === 'drag') { tilt = wave * 4; left = [49 - wave * 4, 128]; right = [171 + wave * 4, 128]; eyes = 1.15; mouth = 'o'; ears = -10 - wave * 6; step = wave * 5; }
  if (action === 'walk') { step = wave * 6; left = [66, 151 + wave * 5]; right = [151, 151 - wave * 5]; tilt = wave * 2; lift = Math.abs(wave) * 1.8; tail = wave * 10; }
  if (action === 'eat') { const rise = Math.sin(Math.min(1, t * 1.7) * Math.PI / 2) * (t < 0.83 ? 1 : (1 - t) / 0.17); left = [86, 157 - rise * 22]; right = [135, 156 - rise * 22]; eyes = f >= 4 && f <= 8 ? 0.72 : 1; mouth = f >= 3 && f <= 8 ? (f % 2 ? 'o' : 'chew') : 'smile'; tilt = f % 2 ? 1.3 : 0; }
  if (action === 'full') { left = [92 + wave * 3, 156]; right = [131 - wave * 3, 156]; mouth = 'joy'; eyes = 0.8; tilt = wave * 2; tail = wave * 10; }
  if (action === 'play') { left = [69 + wave * 14, 149 - breath * 15]; right = [157 + wave * 5, 143 - breath * 20]; gaze = wave * 3; tilt = wave * 3; mouth = 'joy'; step = wave * 3; }
  if (action === 'drowsy') { crouch = breath * 0.3; tilt = breath * 6; eyes = 0.45 - breath * 0.35; mouth = f >= 2 && f <= 4 ? 'yawn' : 'smile'; right = [124, 137]; ears = 16 + breath * 10; }
  if (action === 'hungry') { left = [91, 155]; right = [130 + wave * 4, 157]; eyes = 0.8; mouth = f % 2 ? 'o' : 'sad'; gaze = 2; ears = 12; }
  if (action === 'weak') { crouch = 0.45; eyes = 0.35 + wave * 0.04; mouth = 'sad'; tilt = 5 + breath; ears = 28; left = [83 + wave * 1.5, 166 + breath]; right = [137 - wave, 166 - breath]; tail = 23; }
  if (action === 'dejected') { crouch = 0.95; eyes = 0.22 + wave * 0.035; mouth = 'sad'; tilt = 9 + breath; ears = 44; left = [92 + wave, 165]; right = [130, 165 + wave]; tail = 32; }
  if (action === 'recover') { crouch = Math.max(0, 0.7 - t); eyes = 0.3 + t * 0.7; mouth = f > 3 ? 'joy' : 'smile'; left = [63, 160 - breath * 49]; right = [156, 160 - breath * 49]; ears = (1 - t) * 22; lift = breath * 2; }
  return { action, f, t, wave, breath, crouch, tilt, lift, ears, gaze, left, right, eyes, mouth, step, tail };
}

function face(p, bunny = false) {
  const x1 = bunny ? 83 : 89, x2 = bunny ? 135 : 131, y = bunny ? 113 : 108, ink = bunny ? '#46533d' : '#384149';
  const happy = p.mouth === 'joy', closed = p.eyes < 0.12;
  const eye = x => happy ? path(`M${x - 6} ${y + 2}q6 -9 12 0`, 'none', ink, 3.5)
    : closed ? path(`M${x - 6} ${y}q6 5 12 0`, 'none', ink, 3.2)
      : ellipse(x + p.gaze, y, bunny ? 4.7 : 4, 6.5 * p.eyes, ink)
        + (p.eyes > 0.65 ? ellipse(x + p.gaze + 1, y - 2.4, 1.1, 1.3, '#fffdf4') : '');
  const my = bunny ? 132 : 126;
  let mouth = path(`M103 ${my - 3}q7 8 14 0`, 'none', ink, 2.7);
  if (p.mouth === 'joy') mouth = path(`M103 ${my - 4}Q110 ${my + 11} 117 ${my - 4}Z`, '#9b6763', ink, 1.8);
  if (p.mouth === 'sad') mouth = path(`M104 ${my + 2}q6 -5 12 0`, 'none', ink, 2.5);
  if (['o', 'yawn'].includes(p.mouth)) mouth = ellipse(110, my, p.mouth === 'yawn' ? 6 : 4, p.mouth === 'yawn' ? 8 : 4.7, '#9b6763', ink, 1.8);
  if (p.mouth === 'chew') mouth = path(`M103 ${my}q4 4 7 0q4 4 7 0`, 'none', ink, 2.5);
  if (p.mouth === 'sleep') mouth = path(`M106 ${my}q4 3 8 0`, 'none', ink, 2.2);
  const brows = p.action === 'weak' || p.action === 'dejected' ? path(`M${x1 - 7} ${y - 12}l11 3M${x2 - 4} ${y - 9}l11 -3`, 'none', ink, 2) : '';
  const cheeks = ellipse(bunny ? 62 : 73, bunny ? 128 : 120, bunny ? 11 : 8, bunny ? 6 : 4, '#e99e97', 'none', 0, `opacity="${p.action === 'dejected' ? 0.2 : 0.5}"`)
    + ellipse(bunny ? 156 : 147, bunny ? 128 : 120, bunny ? 11 : 8, bunny ? 6 : 4, '#e99e97', 'none', 0, 'opacity=".5"');
  return `<g data-part="face">${cheeks}${eye(x1)}${eye(x2)}${mouth}${brows}</g>`;
}

function limb(id, side, target, p) {
  const c = palette[id], sx = side === 'left' ? 69 : 151, sy = id === 'mori' || id === 'luna' ? 141 : 143;
  const [x, y] = target;
  const wing = id === 'diandian' || id === 'lili';
  const color = id === 'mianmian' ? '#eddfc6' : c.limb;
  return `<g data-part="${side}-arm">${wing
    ? path(`M${sx} ${sy}Q${n((sx + x) / 2 + (side === 'left' ? -12 : 12))} ${n((sy + y) / 2)} ${x} ${y}Q${n(x + (side === 'left' ? -7 : 7))} ${y + 11} ${sx + (side === 'left' ? 9 : -9)} ${sy + 5}Z`, color, c.edge, 2)
    : path(`M${sx} ${sy}Q${n((sx + x) / 2)} ${n((sy + y) / 2 + 5)} ${x} ${y}`, 'none', color, id === 'fangfang' ? 11 : 13)
      + ellipse(x, y, id === 'fangfang' ? 7 : 8, 7, color, c.edge, 1.7)}</g>`;
}

function feet(id, p) {
  const c = palette[id], y = 179 - p.lift;
  const color = ['mori', 'luna'].includes(id) ? c.skin : id === 'youzi' ? c.edge : id === 'mianmian' ? '#9d8d79' : id === 'diandian' ? '#e1b46c' : '#526976';
  const left = g(`rotate(${n(p.step * 1.3)} 82 ${y})`, ellipse(82 - p.step * 0.6, y - Math.max(0, p.step), id === 'mianmian' ? 7 : 17, id === 'mianmian' ? 11 : 8, color, ['mori', 'luna'].includes(id) ? c.edge : 'none'));
  const right = g(`rotate(${n(-p.step * 1.3)} 137 ${y})`, ellipse(137 + p.step * 0.6, y + Math.min(0, p.step), id === 'mianmian' ? 7 : 17, id === 'mianmian' ? 11 : 8, color, ['mori', 'luna'].includes(id) ? c.edge : 'none'));
  return `<g data-part="feet">${left}${right}</g>`;
}

function body(id, p) {
  const c = palette[id];
  let back = '', head = '', torso = '', front = '';
  if (id === 'mori' || id === 'luna') {
    back = g(`rotate(${n(-p.ears)} 88 78)`, path('M78 73Q58 24 75 17Q92 20 97 72Z', c.skin, c.edge))
      + g(`rotate(${n(p.ears)} 137 78)`, path('M126 69Q131 17 149 20Q160 33 142 81Z', c.skin, c.edge));
    torso = ellipse(110, 125, 70 + p.breath * 0.6, 59 + p.breath * 0.4, c.skin, c.edge, 2.5)
      + ellipse(110, 148, 38, 28, '#fffbed', 'none', 0, 'opacity=".65"');
    head = face(p, true) + g(`rotate(${n(p.wave * 5)} 110 73)`, path('M110 74Q90 48 102 40Q128 40 110 74M110 73Q118 44 136 48Q144 66 110 73', c.accent));
  } else if (id === 'mianmian') {
    back = g(`rotate(${n(-28 - p.ears / 2)} 51 108)`, ellipse(51, 108, 15, 22, '#ece0c7', '#cebfa3'))
      + g(`rotate(${n(28 + p.ears / 2)} 169 108)`, ellipse(169, 108, 15, 22, '#ece0c7', '#cebfa3'));
    torso = path('M54 124Q26 97 53 81Q42 52 76 52Q87 27 110 45Q136 28 148 54Q182 51 171 82Q197 105 169 127Q178 159 147 164Q130 184 111 167Q86 184 72 164Q41 164 54 124Z', c.skin, c.edge, 2)
      + ellipse(110, 116, 52, 43, c.accent);
    head = face(p) + g(`rotate(${n(p.wave * 6)} 110 42)`, path('M103 42q-6-12 7-14q14 1 4 14', 'none', '#d6c8ac', 4));
  } else if (id === 'lili') {
    torso = path('M56 62L54 34L84 51Q110 42 136 51L164 34L164 65Q185 106 166 159Q144 184 110 176Q71 183 53 154Q35 108 56 62Z', c.skin, c.edge, 3)
      + path('M62 86Q76 63 110 83Q147 63 161 88Q164 135 110 163Q56 136 62 86', c.accent)
      + path('M94 148l6 5m9-5 6 5m9-5 6 5', 'none', '#c79870', 3);
    head = face(p) + `<g data-part="glasses" fill="none" stroke="#566b63" stroke-width="3"><circle cx="87" cy="107" r="22"/><circle cx="133" cy="107" r="22"/><path d="M109 102h2"/></g>`
      + path('M103 120l7 10 7-10Z', '#d8a44e');
    if (p.action === 'think') front = g(`rotate(${n(p.wave * 3)} 110 154)`, path('M81 143Q96 139 110 146Q125 139 141 143V164Q126 160 110 167Q95 160 81 164Z', '#f8f0dc', '#8b9f8c', 2) + path('M110 146v21m-21-15h13m-13 5h13m16-5h14m-14 5h14', 'none', '#b5ac95', 1.5));
  } else if (id === 'fangfang') {
    back = `<rect x="39" y="83" width="18" height="34" rx="7" fill="#7f9cac"/><rect x="163" y="83" width="18" height="34" rx="7" fill="#7f9cac"/>`;
    torso = `<rect x="65" y="130" width="90" height="47" rx="17" fill="#95aebe" stroke="#607a8e" stroke-width="3"/><rect x="51" y="48" width="118" height="95" rx="23" fill="${c.skin}" stroke="${c.edge}" stroke-width="3"/><rect x="66" y="74" width="88" height="57" rx="14" fill="${c.accent}"/>`;
    const glow = p.action === 'dejected' ? '#aaa7a0' : p.action === 'weak' ? '#c8b495' : p.action === 'sleep' ? '#9db8ad' : p.f % 3 === 0 ? '#86c9b2' : '#f9cb77';
    head = face(p) + g(`rotate(${n(p.wave * 5)} 110 45)`, path('M110 43V29', 'none', '#738ea3', 6) + ellipse(110, 23, 8, 8, glow));
    front = path('M104 151q6-7 12 0q5 7-6 13q-11-6-6-13Z', p.action === 'weak' || p.action === 'dejected' ? '#c6aaa0' : '#efac99');
  } else if (id === 'youzi') {
    back = g(`rotate(${n(p.tail)} 148 154)`, path('M143 154Q202 174 195 100Q166 112 152 138', '#d68048', '#b96b3c', 3) + path('M183 137q17-15 12-37q-15 6-25 15Z', c.accent));
    torso = ellipse(104, 148, 47, 32, '#e89a58')
      + path('M57 88L49 31Q75 32 88 60Q110 53 131 60Q148 34 171 31L163 87Q179 124 148 141Q110 164 73 141Q42 124 57 88Z', c.skin, c.edge, 3)
      + path('M58 44l7 34 16-13Z M159 44l-7 34-16-13Z', '#ae694b')
      + path('M56 105Q73 92 110 128Q145 92 165 105Q162 145 110 150Q60 145 56 105', c.accent);
    head = face(p) + path('M105 119q5-4 10 0l-5 6Z', '#56433e');
    if (p.action === 'sleep') front = path(`M69 169Q106 ${n(141 + p.breath)} 161 162Q153 183 110 181Q79 181 69 169Z`, '#d68048', '#b96b3c', 2) + path('M69 169Q80 156 100 155L94 177Q80 177 69 169Z', c.accent);
  } else if (id === 'diandian') {
    torso = path('M57 93Q56 42 110 43Q164 42 163 93L169 139Q172 178 110 178Q48 178 51 139Z', c.skin, c.edge, 3)
      + path('M72 85q18-18 38 1q22-19 38-1l8 53q6 32-46 32q-52 0-46-32Z', c.accent);
    head = face(p) + path('M102 120q8-6 16 0l-8 7Z', '#e8b965');
    front = path('M57 137q50 17 105 0v11q-55 17-105 0Z', '#90c7ae')
      + g(`rotate(${n(p.wave * 5)} 140 146)`, path('M134 147v25l15-5-3-22', '#7fbba0'));
  }
  const squash = 1 - p.crouch * 0.24 + p.breath * 0.004;
  const torsoParts = g(`translate(110 180) scale(1 ${n(squash)}) translate(-110 -180)`, back + torso + g(`rotate(${n(p.tilt)} 110 130) translate(0 ${n(p.crouch * 5)})`, head));
  return g(`translate(0 ${n(-p.lift)})`, torsoParts + front);
}

function props(id, p) {
  const isRobot = id === 'fangfang';
  if (p.action === 'eat') {
    const y = n((p.left[1] + p.right[1]) / 2 + 4);
    const foodLeft = Math.max(0, 1 - Math.max(0, p.t - 0.25) / 0.7);
    if (isRobot) return `<g data-part="energy-snack"><rect x="95" y="${y - 16}" width="31" height="25" rx="6" fill="#e7f1dd" stroke="#739880" stroke-width="2.5"/>${path(`M110 ${y - 12}l-6 10h8l-5 8 13-13h-8l5-5Z`, '#e6ba66')}${ellipse(126, y - 3, 2, 5, '#739880')}</g>`;
    return `<g data-part="food-bowl">${path(`M84 ${y - 3}Q87 ${y + 16} 110 ${y + 16}Q133 ${y + 16} 136 ${y - 3}Z`, '#d7e5d6', '#829a88', 2)}${ellipse(110, y - 3, 26, 8, '#f7e8ce', '#9c9d85', 2)}${foodLeft > 0.12 ? ellipse(110, y - 5, 20 * foodLeft, 5 * foodLeft, '#fff9e9') : ''}${path(`M90 ${y + 4}Q110 ${y + 10} 130 ${y + 4}`, 'none', '#afc7b7', 1.5)}</g>`;
  }
  if (p.action === 'play') {
    const x = n(142 + p.wave * 27), y = n(169 - Math.abs(Math.sin(p.t * Math.PI * 2)) * 44);
    return `<g data-part="toy-ball">${ellipse(x, y, 16, 16, '#dfb16d', '#b78b50', 2)}${path(`M${x - 14} ${y - 5}Q${x} ${y + 3} ${x + 14} ${y + 5}M${x - 3} ${y - 15}Q${x + 7} ${y} ${x + 3} ${y + 15}`, 'none', '#faf0d6', 3)}${ellipse(x - 5, y - 7, 3, 2, '#fff6df')}</g>`;
  }
  if (p.action === 'hungry') return `<g data-part="stomach-ripple" opacity="${p.f % 2 ? '.7' : '.35'}">${path('M101 151q-5 4 0 8m15-8q5 4 0 8', 'none', '#a29a7d', 1.8)}</g>`;
  return '';
}

function effects(p) {
  if (p.action === 'sleep') {
    const x = 171 + p.f * 1.4, y = 67 - p.f * 2;
    // 用路径绘制睡眠符号，避免平台字体差异。
    return `<g data-part="sleep-mark" opacity="${n(0.4 + p.breath * 0.5)}">${path(`M${x} ${y}h8l-8 8h8m3-22h12l-12 12h12`, 'none', '#81988d', 2.5)}</g>`;
  }
  if (p.action === 'happy' || p.action === 'recover' || p.action === 'greet') {
    const size = n(3 + p.breath * 3);
    return `<g data-part="sparkle" opacity="${n(0.3 + p.breath * 0.6)}">${path(`M28 87v${size * 2}m-${size} -${size}h${size * 2}m154-23v${size * 2}m-${size} -${size}h${size * 2}`, 'none', '#d5ae61', 2.5)}</g>`;
  }
  if (p.action === 'think') return `<g data-part="thought">${ellipse(176, 71, 3, 3, '#c1d5c6')}${ellipse(184, 59, 5, 5, '#c1d5c6')}${ellipse(192, 43, 7 + p.breath, 7 + p.breath, '#c1d5c6')}</g>`;
  return '';
}

function draw(id, action, frame) {
  const p = pose(action, frame);
  // 脚部始终位于画布下缘的固定基准；每个部位单独变化，阴影不跟随表情漂移。
  const content = feet(id, p) + body(id, p) + limb(id, 'left', p.left, p) + limb(id, 'right', p.right, p) + props(id, p);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="205" viewBox="0 0 220 205" role="img" aria-label="${id} ${action} frame ${frame}"><title>${id} ${action}</title>${ellipse(110, 191, 61 + p.crouch * 4, 6, '#263e3c', 'none', 0, 'opacity=".12"')}${content}${effects(p)}</svg>\n`;
}

await mkdir(reportRoot, { recursive: true });
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), width: 220, height: 205, anchor: [110, 187], characterCount: ids.length, actionCount: Object.keys(clips).length, characters: [], limitations: ['真实 Windows 和 Android 宿主动画验收由主任务完成；此记录只覆盖资产和浏览器回放。'] };
for (const id of ids) {
  const directory = join(root, 'characters', id);
  const manifest = JSON.parse(await readFile(join(directory, 'character.json'), 'utf8'));
  const frames = {}, hashes = {};
  for (const [action, timings] of Object.entries(clips)) {
    frames[action] = [];
    hashes[action] = [];
    for (let frame = 0; frame < timings.length; frame++) {
      const filename = `${action}-${frame}.svg`, svg = draw(id, action, frame);
      frames[action].push(filename);
      hashes[action].push(createHash('sha256').update(svg).digest('hex'));
      await writeFile(join(directory, filename), svg, 'utf8');
    }
  }
  manifest.license = 'Project-original artwork';
  if (id === 'luna') manifest.description = '一只安静柔软的月色小伙伴。';
  manifest.actions = Object.keys(clips);
  manifest.representations.sprite = { fps: 6, frames, timings: clips, loops: Object.fromEntries(Object.keys(clips).map(a => [a, !once.has(a)])), size: [220, 205], anchor: [110, 187] };
  manifest.artwork = { version: '2.0.0', source: 'Project-original vector character rigs', generator: 'scripts/build-existing-pet-animations.mjs' };
  await writeFile(join(directory, 'character.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  report.characters.push({ id, name: manifest.name, frames: Object.values(frames).reduce((sum, list) => sum + list.length, 0), hashes });
}

// 预览独立于应用与用户数据，只读角色资源，支持暂停、动作选择和逐帧检查。
const names = Object.fromEntries(report.characters.map(c => [c.id, c.name]));
const preview = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>灵伴既有角色动画回放</title><style>body{margin:0;padding:24px;font:15px system-ui;background:#f7f5ed;color:#31433d}h1{font-size:22px}header{display:flex;gap:16px;align-items:center;flex-wrap:wrap}button,select{font:inherit;padding:8px 12px;border:1px solid #a9b9a5;border-radius:8px;background:#fffdf4}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;margin-top:22px}article{background:#fffdf8;border:1px solid #dedfce;border-radius:16px;text-align:center;padding:16px}img{width:220px;height:205px;max-width:100%;object-fit:contain}small{display:block;color:#63796b;margin:8px}</style><header><h1>七位伙伴 · 15 类动作回放</h1><select id="action" aria-label="动作">${Object.keys(clips).map(a => `<option value="${a}">${labels[a]} · ${a}</option>`).join('')}</select><button id="pause">暂停</button><button id="next">下一帧</button><span id="time"></span></header><main class="grid">${ids.map(id => `<article><h2>${names[id]}</h2><img id="${id}" alt="${names[id]}动画"><small id="${id}-info"></small></article>`).join('')}</main><script>const ids=${JSON.stringify(ids)}, clips=${JSON.stringify(clips)};let action='idle',index=0,playing=true,timer;const selector=document.querySelector('#action');function draw(){for(const id of ids){document.getElementById(id).src='../../characters/'+id+'/'+action+'-'+index+'.svg';document.getElementById(id+'-info').textContent='第 '+(index+1)+' / '+clips[action].length+' 帧 · '+clips[action][index]+' ms';}document.querySelector('#time').textContent='总时长 '+clips[action].reduce((a,b)=>a+b,0)+' ms';}function advance(){index=(index+1)%clips[action].length;draw();schedule()}function schedule(){clearTimeout(timer);if(playing&&!document.hidden)timer=setTimeout(advance,clips[action][index]);}selector.onchange=()=>{action=selector.value;index=0;draw();schedule()};document.querySelector('#pause').onclick=()=>{playing=!playing;document.querySelector('#pause').textContent=playing?'暂停':'播放';schedule()};document.querySelector('#next').onclick=()=>{playing=false;document.querySelector('#pause').textContent='播放';advance()};document.addEventListener('visibilitychange',schedule);draw();schedule();</script></html>`;
await writeFile(join(reportRoot, 'preview.html'), preview, 'utf8');
const matrix = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>灵伴七角色完整动作矩阵</title><style>body{margin:0;padding:24px;font:14px system-ui;background:#f7f5ed;color:#31433d}h1{font-size:22px;margin:0 0 20px}table{border-collapse:collapse;background:#fffdf8}th,td{border:1px solid #dde1d3;text-align:center;padding:8px}th{font-size:13px}td img{display:block;width:104px;height:97px}th:first-child{min-width:70px}small{font-weight:normal;color:#718172;display:block}</style><h1>灵伴 · 七个现有角色的完整动作矩阵</h1><table><thead><tr><th>角色</th>${Object.keys(clips).map(a => `<th>${labels[a]}<small>${a}</small></th>`).join('')}</tr></thead><tbody>${ids.map(id => `<tr><th>${names[id]}</th>${Object.keys(clips).map(a => `<td><img src="../../characters/${id}/${a}-${Math.floor(clips[a].length / 2)}.svg" alt="${names[id]} ${labels[a]}"><small>${clips[a].length} 帧</small></td>`).join('')}</tr>`).join('')}</tbody></table></html>`;
await writeFile(join(reportRoot, 'matrix.html'), matrix, 'utf8');
await writeFile(join(reportRoot, 'asset-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ characters: ids.length, actionsPerCharacter: Object.keys(clips).length, totalFrames: report.characters.reduce((sum, c) => sum + c.frames, 0), preview: relative(root, join(reportRoot, 'preview.html')) }));
