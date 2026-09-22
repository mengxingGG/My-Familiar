import { resolve } from "node:path";
import {
  installDependency,
  startCli,
  cliEnvironment,
  dependencies,
  exists,
} from "../plugins/cli-dependencies/index.ts";
import { mkdir, writeFile } from "node:fs/promises";
import assert from 'node:assert/strict';
const root = resolve(".artifacts/integration-cli-check");
const report = [];
await mkdir(root, { recursive: true });
for (const kind of ["feishu", "github"]) {
  const bin = resolve(root, kind, "bin");
  const exe = resolve(bin, dependencies[kind].executable);
  if (!(await exists(exe)))
    await installDependency(
      kind,
      bin,
      AbortSignal.timeout(660000),
      console.log,
    );
  const env = cliEnvironment({
    LARKSUITE_CLI_CONFIG_DIR: resolve(root, "feishu", "config"),
    GH_CONFIG_DIR: resolve(root, "github", "config"),
  });
  const commands =
    kind === "feishu"
      ? [
          ["--version"],
          ["config", "init", "--help"],
          ["im", "+messages-reply", "--help"],
          ["calendar", "+agenda", "--help"],
          ["skills", "read", "lark-shared"],
          ["event", "schema", "im.message.receive_v1", "--json"],
        ]
      : [["--version"], ["auth", "login", "--help"]];
  for (const args of commands) {
    const r = await startCli(exe, args, {
      cwd: root,
      env,
      signal: AbortSignal.timeout(30000),
    }).done;
    assert.equal(r.code, 0, kind + ' ' + args.join(' ') + ': ' + r.errors);
    if (args.includes('+messages-reply')) assert.match(r.output, /--idempotency-key/);
    report.push({ kind, args, ...r });
    console.log('PASS:', kind, args.join(' '));
  }
}
await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
