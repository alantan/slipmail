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
  /** Lower-cased To and Cc addresses (bounded); empty unless those fields were fetched. */
  recipients: string[];
  subject: string;
  date: string | null;
  /** Every valid Message-ID in In-Reply-To (the field may legally list several). */
  inReplyTo: string[];
  references: string[];
  /** The header block hit the partial-fetch budget: fields may be missing or cut short. */
  truncated: boolean;
}

// Printable ASCII only (no space, quote, backslash, angle brackets inside): safe to place in an IMAP SEARCH.
const MSGID = /^<[\x21\x23-\x3b\x3d\x3f-\x5b\x5d-\x7e]{1,200}>$/;

/** Strip control and bidi/format characters and cap the length. Used on every echoed string. */
export function clean(s: string | undefined | null, max = 300): string {
  if (!s) return "";
  // deno-lint-ignore no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .trim();
  if (t.length <= max) return t;
  // Do not leave half of a surrogate pair at the cut.
  const hi = t.charCodeAt(max - 1);
  return t.slice(0, hi >= 0xd800 && hi <= 0xdbff ? max - 1 : max);
}

export function validMessageId(s: string | null | undefined): s is string {
  return !!s && MSGID.test(s);
}

export function addr(a: { name?: string; address?: string } | undefined): Address | null {
  // Never truncate an address: a clipped one could become a different, valid-looking address.
  if (!a?.address || a.address.length > 254) return null;
  return { name: clean(a.name, 120), address: clean(a.address, 254) };
}

/** Extracts every valid <id> token (bounded count), ignoring anything malformed around them. */
export function messageIds(field: string | undefined | null): string[] {
  return (field ?? "").match(/<[^<>\s]{1,200}>/g)?.filter(validMessageId).slice(0, 50) ?? [];
}

const MAX_RECIPIENTS = 100;

type RawAddress = { name?: string; address?: string; group?: RawAddress[] };

/** Lower-cased addresses from several address lists, sharing one overall cap. */
function flatAddresses(...lists: Array<RawAddress[] | undefined>): string[] {
  const out: string[] = [];
  const walk = (items: RawAddress[]) => {
    for (const a of items) {
      if (out.length >= MAX_RECIPIENTS) return;
      if (a.group) walk(a.group);
      else {
        const v = addr(a);
        if (v) out.push(v.address.toLowerCase());
      }
    }
  };
  for (const list of lists) walk(list ?? []);
  return out;
}

export async function parseHeaders(r: FetchResult): Promise<ParsedHeaders> {
  // postal-mime throws on degenerate blocks (e.g. one cut to nothing by the partial fetch, or empty).
  // Fail closed: treat it as an unreadable, truncated header block rather than crashing.
  type Email = Awaited<ReturnType<typeof PostalMime.parse>>;
  let email: Partial<Email> = {};
  let unreadable = false;
  try {
    email = await PostalMime.parse(r.header ?? new Uint8Array());
  } catch {
    unreadable = true;
  }
  const mid = email.messageId?.trim();
  return {
    uid: r.uid,
    messageId: validMessageId(mid) ? mid : null,
    from: addr(email.from),
    replyTo: (email.replyTo ?? []).map(addr).filter((a): a is Address => a !== null),
    recipients: flatAddresses(email.to, email.cc),
    subject: clean(email.subject),
    date: email.date ? clean(email.date, 60) : null,
    inReplyTo: messageIds(email.inReplyTo),
    references: messageIds(email.references),
    truncated: r.headerTruncated === true || unreadable,
  };
}
