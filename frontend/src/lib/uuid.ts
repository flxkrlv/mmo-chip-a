/**
 * Universal UUID v4 generator.
 *
 * `crypto.randomUUID()` only works in secure contexts (HTTPS or localhost).
 * Over network IPs like 10.x.x.x it throws, so we provide a polyfill.
 */

export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // fall through to polyfill
    }
  }
  return uuidV4();
}

function uuidV4(): string {
  // 100% entropy-compatible UUID v4
  const hex = "0123456789abcdef";
  const chars = new Array<string>(36);
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      chars[i] = "-";
    } else if (i === 14) {
      chars[i] = "4"; // version
    } else if (i === 19) {
      chars[i] = hex[(Math.random() * 4) | 0 | 0x8]; // variant 10xxxx
    } else {
      chars[i] = hex[(Math.random() * 16) | 0];
    }
  }
  return chars.join("");
}
