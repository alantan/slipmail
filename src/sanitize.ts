import { ALLOWED_EXTENSIONS } from "./config.ts";

const MAX_BASE = 80;
const MAX_EXT = 10;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export interface SanitizedFilename {
  name: string;
  ext: string | null;
  allowed: boolean;
}

/** Control characters plus bidi overrides, isolates and zero-width/format marks. */
function isInvisible(code: number): boolean {
  return code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff;
}

function cleanName(s: string): string {
  let kept = "";
  for (const ch of s.normalize("NFC")) {
    if (!isInvisible(ch.codePointAt(0) ?? 0)) kept += ch;
  }
  return kept
    .replace(/[^A-Za-z0-9._ -]/gu, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[. -]+/, "")
    .replace(/[. ]+$/, "");
}

/**
 * Turns an untrusted attachment filename into a safe leaf name. Pure: no I/O.
 * Path separators are handled by keeping only the last component, so "../" and absolute paths
 * cannot survive; the result never contains "/", "\\", NUL, or a leading ".".
 */
export function sanitizeFilename(raw: string | undefined | null, fallbackBase: string): SanitizedFilename {
  const leaf = (raw ?? "").split(/[\\/]/).at(-1) ?? "";
  let full = cleanName(leaf);
  if (full === "") full = cleanName(fallbackBase) || "file";

  // Windows device names are reserved even with an extension, so check the part before the first dot.
  const stem = full.includes(".") ? full.slice(0, full.indexOf(".")) : full;
  if (RESERVED.test(stem)) full = `_${full}`;

  const dot = full.lastIndexOf(".");
  if (dot <= 0) {
    const base = full.slice(0, MAX_BASE).replace(/[. ]+$/, "");
    return { name: base, ext: null, allowed: false };
  }
  const base = full.slice(0, dot).slice(0, MAX_BASE).replace(/[. ]+$/, "");
  const ext = full.slice(dot + 1).toLowerCase().slice(0, MAX_EXT);
  return {
    name: `${base}.${ext}`,
    ext,
    allowed: ALLOWED_EXTENSIONS.has(ext),
  };
}
