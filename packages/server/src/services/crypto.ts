import { createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual as tsEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// 1. HMAC-SHA-256 API key hashing
// ---------------------------------------------------------------------------

/**
 * Produce a hex-encoded HMAC-SHA-256 digest of the given API key.
 *
 * The HMAC secret is read from `process.env.HMAC_SECRET` and must be set
 * before calling this function.
 */
export function hashApiKey(key: string): string {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    throw new Error('HMAC_SECRET environment variable is not set');
  }
  return createHmac('sha256', secret).update(key).digest('hex');
}

// ---------------------------------------------------------------------------
// 2. AES-256-GCM encryption / decryption
// ---------------------------------------------------------------------------

const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Read and validate the 32-byte encryption key from the environment.
 *
 * `ENCRYPTION_KEY` must be a 64-character hex string (representing 32 bytes).
 */
function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  if (hex.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Received ${hex.length} characters.`,
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Returns a base64 string containing `iv (12 B) || authTag (16 B) || ciphertext`.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack as: iv + tag + ciphertext
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64 ciphertext string that was produced by {@link encrypt}.
 *
 * Expects the format `base64(iv (12 B) || authTag (16 B) || ciphertext)`.
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const packed = Buffer.from(ciphertext, 'base64');

  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Ciphertext is too short to contain IV and auth tag');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const data = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// 3. Random API key generation
// ---------------------------------------------------------------------------

/**
 * Generate a random API key with the format `sk-agent-<32 hex chars>`.
 */
export function generateApiKey(): string {
  return `sk-agent-${randomBytes(16).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// 4. Constant-time string comparison
// ---------------------------------------------------------------------------

/**
 * Compare two strings in constant time to prevent timing attacks.
 *
 * HMAC-compares both values so the comparison takes constant time
 * regardless of whether the inputs differ in length.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const key = 'timing-safe-compare';
  const hashA = createHmac('sha256', key).update(a).digest();
  const hashB = createHmac('sha256', key).update(b).digest();
  return tsEqual(hashA, hashB);
}
