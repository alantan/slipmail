// Content sniffing for attachments. Pure: no I/O, no environment access.

const PDF_MARKER = new TextEncoder().encode("%PDF-");
/** The %PDF- marker may begin anywhere in the first this-many bytes (leading junk tolerance). */
const PDF_SEARCH_LIMIT = 1024;
const TEXT_SAMPLE_BYTES = 8192;
const MAX_CONTROL_RATIO = 0.1;

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

function hasPdfMarker(bytes: Uint8Array): boolean {
  const lastStart = Math.min(PDF_SEARCH_LIMIT, bytes.length - PDF_MARKER.length);
  for (let start = 0; start <= lastStart; start++) {
    if (PDF_MARKER.every((b, i) => bytes[start + i] === b)) return true;
  }
  return false;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, TEXT_SAMPLE_BYTES);
  let control = 0;
  for (const b of sample) {
    if (b === 0x00) return false;
    const isWhitespace = b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d;
    if ((b < 0x20 || b === 0x7f) && !isWhitespace) control++;
  }
  return control / sample.length < MAX_CONTROL_RATIO;
}

/**
 * Returns true when the leading bytes are consistent with the extension (ext is lowercase, no dot).
 * Unknown extensions and empty input always return false.
 */
export function contentMatchesExtension(ext: string, bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  switch (ext) {
    case "pdf":
      return hasPdfMarker(bytes);
    case "jpg":
    case "jpeg":
      return startsWith(bytes, JPEG_SIGNATURE);
    case "png":
      return startsWith(bytes, PNG_SIGNATURE);
    case "docx":
    case "xlsx":
      return startsWith(bytes, ZIP_SIGNATURE);
    case "txt":
    case "csv":
      return looksLikeText(bytes);
    default:
      return false;
  }
}
