/* crypto.js — vault encryption (T30, decision D11).
 *
 * AES-256-GCM note bodies, key derived from a passphrase via PBKDF2-SHA256.
 * The key lives in memory only and is never persisted. Salt + verifier live
 * in localStorage under a single key; ciphertext envelopes live in the
 * existing `body` field, so no Dexie schema change is needed.
 */

const SALT_KEY = 'noted.crypto';
const PBKDF2_ITER = 600000;
const PREFIX = 'ENC1.';
const CHECK_TEXT = 'noted-vault-verifier';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Vault config ({ salt, check }) or null when encryption was never enabled. */
export function vaultConfig() {
  try {
    const raw = localStorage.getItem(SALT_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.salt === 'string' && typeof cfg.check === 'string') return cfg;
    return null;
  } catch {
    return null;
  }
}

export function vaultEnabled() {
  return vaultConfig() !== null;
}

export function clearVaultConfig() {
  localStorage.removeItem(SALT_KEY);
}

/** Shape check only — a forged envelope fails authentication on decrypt. */
export function isEnvelope(s) {
  if (typeof s !== 'string' || !s.startsWith(PREFIX)) return false;
  const parts = s.split('.');
  return parts.length === 3 && parts[1].length > 0 && parts[2].length > 0;
}

export async function deriveKey(passphrase, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64decode(saltB64), iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptRaw(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return `${b64encode(iv)}.${b64encode(new Uint8Array(data))}`;
}

async function decryptRaw(key, payload) {
  const [ivB64, dataB64] = payload.split('.');
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(ivB64) },
    key,
    b64decode(dataB64),
  );
  return dec.decode(data);
}

/**
 * First-run setup: generates the salt, derives the key, stores salt +
 * a verifier (a known string encrypted under the key), and returns the key.
 * The passphrase itself is never stored anywhere.
 */
export async function setupVault(passphrase) {
  const salt = b64encode(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(passphrase, salt);
  const check = await encryptRaw(key, CHECK_TEXT);
  localStorage.setItem(SALT_KEY, JSON.stringify({ salt, check }));
  return key;
}

/** Unlock: derives the key and verifies it against the stored verifier. Throws on a wrong passphrase. */
export async function openVault(passphrase) {
  const cfg = vaultConfig();
  if (!cfg) throw new Error('encryption is not enabled');
  const key = await deriveKey(passphrase, cfg.salt);
  let ok = false;
  try {
    ok = (await decryptRaw(key, cfg.check)) === CHECK_TEXT;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('wrong passphrase');
  return key;
}

export function encryptBody(key, plaintext) {
  return encryptRaw(key, plaintext ?? '').then((payload) => PREFIX + payload);
}

/** Decrypts an envelope. Throws on authentication failure (wrong key / tampered data). */
export function decryptBody(key, envelope) {
  return decryptRaw(key, envelope.slice(PREFIX.length));
}
