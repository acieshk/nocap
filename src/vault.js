/**
 * Passphrase-gated secrets.
 *
 * AES-GCM with a PBKDF2-derived key, over WebCrypto. No DOM, no dependencies —
 * runs in a browser, a worker, or Node 18+.
 *
 * What this is for, precisely, because it is easy to over-read:
 *
 *   It protects the ciphertext from anyone who does not have the passphrase —
 *   whoever hosts the file, a CDN cache, a backup, a forwarded link, someone on
 *   a shared machine. That is a real and common threat, and encryption solves
 *   it properly.
 *
 *   It does NOT protect the plaintext from the person who just typed the
 *   passphrase. Once decrypt() returns, the value is in JS memory and on a
 *   canvas, and DevTools reads both. Hooking crypto.subtle.decrypt is a
 *   one-liner and does not even require finding the key.
 *
 * So: never ship the key with the page. A passphrase the user types, a key in
 * the URL fragment (never sent to the server), or a key handed over after auth
 * are all fine. A constant in the bundle is not encryption, it is obfuscation.
 */

const KDF = 'PBKDF2';
const HASH = 'SHA-256';
const CIPHER = 'AES-GCM';
// OWASP's floor for PBKDF2-HMAC-SHA256. Costs ~0.5s on a laptop, which is the
// point — it is what makes a weak passphrase expensive to grind.
const ITERATIONS = 310000;

const subtle = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto unavailable (needs a secure context or Node 18+)');
  return c.subtle;
};

/**
 * @param {string} plaintext
 * @param {string} passphrase
 * @returns {Promise<{v:number,kdf:string,iterations:number,salt:string,iv:string,ct:string}>}
 *          A payload safe to store or serve publicly.
 */
export async function encryptSecret(plaintext, passphrase, { iterations = ITERATIONS } = {}) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = await subtle().encrypt(
    { name: CIPHER, iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    v: 1,
    kdf: `${KDF}-${HASH}`,
    iterations,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ct)),
  };
}

/**
 * @throws if the passphrase is wrong — AES-GCM is authenticated, so a bad key
 *         fails loudly rather than returning plausible garbage.
 */
export async function decryptSecret(payload, passphrase) {
  const key = await deriveKey(passphrase, fromB64(payload.salt), payload.iterations ?? ITERATIONS);
  let plain;
  try {
    plain = await subtle().decrypt({ name: CIPHER, iv: fromB64(payload.iv) }, key, fromB64(payload.ct));
  } catch {
    throw new Error('wrong passphrase');
  }
  return new TextDecoder().decode(plain);
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    KDF,
    false,
    ['deriveKey']
  );
  return subtle().deriveKey(
    { name: KDF, salt, iterations, hash: HASH },
    base,
    { name: CIPHER, length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
