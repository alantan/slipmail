// Parsing of fetched header blocks and sanitising of values echoed back to the caller.

import PostalMime from "postal-mime";
import type { FetchResult } from "./imap/client.ts";

export const HEADER_FIELDS = [
  "From",
  "Subject",
  "Date",
  "Message-ID",
  "Reply-To",
  "In-Reply-To",
  "References",
];

export interface Address {
  name: string;
  address: string;
}

export interface ParsedHeaders {
  uid: number;
  messageId: string | null;
  from: Address | null;
  replyTo: Address[];
  subject: string;
  date: string | null;
  inReplyTo: string | null;
  references: string[];
}

// Printable ASCII only (no space, quote, backslash, angle brackets inside): safe to place in an IMAP SEARCH.
const MSGID = /^<[\x21\x23-\x3b\x3d\x3f-\x5b\x5d-\x7e]{1,200}>$/;

/** Strip control and bidi/format characters and cap the length. Used on every echoed string. */
export function clean(s: string | undefined | null, max = 300): string {
  if (!s) return "";
  // deno-lint-ignore no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function validMessageId(s: string | null | undefined): s is string {
  return !!s && MSGID.test(s);
}

export function addr(a: { name?: string; address?: string } | undefined): Address | null {
  if (!a?.address) return null;
  return { name: clean(a.name, 120), address: clean(a.address, 254) };
}

export async function parseHeaders(r: FetchResult): Promise<ParsedHeaders> {
  const email = await PostalMime.parse(r.header ?? new Uint8Array());
  const mid = email.messageId?.trim();
  const irt = email.inReplyTo?.trim();
  return {
    uid: r.uid,
    messageId: validMessageId(mid) ? mid : null,
    from: addr(email.from),
    replyTo: (email.replyTo ?? []).map(addr).filter((a): a is Address => a !== null),
    subject: clean(email.subject),
    date: email.date ? clean(email.date, 60) : null,
    inReplyTo: validMessageId(irt) ? irt : null,
    references: (email.references ?? "").split(/\s+/).filter(validMessageId),
  };
}
