/**
 * AES-256-GCM at-rest encryption for owners' LLM API keys.
 *
 * Why GCM:
 *   - Authenticated encryption (tag detects tampering)
 *   - Widely audited Node crypto primitive
 *   - 12-byte random IV per ciphertext; safe to store alongside
 *
 * The master key lives in the `HOSTED_AGENT_KMS_KEY` env var as
 * base64-encoded 32 bytes. Provisioned via Vercel env vars +
 * (eventually) AWS/GCP KMS. NEVER logged. NEVER written to the
 * database. Server boots and panics if missing in production —
 * fail-loud is better than silent fallback.
 *
 * Threat model this protects against:
 *   - Database leak (S3 snapshot, backup file): keys unreadable
 *     without the env var
 *   - Read-replica access: same
 *   - Casual dev-console SELECT: same
 *
 * What it does NOT protect against:
 *   - Compromised Vercel function with env var access: game over,
 *     same as the operator wallet private key
 *   - Sophisticated side-channel timing attacks: not in scope
 */
import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // 256 bits
const IV_BYTES = 12; // 96 bits, the GCM recommended size

let cachedKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.HOSTED_AGENT_KMS_KEY;
  if (!raw) {
    throw new Error(
      "HOSTED_AGENT_KMS_KEY env var is not set. Hosted Agent Mode " +
        "requires this key for at-rest API-key encryption. Generate " +
        "with: `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `HOSTED_AGENT_KMS_KEY decodes to ${buf.length} bytes; expected ${KEY_BYTES}. ` +
        "Did you base64-encode 32 random bytes?",
    );
  }
  cachedKey = buf;
  return buf;
}

export interface EncryptedKey {
  /** Base64-encoded ciphertext. */
  ciphertext: string;
  /** Base64-encoded 12-byte IV (random per encryption). */
  iv: string;
  /** Base64-encoded 16-byte GCM auth tag. */
  tag: string;
}

/**
 * Encrypt a plaintext API key. Returns the three pieces that go into
 * hosted_agent_configs.{apiKeyEncrypted, apiKeyIv, apiKeyTag}.
 *
 * Each encryption uses a fresh random IV — never reuse an IV with
 * the same key in GCM mode (it breaks the cipher's security).
 */
export function encryptApiKey(plaintext: string): EncryptedKey {
  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt a stored API key. Called only inside the hosted-agent
 * worker context, ideally late in the call stack (closer to the
 * vendor API call) so the plaintext lives in memory for the
 * shortest possible window.
 *
 * Throws if the auth tag doesn't validate — i.e. if the ciphertext
 * was tampered with or the wrong master key was used.
 */
export function decryptApiKey(enc: EncryptedKey): string {
  const key = loadMasterKey();
  const iv = Buffer.from(enc.iv, "base64");
  const tag = Buffer.from(enc.tag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
