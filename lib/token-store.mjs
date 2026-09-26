import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(MODULE_DIR, '..', '.data', 'yahoo-token.enc');

function deriveKey(secret) {
  if (!secret) throw new Error('YAHOO_TOKEN_ENCRYPTION_KEY is not configured.');
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function encryptJson(value, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('DPS2'), iv, tag, ciphertext]).toString('base64');
}

function decryptJson(payload, secret) {
  const raw = Buffer.from(payload, 'base64');
  const magic = raw.subarray(0, 4).toString('utf8');
  if (magic !== 'DPS2') throw new Error('Unsupported token store format.');
  const iv = raw.subarray(4, 16);
  const tag = raw.subarray(16, 32);
  const ciphertext = raw.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

export async function loadToken(secret) {
  try {
    const payload = await fs.readFile(TOKEN_FILE, 'utf8');
    return decryptJson(payload.trim(), secret);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveToken(token, secret) {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, encryptJson(token, secret), { mode: 0o600 });
}

export async function deleteToken() {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}
