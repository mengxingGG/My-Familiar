// 用项目自带的 Electron 渲染矢量源，无需字体或额外图像依赖。
const { app, BrowserWindow } = require("electron");
const { readFile, writeFile, mkdtemp, rm } = require("node:fs/promises");
const { join, resolve, dirname, basename } = require("node:path");
const { tmpdir } = require("node:os");
let window,
  temporary,
  exitCode = 0;
async function main() {
  temporary = await mkdtemp(join(tmpdir(), "familiar-icons-"));
  app.setPath("userData", temporary);
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  await window.loadURL("about:blank");
  const source = await readFile(resolve("assets/familiar.svg"));
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const encoded = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = "data:image/svg+xml;base64,${source.toString("base64")}";
    await image.decode();
    return ${JSON.stringify(sizes)}.map(size => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, size, size);
      return canvas.toDataURL("image/png").split(",")[1];
    });
  })()`);
  const images = encoded.map((value) => Buffer.from(value, "base64"));
  // ICO 目录指向各自原生尺寸的 PNG，避免只放大一张 16 像素位图。
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let i = 0; i < sizes.length; i++) {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = sizes[i] === 256 ? 0 : sizes[i];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  }
  await writeFile(
    resolve("assets/familiar.ico"),
    Buffer.concat([header, ...images]),
  );
  await writeFile(resolve("assets/familiar.png"), images.at(-1));
  console.log("Familiar 图标已生成：" + sizes.join(" / ") + " px");
}
main()
  .catch((error) => {
    console.error(error.message);
    exitCode = 1;
  })
  .finally(async () => {
    window?.destroy();
    if (
      temporary &&
      dirname(resolve(temporary)) === resolve(tmpdir()) &&
      basename(temporary).startsWith("familiar-icons-")
    )
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    app.exit(exitCode);
  });
