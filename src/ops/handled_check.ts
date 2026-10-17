import { type ParsedHeaders, parseHeaders, validMessageId } from "../headers.ts";
import { type FetchResult, parseInternalDate, type SearchCriterion } from "../imap/client.ts";
import { toUidSet } from "./list_new.ts";
import { OpError, type Session } from "../session.ts";

const MAX_VERIFY = 100;
const VERIFY_CHUNK = 50;

/** True if any candidate (newest first, bounded) satisfies `exact` once its headers are fetched. */
async function anyExact(
  s: Session,
  candidates: number[],
  fields: string[],
  exact: (h: ParsedHeaders, r: FetchResult) => boolean,
  internalDate = false,
): Promise<boolean> {
  const uids = [...new Set(candidates)].sort((a, b) => b - a).slice(0, MAX_VERIFY).sort((a, b) => a - b);
  for (let i = 0; i < uids.length; i += VERIFY_CHUNK) {
    const rows = await s.client.uidFetch(toUidSet(uids.slice(i, i + VERIFY_CHUNK)), {
      headerFields: fields,
      internalDate,
    });
    for (const r of rows) if (exact(await parseHeaders(r), r)) return true;
  }
  return false;
}

/** Subject without leading reply/forward prefixes, whitespace-collapsed and lower-cased. */
export function baseSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?)\s*:)+/i, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const REPLY_PREFIX = /^\s*re\s*:/i;
const DAY_MS = 86_400_000;

export interface HandledOptions {
  /** Message-ID recorded by the caller from list-new; needed once the UID has left the Inbox. */
  messageId?: string;
  /** UIDVALIDITY recorded by the caller; a mismatch means the UID is no longer meaningful. */
  uidValidity?: number;
}

export async function handledCheck(s: Session, uid: number, opts: HandledOptions = {}) {
  if (opts.messageId !== undefined && !validMessageId(opts.messageId)) {
    throw new OpError("usage", "invalid --message-id");
  }
  const info = await s.client.examine(s.folders.inbox);
  if (opts.uidValidity !== undefined && opts.uidValidity !== info.uidValidity) {
    throw new OpError("uidvalidity_changed", "Inbox UIDVALIDITY changed; stored UIDs are no longer valid");
  }
  if (info.uidNext && uid >= info.uidNext) {
    throw new OpError("not_found", "UID has not been assigned in the Inbox yet");
  }
  const rows = await s.client.uidFetch(String(uid), {
    flags: true,
    internalDate: true,
    headerFields: ["Message-ID", "Subject", "From", "Reply-To"],
  });
  const row = rows.find((r) => r.uid === uid);
  const inInbox = !!row;
  const answered = !!row?.flags.some((f) => f.toLowerCase() === "\\answered");
  const original = row ? await parseHeaders(row) : null;
  const messageId = original?.messageId ?? opts.messageId ?? null;

  let sentReply = false;
  let sentReplyBasis: "threading-headers" | "subject-and-recipient" | null = null;
  if (messageId) {
    await s.client.examine(s.folders.sent);
    const hits = await s.client.uidSearch(
      {
        kind: "or",
        a: { kind: "header", name: "In-Reply-To", value: messageId },
        b: { kind: "header", name: "References", value: messageId },
      } satisfies SearchCriterion,
    );
    // IMAP HEADER search is a case-insensitive substring match; confirm exact identifier tokens.
    sentReply = await anyExact(
      s,
      hits,
      ["In-Reply-To", "References"],
      (h) => h.inReplyTo.includes(messageId) || h.references.includes(messageId),
    );
    if (sentReply) sentReplyBasis = "threading-headers";
  }

  // Some webmail clients store the Sent copy of a reply without In-Reply-To/References, so the exact
  // match above cannot see it. Fall back to a bounded, exact comparison: a "Re:" message in Sent with
  // the same base subject, addressed to the original's sender, received after the original arrived.
  if (!sentReply && original && !original.truncated) {
    sentReply = await sentReplyByContent(s, original, parseInternalDate(row?.internalDate));
    if (sentReply) sentReplyBasis = "subject-and-recipient";
  }

  let foundInArchive: boolean | null = null;
  if (!inInbox && messageId && s.folders.archive) {
    await s.client.examine(s.folders.archive);
    const hits = await s.client.uidSearch({ kind: "header", name: "Message-ID", value: messageId });
    foundInArchive = await anyExact(s, hits, ["Message-ID"], (h) => h.messageId === messageId);
  }

  const movedOutOfInbox = !inInbox;
  return {
    uid,
    uidValidity: info.uidValidity,
    messageId,
    answered,
    sentReply,
    sentReplyBasis,
    movedOutOfInbox,
    foundInArchive,
    handled: answered || sentReply || movedOutOfInbox,
  };
}

async function sentReplyByContent(
  s: Session,
  original: ParsedHeaders,
  receivedAt: number | null,
): Promise<boolean> {
  const subject = baseSubject(original.subject);
  // The original's own INTERNALDATE (server receipt time) is the floor: its Date header is sender-controlled.
  if (!subject || receivedAt === null) return false;
  const senders = new Set(
    (original.replyTo.length ? original.replyTo : original.from ? [original.from] : [])
      .map((a) => a.address.toLowerCase()),
  );
  if (!senders.size) return false;

  await s.client.examine(s.folders.sent);
  // SINCE ignores the time of day and timezone, so start a day early and compare exactly afterwards.
  const hits = await s.client.uidSearch({ kind: "since", day: new Date(receivedAt - DAY_MS) });
  return await anyExact(
    s,
    hits,
    ["Subject", "To", "Cc"],
    (h, r) => {
      if (h.truncated || !REPLY_PREFIX.test(h.subject) || baseSubject(h.subject) !== subject) return false;
      const sentAt = parseInternalDate(r.internalDate);
      return sentAt !== null && sentAt >= receivedAt && h.recipients.some((a) => senders.has(a));
    },
    true,
  );
}
