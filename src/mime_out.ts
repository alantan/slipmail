// Construction of the outgoing draft. Every header value is validated or encoded so that
// hostile input from the original message cannot inject headers or extra recipients.

import { textToHtml } from "./html_out.ts";

const ADDR = /^[A-Za-z0-9][A-Za-z0-9._%+'=-]{0,63}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function validAddress(a: string): boolean {
  return a.length <= 254 && ADDR.test(a);
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** RFC 2047 encoded-word(s) for a header value; plain ASCII passes through (CR/LF stripped). */
export function encodeHeaderValue(v: string): string {
  // deno-lint-ignore no-control-regex
  const flat = v.replace(/[\r\n\u0000]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  const words: string[] = [];
  let chunk = "";
  for (const ch of flat) {
    if (new TextEncoder().encode(chunk + ch).length > 42) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(new TextEncoder().encode(w))}?=`).join("\r\n ");
}

export interface DraftParts {
  from: string;
  to: string;
  subject: string;
  inReplyTo: string;
  references: string[];
  body: string;
  now?: Date;
  idDomain: string;
}

/**
 * "References:" header, folded (RFC 5322 section 2.2.3) between identifiers so that physical lines
 * stay within 78 characters where possible. An identifier longer than that stays on its own line.
 * Unfolding (CRLF followed by WSP becomes a single space) yields the space-joined identifier list.
 */
function foldReferences(ids: string[]): string {
  if (ids.length === 0) return "References: ";
  const lines: string[] = [];
  let line = `References: ${ids[0]}`;
  for (const id of ids.slice(1)) {
    if (line.length + 1 + id.length <= 78) {
      line += ` ${id}`;
    } else {
      lines.push(line);
      line = ` ${id}`;
    }
  }
  lines.push(line);
  return lines.join("\r\n");
}

/** Base64 of UTF-8 text, wrapped at 76 columns with CRLF and no trailing line break. */
function b64Wrapped(text: string): string {
  return b64(new TextEncoder().encode(text)).replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

export function buildDraft(p: DraftParts): Uint8Array {
  if (!validAddress(p.from) || !validAddress(p.to)) throw new Error("invalid address");
  const date = (p.now ?? new Date()).toUTCString().replace("GMT", "+0000");
  const messageId = `<${crypto.randomUUID()}@${p.idDomain}>`;
  const text = p.body.replace(/\r\n|\r|\n/g, "\r\n");
  const boundary = `slipmail-${crypto.randomUUID()}`;
  const part = (type: string, content: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
      "",
      b64Wrapped(content),
    ]
      .join("\r\n");
  const headers = [
    `From: ${p.from}`,
    `To: ${p.to}`,
    `Subject: ${encodeHeaderValue(p.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `In-Reply-To: ${p.inReplyTo}`,
    foldReferences(p.references),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [part("text/plain", text), part("text/html", textToHtml(text)), `--${boundary}--`].join(
    "\r\n",
  );
  return new TextEncoder().encode(headers.join("\r\n") + "\r\n\r\n" + body + "\r\n");
}
