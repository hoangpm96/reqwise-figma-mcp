/**
 * Base64 encode/decode that works in the Figma plugin MAIN thread.
 * The main-thread sandbox historically lacks atob/btoa (only the plugin
 * iframe has them), so we feature-detect and fall back to a pure
 * implementation. Pure functions — unit-testable in Node.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charAt(i)] = i;

declare const atob: ((s: string) => string) | undefined;
declare const btoa: ((s: string) => string) | undefined;

export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]+,/, "").replace(/[\r\n\s]/g, "");
  if (typeof atob === "function") {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const stripped = clean.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < stripped.length; i++) {
    const v = LOOKUP[stripped.charAt(i)];
    if (v === undefined) throw new Error(`Invalid base64 character at ${i}`);
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, i + chunk);
      binary += String.fromCharCode.apply(null, slice as unknown as number[]);
    }
    return btoa(binary);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out +=
      i + 1 < bytes.length ? ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : "=";
    out += i + 2 < bytes.length ? ALPHABET.charAt(b2 & 0x3f) : "=";
  }
  return out;
}
