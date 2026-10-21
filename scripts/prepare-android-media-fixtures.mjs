import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
const root = ".artifacts/android-media-fixtures";
await mkdir(root, { recursive: true });
await writeFile(`${root}/familiar-media-note.txt`, "本地附件验收：海边有七颗绿色石头。MEDIA_NOTE_20261019");
await writeFile(`${root}/familiar-media-oversize.txt`, Buffer.alloc(400001, 65));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 900;
    const ctx = canvas.getContext("2d"), pixels = ctx.createImageData(900, 900);
    let seed = 112233;
    for (let i = 0; i < pixels.data.length; i += 4) {
      for (let j = 0; j < 3; j++) { seed = (1664525 * seed + 1013904223) >>> 0; pixels.data[i + j] = seed >>> 24; }
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0); return canvas.toDataURL("image/png").split(",")[1];
  });
  const bytes = Buffer.from(image, "base64");
  await writeFile(`${root}/familiar-media-large.png`, bytes);
  console.log(JSON.stringify({ imageBytes: bytes.length }));
} finally { await browser.close(); }
