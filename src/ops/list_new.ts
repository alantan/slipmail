import { HEADER_FIELDS, parseHeaders } from "../headers.ts";
import type { Session } from "../session.ts";

export async function listNew(s: Session, afterUid: number) {
  const info = await s.client.examine(s.folders.inbox);
  const limit = s.config.limits.maxListed;
  // One cheap round trip for the UIDs themselves, then headers only for the ones we will return.
  // "n:*" always includes the highest message even when it is below n (RFC 3501), so filter.
  const uids = (await s.client.uidSearch({ kind: "uid", set: `${afterUid + 1}:*` }))
    .filter((u) => u > afterUid)
    .sort((a, b) => a - b);
  const wanted = uids.slice(0, limit);
  const rows = wanted.length
    ? await s.client.uidFetch(wanted.join(","), { headerFields: HEADER_FIELDS })
    : [];
  const messages = [];
  for (const r of rows.sort((a, b) => a.uid - b.uid)) {
    const h = await parseHeaders(r);
    messages.push({ uid: h.uid, messageId: h.messageId, from: h.from, subject: h.subject, date: h.date });
  }
  return {
    uidValidity: info.uidValidity,
    uidNext: info.uidNext || null,
    messages,
    truncated: uids.length > limit,
  };
}
