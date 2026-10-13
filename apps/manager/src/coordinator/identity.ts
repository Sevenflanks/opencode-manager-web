import { createHmac, timingSafeEqual } from "node:crypto"

/** Operator 離線 derive：UTF-8 workerId 作 HMAC-SHA256 message，UTF-8 master secret 作 key，無 padding base64url。 */
export function deriveWorkerKey(registrationSecret: string, workerId: string): string {
  return createHmac("sha256", registrationSecret).update(workerId, "utf8").digest("base64url")
}

/** HMAC key 是 workerKey 字串的 UTF-8 bytes（不 decode base64url）；message 是 UTF-8 JSON.stringify(["omw-worker-proof-v1", nonce, id, generation])，digest 為無 padding base64url。 */
export function workerProof(workerKey: string, nonce: string, id: string, generation: string): string {
  return createHmac("sha256", workerKey).update(JSON.stringify(["omw-worker-proof-v1", nonce, id, generation]), "utf8").digest("base64url")
}

export function equalSecret(value: string, expected: string): boolean {
  const left = Buffer.from(value)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface WorkerIdentity { id: string; generation: string; key: string }
export function validWorkerId(value: unknown): value is string {
  // 整個 native host 的第一個 label 仍需在 DNS 的 63 字元內。
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(value)
}
export function validGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}
