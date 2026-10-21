import {
  MobileBridgeError,
  type BackupPreview,
} from "../mobile-contracts/index.ts";
export function projectBackup(method: string, v: any): unknown {
  const fail = () => {
    throw new MobileBridgeError("UNAVAILABLE", "迁移结果格式不兼容。");
  };
  if (method === "backup.cancel") return;
  if (method === "backup.export")
    return v && typeof v.saved === "boolean" ? { saved: v.saved } : fail();
  if (method === "backup.choose")
    return v &&
      (v.token === null ||
        (typeof v.token === "string" && /^[a-f0-9-]{36}$/.test(v.token)))
      ? { token: v.token }
      : fail();
  if (method === "backup.apply")
    return v &&
      typeof v.imported === "boolean" &&
      typeof v.recoveryAvailable === "boolean"
      ? { imported: v.imported, recoveryAvailable: v.recoveryAvailable }
      : fail();
  if (
    !v ||
    typeof v.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(v.id) ||
    typeof v.sourceVersion !== "string" ||
    v.sourceVersion.length > 80 ||
    typeof v.createdAt !== "string" ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    ![v.memoryFiles, v.conflicts, v.modelKeys].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 5000,
    ) ||
    typeof v.rollback !== "boolean" ||
    !Array.isArray(v.models) ||
    v.models.length > 33 ||
    v.models.some(
      (p: any) =>
        !p ||
        typeof p.kind !== "string" ||
        typeof p.baseUrl !== "string" ||
        p.baseUrl.length > 2048 ||
        typeof p.model !== "string" ||
        p.model.length > 200,
    )
  )
    return fail();
  return {
    id: v.id,
    sourceVersion: v.sourceVersion,
    createdAt: v.createdAt,
    memoryFiles: v.memoryFiles,
    conflicts: v.conflicts,
    modelKeys: v.modelKeys,
    rollback: v.rollback,
    models: v.models.map(
      ({ kind, baseUrl, model }: BackupPreview["models"][number]) => ({
        kind,
        baseUrl,
        model,
      }),
    ),
  } as BackupPreview;
}
