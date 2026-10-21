import type { UpdatePlatform } from "../../packages/contracts/updates.ts";
export const RELEASE_ENDPOINT = "https://api.github.com/repos/mengxingGG/My-Familiar/releases/latest";
export interface ReleaseAsset { version: string; name: string; url: string; bytes: number; sha256: string; }
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(left: string, right: string): number {
  if (!version.test(left) || !version.test(right)) throw new Error("版本号无效");
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  if (![...a, ...b].every(Number.isSafeInteger)) throw new Error("版本号无效");
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function selectRelease(value: unknown, platform: UpdatePlatform): ReleaseAsset {
  const r = value as any;
  if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(r.tag_name)) throw new Error("未找到可用正式版");
  const v = r.tag_name.slice(1); compareVersions(v, v);
  const name = platform === 'android-arm64' ? `Familiar-${v}-arm64.apk` : `Familiar-${v}-Setup-x64.exe`;
  const rows = Array.isArray(r.assets) ? r.assets.filter((a: any) => a.name === name) : [];
  if (rows.length !== 1) throw new Error("正式版尚未提供当前系统安装包，请稍后重试");
  const asset = rows[0], url = `https://github.com/mengxingGG/My-Familiar/releases/download/v${v}/${name}`;
  if (asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 1024 ** 3 || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) throw new Error("安装包资料不完整，请稍后重试");
  return { version: v, name, url, bytes: asset.size, sha256: asset.digest.slice(7).toLowerCase() };
}
