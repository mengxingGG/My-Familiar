import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import electron from "electron";
if (!existsSync("dist/runtime.cjs")) {
  console.error("请先运行 npm run build");
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [".", ...(process.argv[2] === "controller" ? ["--controller"] : [])],
  { stdio: "inherit", windowsHide: true, env },
);
child.on("exit", (code) => process.exit(code ?? 1));
