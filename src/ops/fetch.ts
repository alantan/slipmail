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

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
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
