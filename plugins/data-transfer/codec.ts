import {
  randomBytes,
  pbkdf2,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(pbkdf2);
const magic = Buffer.from("FAMBAK1\n", "ascii");
export const BACKUP_LIMIT = 25 * 1024 * 1024;
const passwordBytes = (password: string | Buffer) => {
  const b = Buffer.isBuffer(password)
    ? password
    : Buffer.from(password, "utf8");
  if (b.length < 10 || b.length > 1024) throw Error("BACKUP_PASSWORD");
  return b;
};

/** 固定版本、固定 KDF 成本；头部、盐和随机数均经 GCM 认证，不接受文件自选算法。 */
export async function encryptBackup(
  value: unknown,
  password: string | Buffer,
): Promise<Buffer> {
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  if (plain.length > BACKUP_LIMIT - 128) {
    plain.fill(0);
    throw Error("LIMIT");
  }
  const salt = randomBytes(16),
    nonce = randomBytes(12);
  const key = await derive(passwordBytes(password), salt, 600000, 32, "sha256");
  try {
    const aad = Buffer.concat([magic, salt, nonce]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    return Buffer.concat([
      aad,
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  } finally {
    key.fill(0);
    plain.fill(0);
  }
}

export async function decryptBackup(
  bytes: Buffer,
  password: string | Buffer,
): Promise<unknown> {
  if (
    bytes.length < 54 ||
    bytes.length > BACKUP_LIMIT ||
    !bytes.subarray(0, 8).equals(magic)
  )
    throw Error("INVALID_BACKUP");
  const key = await derive(
    passwordBytes(password),
    bytes.subarray(8, 24),
    600000,
    32,
    "sha256",
  );
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(24, 36),
    );
    decipher.setAAD(bytes.subarray(0, 36));
    decipher.setAuthTag(bytes.subarray(-16));
    plain = Buffer.concat([
      decipher.update(bytes.subarray(36, -16)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw Error("BACKUP_DECRYPT");
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}
