import PostalMime from "postal-mime";
import { addr, clean, validMessageId } from "../headers.ts";
import { contentMatchesExtension } from "../filetype.ts";
import { sanitizeFilename } from "../sanitize.ts";
import { OpError, type Session } from "../session.ts";

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
  saved: boolean;
  path?: string;
  skippedReason?: string;
}

const DROP_BLOCKS = new Set(["script", "style", "head"]);
const BREAK_TAGS = new Set(["br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Single left-to-right pass: every index search resumes after the previous match, and an
 * unterminated construct ends the scan, so work is linear even for adversarial input.
 */
export function htmlToText(html: string): string {
  // ASCII-only lowercase: String.toLowerCase() can change the length ("İ" -> 2 code units), which
  // would shift every offset taken from `lower` relative to `html`.
  const lower = html.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const m = /^<(\/?)([a-z][a-z0-9]*)/.exec(lower.slice(lt, lt + 16));
    if (!m && !/^<[!?]/.test(lower.slice(lt, lt + 2))) {
      out += "<"; // a literal "<" (e.g. "a < b")
      i = lt + 1;
      continue;
    }
    const closing = m?.[1] === "/";
    const name = m?.[2] ?? "";
    if (!closing && DROP_BLOCKS.has(name)) {
      const close = lower.indexOf(`</${name}`, lt + 1);
      if (close < 0) break; // unterminated: drop the rest
      const end = html.indexOf(">", close);
      if (end < 0) break;
      out += " ";
      i = end + 1;
      continue;
    }
    const end = html.indexOf(">", lt + 1);
    if (end < 0) break;
    if (BREAK_TAGS.has(name) && (name === "br" || closing)) out += "\n";
    i = end + 1;
  }
  return out
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Writes a new file; a repeat fetch is idempotent if an identical regular file is already there. */
async function writeOnce(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await Deno.writeFile(path, bytes, { createNew: true, mode: 0o600 });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    const st = await Deno.lstat(path); // lstat: never follow a symlink planted at this name
    const same = st.isFile && st.size === bytes.length &&
      sameBytes(await Deno.readFile(path), bytes);
    if (!same) throw new OpError("scratch_conflict", "a different file already exists at the target path");
  }
}

export async function fetchMessage(s: Session, uid: number) {
  const { limits, scratchDir } = s.config;
  const info = await s.client.examine(s.folders.inbox);
  const meta = (await s.client.uidFetch(String(uid), { size: true })).find((r) => r.uid === uid);
  if (!meta) throw new OpError("not_found", "no such message in the Inbox");
  // Fail closed: a server that does not report the size gets no download.
  if (meta.size === undefined || meta.size > limits.maxMessageBytes) {
    throw new OpError(
      "too_large",
      `message is ${meta.size ?? "of unknown size"} bytes; limit is ${limits.maxMessageBytes}`,
    );
  }
  const full = (await s.client.uidFetch(String(uid), { source: true })).find((r) => r.uid === uid);
  if (!full?.source) throw new OpError("not_found", "message vanished during fetch");

  const email = await PostalMime.parse(full.source);
  let body = email.text ?? "";
  let bodySource: "plain" | "html-stripped" | "none" = body ? "plain" : "none";
  if (!body && email.html) {
    body = htmlToText(email.html);
    bodySource = "html-stripped";
  }
  const truncated = body.length > limits.maxBodyChars;
  if (truncated) body = body.slice(0, limits.maxBodyChars);

  // Per-message directory under the scratch dir; names are sanitised and files never overwrite.
  const dir = `${scratchDir.replace(/\/+$/, "")}/${info.uidValidity}-${uid}`;
  const attachments: AttachmentInfo[] = [];
  let dirReady = false;
  for (const [i, a] of email.attachments.entries()) {
    const safe = sanitizeFilename(a.filename, `attachment-${i + 1}`);
    const bytes = a.content instanceof ArrayBuffer
      ? new Uint8Array(a.content)
      : ArrayBuffer.isView(a.content)
      ? new Uint8Array(a.content.buffer, a.content.byteOffset, a.content.byteLength)
      : new TextEncoder().encode(String(a.content));
    const size = bytes.byteLength;
    const entry: AttachmentInfo = {
      filename: safe.name,
      mimeType: clean(a.mimeType, 100),
      size,
      saved: false,
    };
    if (i >= limits.maxAttachments) entry.skippedReason = "attachment count limit";
    else if (!safe.allowed || !safe.ext) entry.skippedReason = "file type not allowed";
    else if (size > limits.maxAttachmentBytes) entry.skippedReason = "attachment too large";
    else if (!contentMatchesExtension(safe.ext, bytes)) {
      entry.skippedReason = "content does not match extension";
    } else {
      if (!dirReady) {
        await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
        // A pre-planted symlink here would redirect every write; refuse it.
        if ((await Deno.lstat(dir)).isSymlink) {
          throw new OpError("scratch_conflict", "message scratch directory is a symlink");
        }
        dirReady = true;
      }
      const path = `${dir}/${i + 1}-${safe.name}`;
      // createNew refuses to follow or replace an existing file or symlink.
      await writeOnce(path, bytes);
      entry.saved = true;
      entry.path = path;
    }
    attachments.push(entry);
  }

  const mid = email.messageId?.trim();
  return {
    untrusted: true,
    uid,
    uidValidity: info.uidValidity,
    messageId: validMessageId(mid) ? mid : null,
    from: addr(email.from),
    subject: clean(email.subject),
    date: email.date ? clean(email.date, 60) : null,
    body,
    bodySource,
    bodyTruncated: truncated,
    attachments,
  };
}
