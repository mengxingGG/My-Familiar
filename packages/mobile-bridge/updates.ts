import { MobileBridgeError, type UpdateState } from '../mobile-contracts/index.ts';
export function validUpdate(v: any): v is UpdateState {
  return !!v && typeof v === 'object' && /^\d+\.\d+\.\d+$/.test(v.currentVersion) && ['android-arm64','windows-x64'].includes(v.platform)
    && ['idle','checking','current','available','downloading','ready','error'].includes(v.phase)
    && (v.latestVersion === null || typeof v.latestVersion === 'string' && /^\d+\.\d+\.\d+$/.test(v.latestVersion))
    && (v.assetName === null || typeof v.assetName === 'string' && /^Familiar-\d+\.\d+\.\d+-(arm64\.apk|Setup-x64\.exe)$/.test(v.assetName))
    && Number.isSafeInteger(v.downloadedBytes) && v.downloadedBytes >= 0 && Number.isSafeInteger(v.totalBytes) && v.totalBytes >= v.downloadedBytes && v.totalBytes <= 1024 ** 3
    && (v.checkedAt === null || Number.isSafeInteger(v.checkedAt) && v.checkedAt > 0)
    && (v.error === null || typeof v.error === 'string' && v.error.length <= 300);
}
export function projectUpdate(v: unknown): UpdateState {
  if (!validUpdate(v)) throw new MobileBridgeError('UNAVAILABLE', '更新状态不兼容，请重新打开应用。');
  const {currentVersion, platform, phase, latestVersion, assetName, downloadedBytes, totalBytes, checkedAt, error} = v;
  return {currentVersion, platform, phase, latestVersion, assetName, downloadedBytes, totalBytes, checkedAt, error};
}
