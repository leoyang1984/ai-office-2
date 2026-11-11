import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(argon2);
const params = { parallelism: 1, tagLength: 32, memory: 32768, passes: 3 };
const hashPrefix = 'argon2id-v1';
export const hashBytes = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
export const makeToken = () => randomBytes(32).toString('base64url');
export const temporaryPassword = () => randomBytes(24).toString('base64url');

export function sessionToken(header: string | undefined, name: string): string | undefined {
  const matches = header?.split(';').map(field => field.trim()).filter(field => field.startsWith(name + '='));
  if (matches?.length !== 1) return undefined;
  const token = matches[0]!.slice(name.length + 1);
  return /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : undefined;
}

export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const digest = await derive('argon2id', { ...params, nonce, message: Buffer.from(password) });
  return [hashPrefix, nonce.toString('base64url'), digest.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [version, salt, encoded] = stored.split('$');
  if (version !== hashPrefix || !salt || !encoded) return false;
  const nonce = Buffer.from(salt, 'base64url');
  const expected = Buffer.from(encoded, 'base64url');
  if (nonce.length !== 16 || expected.length !== params.tagLength) return false;
  const digest = await derive('argon2id', { ...params, nonce, message: Buffer.from(password) });
  return timingSafeEqual(expected, digest);
}

export function redactMessage(text: string): string {
  return text
    .replace(/\bsk-[\w-]{12,}\b/g, '[已隐藏密钥]')
    .replace(/\b(?:DEEPSEEK_API_KEY|API_KEY|ACCESS_TOKEN|PASSWORD)\s*[:=]\s*\S+/gi, '[已隐藏凭据]')
    .replace(/\bBearer\s+[\w.+/=-]+/gi, '[已隐藏凭据]')
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, '[已隐藏私钥]');
}
