import test from "node:test";
import assert from "node:assert/strict";
import {readFile, mkdtemp, writeFile, rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn} from "node:child_process";
import {validateOfficeArgs} from "../plugins/feishu-cli/validation.ts";
import {managedFeishuRunner} from "../plugins/feishu-android/runner.ts";

type Case = {name: string; unit: string; repeat: number; suffix: string; utf16Units: number; accepted: boolean};
const cases: Case[] = JSON.parse(await readFile(new URL("../plugins/feishu-android/cli/policy_cases_test.json", import.meta.url), "utf8"));
const valueOf = (c: Case) => c.unit.repeat(c.repeat) + c.suffix;

test("桌面与 Android 飞书共用中文、表情和组合字符的 UTF-16 参数边界", () => {
  for (const c of cases) {
    const value = valueOf(c), args = ["docs", "+create", "--content", value];
    assert.equal(value.length, c.utf16Units, c.name);
    if (c.accepted) assert.deepEqual(validateOfficeArgs(args), args, c.name);
    else assert.throws(() => validateOfficeArgs(args), c.name);
  }
});

test("Android 飞书管道完整保留边界 Unicode，超长与总字节超限不启动子进程", async () => {
  const root = await mkdtemp(join(tmpdir(), "familiar-office-unicode-"));
  try {
    const fixture = join(root, "input.cjs");
    await writeFile(fixture, `let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c).on('end',()=>{const r=JSON.parse(raw),v=r.args.at(-1);console.log(JSON.stringify({units:v.length,bytes:Buffer.byteLength(v),sha256:require('node:crypto').createHash('sha256').update(v).digest('hex')}));});`);
    let launches = 0;
    const run = managedFeishuRunner({executable:join(root,"libfamiliar_lark.so"),workspace:join(root,"work"),configuration:join(root,"config"),temporary:join(root,"tmp"),
      launch(_executable, options) { launches++; return spawn(process.execPath,[fixture],{...options,stdio:"pipe"}); }});
    const base = {appId:"",identity:"user" as const};
    for (const c of cases) {
      const value=valueOf(c), args=["docs","+create","--content",value];
      if (!c.accepted) { const before=launches; assert.throws(()=>run({...base,args},new AbortController().signal),c.name); assert.equal(launches,before); continue; }
      const result=await run({...base,args},new AbortController().signal);assert.equal(result.code,0,c.name);assert.equal(result.interrupted,undefined,c.name);
      assert.deepEqual(JSON.parse(result.output),{units:c.utf16Units,bytes:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')},c.name);
    }
    const before=launches, long="中".repeat(32000);
    assert.throws(()=>run({...base,args:["docs","+create","--title",long,"--content",long]},new AbortController().signal),/INVALID_INPUT/);
    assert.equal(launches,before,"总请求仍受 128 KiB 字节限制，不能拆分绕过或启动执行器");
  } finally { await rm(root,{recursive:true,force:true}); }
});
