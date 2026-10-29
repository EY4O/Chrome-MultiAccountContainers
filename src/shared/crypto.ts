// AES-256-GCM sealing for container cookie jars at rest. The key is stored
// next to the data (chrome.storage.local), so this keeps cookies out of plain
// sight in the profile folder and lets a container's data be made unreadable
// by discarding its key; it does not protect against someone who can read
// the whole profile while the key still exists.

export interface Sealed {
  v: 1;
  iv: string;
  data: string;
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(keyB64: string): Promise<CryptoKey> {
  let key = keyCache.get(keyB64);
  if (!key) {
    key = crypto.subtle.importKey("raw", fromB64(keyB64), "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(keyB64, key);
  }
  return key;
}

/** A fresh random 256-bit key, base64-encoded. */
export function newKey(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

export function isSealed(value: unknown): value is Sealed {
  return typeof value === "object" && value !== null && (value as Sealed).v === 1 && typeof (value as Sealed).iv === "string";
}

export async function seal(keyB64: string, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyB64), plain));
  return { v: 1, iv: toB64(iv), data: toB64(data) };
}

/** Throws if the key is wrong or the data was tampered with. */
export async function unseal<T>(keyB64: string, sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(sealed.iv) },
    await importKey(keyB64),
    fromB64(sealed.data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
