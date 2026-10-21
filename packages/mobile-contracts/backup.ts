export interface BackupPreview {
  id: string;
  sourceVersion: string;
  createdAt: string;
  memoryFiles: number;
  conflicts: number;
  modelKeys: number;
  models: { kind: string; baseUrl: string; model: string }[];
  rollback: boolean;
}
export interface MobileBackupCommands {
  "backup.export": {
    params: { password: string; includeKeys: boolean };
    result: { saved: boolean };
  };
  "backup.choose": { params: undefined; result: { token: string | null } };
  "backup.inspect": {
    params: { token: string; password: string };
    result: BackupPreview;
  };
  "backup.recovery": { params: { password: string }; result: BackupPreview };
  "backup.apply": {
    params: { id: string };
    result: { imported: boolean; recoveryAvailable: boolean };
  };
  "backup.cancel": { params: { id: string }; result: void };
}
