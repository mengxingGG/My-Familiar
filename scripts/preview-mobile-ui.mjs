import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { buildMobileUi } from "./build-mobile-ui.mjs";

const root = await realpath(
  await buildMobileUi({ preview: !process.argv.includes("--production") }),
);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
const server = createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405);
    response.end();
    return;
  }
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);
    const file = await realpath(
      resolve(root, `.${path === "/" ? "/index.html" : path}`),
    );
    if (!file.startsWith(root + sep) || !Object.hasOwn(mime, extname(file)))
      throw new Error("Not found");
    const bytes = await readFile(file);
    response.writeHead(200, {
      "Content-Type": mime[extname(file)],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
const port = Number(process.env.FAMILIAR_MOBILE_PORT || 4173);
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Familiar mobile ${process.argv.includes("--production") ? "host check" : "preview"}: http://127.0.0.1:${server.address().port}`,
  ),
);
