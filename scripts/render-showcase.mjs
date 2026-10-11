import { _electron as electron } from "playwright/test";
import electronPath from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 使用未修改的应用截图和仓库原始角色素材排版；背景与说明文字不属于产品界面。
export async function renderShowcase(source) {
  const { version } = JSON.parse(
    await readFile(resolve("package.json"), "utf8"),
  );
  const output = resolve("docs/images");
  await mkdir(output, { recursive: true });
  const { shots } = JSON.parse(
    await readFile(join(source, "capture.json"), "utf8"),
  );
  const image = async (file, type = "png") =>
    `data:image/${type};base64,${(await readFile(file)).toString("base64")}`;
  const scene = async (shot, width, height, sharedSize) => {
    const scale = Math.min(
      width / (sharedSize?.width || shot.width),
      height / (sharedSize?.height || shot.height),
    );
    const offsetX = (width - shot.width * scale) / 2;
    const offsetY = sharedSize
      ? height - shot.height * scale
      : (height - shot.height * scale) / 2;
    return `<div class="scene" style="width:${width}px;height:${height}px">${(await Promise.all(shot.parts.map(async (part) => `<img alt="实际应用窗口" src="${await image(join(source, part.file))}" style="left:${offsetX + part.x * scale}px;top:${offsetY + part.y * scale}px;width:${part.width * scale}px;height:${part.height * scale}px">`))).join("")}</div>`;
  };
  const css = `
    *{box-sizing:border-box}body{margin:0;color:#293d34;background:#f7f4ec;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;-webkit-font-smoothing:antialiased}
    .board{position:relative;overflow:hidden;padding:64px 72px;width:1600px;background:radial-gradient(ellipse at 95% 8%,#e5eacb 0,transparent 43%),#f7f4ec}
    .brand{display:flex;align-items:center;gap:15px;font-size:29px;font-weight:650;letter-spacing:.5px}.mark{display:grid;place-items:center;background:#3e5945;color:#fffdf2;width:47px;height:47px;border-radius:15px;font-family:Georgia,serif;font-size:36px;font-weight:500;padding-bottom:5px}
    .meta{position:absolute;right:72px;top:77px;color:#727d6a;font-size:16px;letter-spacing:2px}.kicker{font-size:16px;letter-spacing:3px;color:#758569;font-weight:650}
    h1,h2,p{margin:0}h2{font-size:46px;font-weight:650;line-height:1.45;letter-spacing:-1px}.sub{font-size:22px;color:#71806c;line-height:1.8}.scene{position:relative}.scene img{position:absolute}.footer{position:absolute;bottom:30px;left:72px;right:72px;display:flex;justify-content:space-between;font-size:15px;color:#7f8577;letter-spacing:.5px}.dot-grid{background-image:radial-gradient(#c4cbb4 1px,transparent 1px);background-size:22px 22px}
    .chip{display:inline-flex;border:1px solid #d5ddcb;border-radius:30px;padding:9px 18px;background:#f9f9f0;color:#566c50;font-size:17px;align-items:center;gap:8px}.dot{width:7px;height:7px;background:#8a9c6e;border-radius:50%}.frame{border:1px solid #e1e3d7;border-radius:22px;overflow:hidden;box-shadow:0 20px 55px #31402b13;background:#f7f5f0}.frame img{display:block;width:100%}.window-bar{height:43px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;background:#eeeFE6;color:#75816e;font-size:14px;letter-spacing:.4px;border-bottom:1px solid #e1e3d7}.window-dots{display:flex;gap:7px}.window-dots i{display:block;width:8px;height:8px;border-radius:50%;background:#cad1c1}
  `;
  const foot = (detail) =>
    `<div class="footer"><span>FAMILIAR · 灵伴</span><span>${detail} · v${version} / 演示数据</span></div>`;
  const brand = `<div class="brand"><span class="mark">f.</span> Familiar <span style="font-weight:400;color:#7d8974">/ 灵伴</span></div>`;
  const frame = (src, title) =>
    `<div class="frame"><div class="window-bar"><span>${title}</span><span class="window-dots"><i></i><i></i><i></i></span></div><img src="${src}"></div>`;
  const pages = [];
  const interactionSize = {
    width: Math.max(shots.speech.width, shots.composer.width),
    height: Math.max(shots.speech.height, shots.composer.height),
  };
  pages.push({
    file: "cover.png",
    height: 900,
    html: `
    <div class="board" style="height:900px">${brand}<span class="meta">A LITTLE COMPANY, EVERY DAY</span>
      <div style="position:absolute;left:72px;top:190px;width:670px">
        <div class="chip"><span class="dot"></span> Windows 桌面伙伴</div>
        <h1 style="font-size:80px;line-height:1.25;letter-spacing:-3px;font-weight:650;margin:26px 0">让桌面，<br>多一点<span style="color:#7b925f">陪伴。</span></h1>
        <p style="font-size:24px;line-height:1.85;color:#6f7c69">在头顶接住你的一句话，<br>把平凡日子里的小事，慢慢记在心里。</p>
        <div style="display:flex;gap:26px;margin-top:38px;font-size:18px;color:#4f684d"><span>气泡对话</span><span style="color:#bec8b3">/</span><span>叫名字语音聊天</span><span style="color:#bec8b3">/</span><span>形象与性格</span><span style="color:#bec8b3">/</span><span>分层记忆</span></div>
      </div>
      <div class="dot-grid" style="position:absolute;right:65px;top:185px;width:695px;height:570px;border:1px solid #dce2ce;border-radius:210px 210px 40px 40px;background-color:#ebefdf">
        <div style="position:absolute;left:30px;top:28px">${await scene(shots.speech, 635, 525)}</div>
      </div>
      <div style="position:absolute;right:102px;top:143px;transform:rotate(6deg);background:#fffaf0;border:1px solid #e4ddc9;border-radius:15px;padding:13px 20px;font-size:18px;color:#8d795b;box-shadow:0 5px 14px #5e69330a">今天也在这里。</div>
      <div style="position:absolute;left:72px;bottom:96px;border-top:1px solid #dce0d2;padding-top:22px;width:610px;display:flex;gap:38px;font-size:16px;color:#75816c"><span>7 种模型接入</span><span>Skills + MCP</span><span>关闭设置，陪伴继续</span></div>
      ${foot("真实应用窗口组合展示")}
    </div>`,
  });
  pages.push({
    file: "conversation.png",
    height: 980,
    html: `
    <div class="board" style="height:980px">
      <div class="kicker">SAY A LITTLE. STAY A WHILE.</div><h2 style="margin-top:12px">说话和倾听，都在它的头顶。</h2>
      <p class="sub" style="margin-top:9px">双击宠物唤出输入，发送后在同一位置看见回复。</p>
      <div style="display:flex;gap:28px;margin-top:30px">
        ${await Promise.all(
          [
            [
              "01",
              "写下想说的话",
              "Enter 换行，点击发送或 Shift + Enter 发送。",
              shots.composer,
            ],
            [
              "02",
              "听它慢慢说",
              "回复默认 15 秒收起，也可以调整停留时间。",
              shots.speech,
            ],
          ].map(
            async ([n, title, subtitle, shot]) =>
              `<div style="width:714px;height:593px;border:1px solid #e0e4d5;border-radius:28px;background:#fdfbf5;padding:25px 26px"><div style="display:flex;gap:15px;align-items:center"><span style="font:20px Georgia;color:#899c71">${n}</span><b style="font-size:24px;font-weight:600">${title}</b></div><p style="font-size:17px;color:#7b8472;margin:9px 0 6px">${subtitle}</p>${await scene(shot, 660, 464, interactionSize)}</div>`,
          ),
        ).then((parts) => parts.join(""))}
      </div>
      <div style="position:absolute;bottom:80px;left:72px;font-size:18px;color:#647658">Ctrl + Alt + Space 随时输入 <span style="margin:0 25px;color:#c1cbb7">·</span> Esc 收起并保留草稿</div>
      ${foot("气泡与宠物按实际窗口位置组合")}
    </div>`,
  });
  const characters = [];
  for (const id of [
    "mori",
    "luna",
    "mianmian",
    "lili",
    "fangfang",
    "youzi",
    "diandian",
  ]) {
    const dir = resolve("characters", id);
    const c = JSON.parse(await readFile(join(dir, "character.json"), "utf8"));
    const persona = {
      gentle: "温柔",
      thorough: "细致",
      direct: "直白",
      enthusiastic: "热情",
      concise: "简洁",
    }[c.recommendedPersona];
    characters.push(
      `<div style="text-align:center;width:196px;background:#fffdf5;border:1px solid #e4e7da;border-radius:80px 80px 24px 24px;padding:12px 8px 22px"><img style="width:174px;height:196px;object-fit:contain" src="${await image(join(dir, "idle-0.svg"), "svg+xml")}"><div style="font-size:24px;font-weight:650">${c.name}</div><div style="font-size:16px;color:#839176;margin-top:6px">${persona || "温柔"}</div></div>`,
    );
  }
  pages.push({
    file: "characters.png",
    height: 670,
    html: `<div class="board" style="height:670px"><div class="kicker">MEET YOUR FAMILIAR</div><h2 style="margin-top:10px">喜欢它的样子，也喜欢它的脾气。</h2><p class="sub" style="margin-top:10px">7 位小伙伴 · 5 种性格，可跟随形象，也能自由搭配。</p><div style="display:flex;gap:14px;margin-top:34px">${characters.join("")}</div><div style="position:absolute;bottom:78px;left:72px;font-size:17px;color:#6a7b5f">图中标签为推荐性格；固定选择性格后，更换形象不会覆盖它。</div>${foot("仓库原创角色素材")}</div>`,
  });
  const frameTitles = {
    controller: "Familiar / 形象与桌面",
    models: "Familiar / 模型连接",
    memory: "Familiar / 记忆与日记 · 编辑区域",
    voice: "Familiar / 图片与语音",
  };
  for (const [name, title, subtitle] of [
    [
      "controller",
      "大小、形象，随手调到喜欢。",
      "修改即生效，自动保存。关闭控制器后，宠物继续独立运行。",
    ],
    [
      "models",
      "选一颗合适的脑袋，开始聊天。",
      "7 种模型接入 · 自动获取模型列表 · 可调生成参数与上下文预算",
    ],
    [
      "memory",
      "把重要的小事，留在记忆里。",
      "核心规则随身带着，日记、教训和项目约定按需翻看，都是你能编辑的文件。",
    ],
    [
      "voice",
      "叫一声名字，就接上话。",
      "本机唤醒 · 连续语音与插话打断 · 宠物自己的原创声音；文字输入一直都在。",
    ],
  ]) {
    const png = await readFile(join(source, `${name}.png`));
    // 整张图不超过 1500 像素高：截图偏长时收窄展示框，避免渲染窗口高度受限而截断。
    const frameWidth = Math.min(
      name === "memory" ? 1456 : 1390,
      Math.floor(
        ((1500 - 246 - 43 - 100) * png.readUInt32BE(16)) /
          png.readUInt32BE(20),
      ),
    );
    const height =
      Math.ceil(
        (246 +
          43 +
          (frameWidth * png.readUInt32BE(20)) / png.readUInt32BE(16) +
          100) /
          10,
      ) * 10;
    const src = await image(join(source, `${name}.png`));
    pages.push({
      file: `${name}.png`,
      height,
      html: `<div class="board" style="height:${height}px"><div class="kicker">${{ memory: "LITTLE THINGS, WELL REMEMBERED", voice: "JUST CALL ITS NAME" }[name] ?? "MAKE IT YOURS"}</div><h2 style="margin-top:10px">${title}</h2><p class="sub" style="margin-top:9px">${subtitle}</p><div style="margin:34px auto 0;width:${frameWidth}px">${frame(src, frameTitles[name])}</div>${foot(name === "memory" ? "真实记忆编辑区域截图" : "真实控制器截图")}</div>`,
    });
  }
  // 用随项目安装的 Electron 排版，不依赖另外下载的浏览器；固定 1 倍缩放，输出 1600 像素宽。
  const host = await electron.launch({
    executablePath: electronPath,
    args: [resolve("scripts/showcase-host.cjs"), "--force-device-scale-factor=1"],
  });
  const manifest = [];
  try {
    for (const item of pages) {
      const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>${css}</style><body>${item.html}</body></html>`,
        file = join(source, item.file.replace(".png", ".html"));
      await writeFile(file, html);
      const png = await host.evaluate(
        async ({ BrowserWindow }, { file, height }) => {
          const win = new BrowserWindow({
            show: false,
            width: 1600,
            height,
            useContentSize: true,
            enableLargerThanScreen: true,
            // 离屏渲染不受屏幕高度限制，长图也能完整输出。
            webPreferences: { offscreen: true },
          });
          try {
            await win.loadFile(file);
            await win.webContents.executeJavaScript(
              "document.fonts.ready.then(() => Promise.all([...document.images].map((img) => img.decode())))",
            );
            await new Promise((r) => setTimeout(r, 200));
            const image = await win.webContents.capturePage({
              x: 0,
              y: 0,
              width: 1600,
              height,
            });
            const size = image.getSize();
            return (
              size.width === 1600 ? image : image.resize({ width: 1600, quality: "best" })
            )
              .toPNG()
              .toString("base64");
          } finally {
            win.destroy();
          }
        },
        { file, height: item.height },
      );
      await writeFile(join(output, item.file), Buffer.from(png, "base64"));
      manifest.push({ file: item.file, width: 1600, height: item.height });
    }
  } finally {
    await host.close();
  }
  await writeFile(
    join(source, "published.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(`已生成 ${manifest.length} 张展示图：${output}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2])
    throw new Error(
      "用法：node scripts/render-showcase.mjs .artifacts/showcase-时间戳",
    );
  await renderShowcase(resolve(process.argv[2]));
}
