import { HEADER_FIELDS, parseHeaders } from "../headers.ts";
import type { FetchResult } from "../imap/client.ts";
import type { Session } from "../session.ts";

const MAX_WINDOWS = 50;

export async function listNew(s: Session, afterUid: number) {
  const info = await s.client.examine(s.folders.inbox);
  const limit = s.config.limits.maxListed;
  // Walk bounded UID windows rather than "n:*" so work stays proportional to the limit even on a
  // huge Inbox (and sidesteps the RFC 3501 rule that "n:*" returns the last message when n is past it).
  const windowSize = Math.max(limit, 100);
  const found: FetchResult[] = [];
  let from = afterUid + 1;
  for (let w = 0; w < MAX_WINDOWS && from < info.uidNext && found.length <= limit; w++) {
    const to = Math.min(from + windowSize - 1, info.uidNext - 1);
    const rows = await s.client.uidFetch(`${from}:${to}`, { headerFields: HEADER_FIELDS });
    found.push(...rows.filter((r) => r.uid >= from && r.uid <= to));
    from = to + 1;
  }
  found.sort((a, b) => a.uid - b.uid);
  const messages = [];
  for (const r of found.slice(0, limit)) {
    const h = await parseHeaders(r);
    messages.push({ uid: h.uid, messageId: h.messageId, from: h.from, subject: h.subject, date: h.date });
  }
  const truncated = found.length > limit || from < info.uidNext;
  return { uidValidity: info.uidValidity, uidNext: info.uidNext, messages, truncated };
}
