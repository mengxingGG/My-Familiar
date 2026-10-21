import type { MobileBridge, UpdateState } from '../../../packages/mobile-contracts/index.ts';
export class UpdateView {
  readonly root = document.createElement('section');
  private title = document.createElement('b');
  private detail = document.createElement('p');
  private check = document.createElement('button');
  private action = document.createElement('button');
  private cancel = document.createElement('button');
  private value?: UpdateState;
  private pending = false;
  constructor(private bridge: MobileBridge) {
    this.root.className = 'panel update-panel'; this.root.hidden = true; this.root.setAttribute('aria-label', '版本更新');
    this.root.setAttribute('role', 'status');
    const row = document.createElement('div'); row.className = 'update-actions';
    for (const [button, text, method] of [[this.check,'检查更新','updates.check'],[this.action,'下载更新','updates.download'],[this.cancel,'取消下载','updates.cancel']] as const) {
      button.type = 'button'; button.textContent = text; button.className = button === this.action ? 'primary' : 'quiet';
      button.onclick = () => void this.run(button === this.action && this.value?.phase === 'ready' ? 'updates.open' : method); row.append(button);
    }
    this.root.append(this.title,this.detail,row);
  }
  sync(value?: UpdateState) {
    this.value = value; this.root.hidden = !value; if (!value) return;
    const available = !!value.assetName && value.latestVersion !== value.currentVersion;
    this.title.textContent = available ? `发现新版本 ${value.latestVersion}` : `灵伴 ${value.currentVersion}`;
    this.detail.textContent = value.error || (value.phase === 'checking' ? '正在检查 GitHub 正式版…' : value.phase === 'downloading' ? `下载中 ${Math.floor(value.downloadedBytes / value.totalBytes * 100)}% · ${(value.downloadedBytes / 1048576).toFixed(1)} / ${(value.totalBytes / 1048576).toFixed(1)} MB` : value.phase === 'ready' ? '安装包已下载并通过校验，点击安装更新。' : available ? '点击下载适用于 Android ARM64 的安装包。' : value.phase === 'current' ? '已经是最新正式版。' : '启动后会自动检查更新，也可以手动检查。');
    this.check.disabled = this.pending || ['checking','downloading'].includes(value.phase);
    this.action.hidden = !available || ['checking','downloading'].includes(value.phase); this.action.disabled = this.pending;
    this.action.textContent = value.phase === 'ready' ? '安装更新' : value.phase === 'error' ? '重新下载' : '下载更新';
    this.cancel.hidden = value.phase !== 'downloading'; this.cancel.disabled = this.pending;
  }
  private async run(method: 'updates.check' | 'updates.download' | 'updates.cancel' | 'updates.open') {
    if (this.pending) return; this.pending = true; this.sync(this.value);
    try {this.sync(await this.bridge.request(method, undefined));}
    catch {if (this.value) this.value = {...this.value, error: '暂时未能完成，请稍后重试。'};}
    finally {this.pending = false; this.sync(this.value);}
  }
}
