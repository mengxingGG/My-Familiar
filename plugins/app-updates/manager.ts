import { mkdir, open, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AppUpdates, UpdatePlatform, UpdateState } from '../../packages/contracts/updates.ts';
import { compareVersions, RELEASE_ENDPOINT, selectRelease, type ReleaseAsset } from './release.ts';

export interface UpdateOptions {
  currentVersion: string;
  platform: UpdatePlatform;
  directory: string;
  open: (path: string, asset: ReleaseAsset) => Promise<void>;
  notify?: (state: UpdateState) => void | Promise<void>;
  fetch?: typeof fetch;
}
/** 只处理公开发行信息；不读取模型配置，也不向模型暴露安装命令。 */
export class UpdateManager implements AppUpdates {
  private value: UpdateState;
  private asset?: ReleaseAsset;
  private checking?: Promise<UpdateState>;
  private transfer?: AbortController;
  private job?: Promise<void>;
  private disposed = false;
  private lastNotify = 0;
  constructor(private options: UpdateOptions, private persist: (release: unknown) => Promise<void>) {
    compareVersions(options.currentVersion, options.currentVersion);
    this.value = {currentVersion: options.currentVersion, platform: options.platform, phase: 'idle', latestVersion: null, assetName: null, downloadedBytes: 0, totalBytes: 0, checkedAt: null, error: null};
  }
  state(): UpdateState { return {...this.value}; }
  private publish(patch: Partial<UpdateState>, progress = false) {
    Object.assign(this.value, patch);
    if (this.disposed || progress && Date.now() - this.lastNotify < 500) return;
    this.lastNotify = Date.now();
    void Promise.resolve(this.options.notify?.(this.state())).catch(() => {});
  }
  private path() { if (!this.asset) throw new Error('请先检查更新'); return join(this.options.directory, this.asset.name); }
  private async verified(path: string, asset: ReleaseAsset) {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(path)) { bytes += chunk.length; if (bytes > asset.bytes) return false; hash.update(chunk); }
    return bytes === asset.bytes && hash.digest('hex') === asset.sha256;
  }
  async restore(saved: unknown) {
    try {
      const asset = saved as ReleaseAsset;
      const valid = selectRelease({tag_name: 'v' + asset.version, assets: [{name: asset.name, browser_download_url: asset.url, size: asset.bytes, digest: 'sha256:' + asset.sha256}]}, this.options.platform);
      if (compareVersions(valid.version, this.options.currentVersion) <= 0) return;
      this.asset = valid;
      let ready = false; try { ready = await this.verified(this.path(), valid); } catch {}
      this.publish({phase: ready ? 'ready' : 'available', latestVersion: valid.version, assetName: valid.name, totalBytes: valid.bytes, downloadedBytes: ready ? valid.bytes : 0});
    } catch { /* 旧缓存损坏不影响启动，下一次重新查询。 */ }
  }
  check(): Promise<UpdateState> {
    if (this.disposed || this.transfer) return Promise.resolve(this.state());
    if (this.checking) return this.checking;
    this.checking = this.checkNow().finally(() => {this.checking = undefined;});
    return this.checking;
  }
  private async checkNow(): Promise<UpdateState> {
    const prior = this.value.phase;
    this.publish({phase: 'checking', error: null});
    try {
      const response = await (this.options.fetch ?? fetch)(RELEASE_ENDPOINT, {headers: {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Familiar-Update/' + this.options.currentVersion}, signal: AbortSignal.timeout(20000)});
      if (!response.ok || !response.body) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub 检查暂时受限，请稍后重试' : '暂时无法连接 GitHub，请稍后重试');
      let text = ''; const reader = response.body.getReader();
      try { while (true) {const {done, value} = await reader.read(); if (done) break; text += new TextDecoder().decode(value); if (text.length > 1024 * 1024) throw new Error('发行信息过大');} } finally {await reader.cancel().catch(() => {});}
      const asset = selectRelease(JSON.parse(text), this.options.platform);
      if (compareVersions(asset.version, this.options.currentVersion) <= 0) {
        this.asset = undefined; await this.persist(null);
        this.publish({phase: 'current', latestVersion: asset.version, assetName: null, totalBytes: 0, downloadedBytes: 0, checkedAt: Date.now()});
      } else {
        const same = this.asset?.sha256 === asset.sha256 && this.asset?.name === asset.name;
        this.asset = asset; await this.persist(asset);
        let ready = false; if (same && prior === 'ready') {try {ready = await this.verified(this.path(), asset);} catch {}}
        this.publish({phase: ready ? 'ready' : 'available', latestVersion: asset.version, assetName: asset.name, totalBytes: asset.bytes, downloadedBytes: ready ? asset.bytes : 0, checkedAt: Date.now()});
      }
    } catch (error) {
      this.publish({phase: this.asset ? prior === 'ready' ? 'ready' : 'available' : 'error', error: error instanceof Error && /正式版|安装包|GitHub|发行信息/.test(error.message) ? error.message : '检查更新失败，请稍后重试'});
    }
    return this.state();
  }
  download(): UpdateState {
    if (this.disposed || this.transfer || this.checking || this.value.phase === 'ready') return this.state();
    if (!this.asset) throw new Error('请先检查更新');
    const asset = {...this.asset}, controller = new AbortController(); this.transfer = controller;
    this.publish({phase: 'downloading', downloadedBytes: 0, error: null});
    this.job = this.downloadNow(asset, controller).finally(() => {this.transfer = undefined; this.job = undefined;});
    return this.state();
  }
  private async downloadNow(asset: ReleaseAsset, controller: AbortController) {
    const path = this.path(), part = path + '.part';
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(this.options.directory, {recursive: true});
      file = await open(part, 'w', 0o600);
      const response = await (this.options.fetch ?? fetch)(asset.url, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60 * 1000)]), headers: {'User-Agent': 'Familiar-Update/' + this.options.currentVersion}});
      if (!response.ok || !response.body) throw new Error('DOWNLOAD');
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
        controller.signal.throwIfAborted(); bytes += chunk.length;
        if (bytes > asset.bytes) throw new Error('SIZE');
        hash.update(chunk); await file.writeFile(chunk);
        this.publish({downloadedBytes: bytes}, true);
      }
      if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('INTEGRITY');
      await file.sync(); await file.close(); file = undefined;
      controller.signal.throwIfAborted();
      await rename(part, path);
      this.publish({phase: 'ready', downloadedBytes: bytes, error: null});
    } catch (error) {
      await file?.close().catch(() => {}); await rm(part, {force: true}).catch(() => {});
      this.publish({phase: controller.signal.aborted ? 'available' : 'error', downloadedBytes: 0, error: controller.signal.aborted ? null : error instanceof Error && /INTEGRITY|SIZE/.test(error.message) ? '安装包校验失败，请重新下载' : '下载失败，请检查网络后重试'});
    }
  }
  cancel(): UpdateState { this.transfer?.abort(); return this.state(); }
  async open(): Promise<UpdateState> {
    if (this.value.phase !== 'ready' || !this.asset) throw new Error('安装包还未下载完成');
    if (!await this.verified(this.path(), this.asset).catch(() => false)) {this.publish({phase: 'error', error: '安装包已丢失或校验失败，请重新下载', downloadedBytes: 0}); return this.state();}
    await this.options.open(this.path(), {...this.asset}); return this.state();
  }
  async dispose() { this.disposed = true; this.transfer?.abort(); await this.job; }
}
