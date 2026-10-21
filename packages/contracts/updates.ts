export const FAMILIAR_VERSION = "1.1.0";
export type UpdatePlatform = "android-arm64" | "windows-x64";
export interface UpdateState {
  currentVersion: string;
  platform: UpdatePlatform;
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error";
  latestVersion: string | null;
  assetName: string | null;
  downloadedBytes: number;
  totalBytes: number;
  checkedAt: number | null;
  error: string | null;
}
export interface AppUpdates {
  state(): UpdateState;
  check(): Promise<UpdateState>;
  download(): UpdateState;
  cancel(): UpdateState;
  open(): Promise<UpdateState>;
}
export const updateCommands = ["updates.state", "updates.check", "updates.download", "updates.cancel", "updates.open"] as const;
declare module "../kernel/index.ts" {
  interface Services { "app.updates": AppUpdates; }
}
