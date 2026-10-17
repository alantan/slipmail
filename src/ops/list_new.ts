import { HEADER_FIELDS, parseHeaders } from "../headers.ts";
import type { Session } from "../session.ts";

const MAX_UID = 0xffffffff;
// Keep each command line well under the 1000-octet guidance in RFC 3501.
const FETCH_CHUNK = 50;

export async function listNew(s: Session, afterUid: number) {
  const info = await s.client.examine(s.folders.inbox);
  if (afterUid >= MAX_UID) {
    return { uidValidity: info.uidValidity, uidNext: info.uidNext || null, messages: [], truncated: false };
  }
  const limit = s.config.limits.maxListed;
  // One cheap round trip for the UIDs themselves, then headers only for the ones we will return.
  // "n:*" always includes the highest message even when it is below n (RFC 3501), so filter.
  const uids = [...new Set(await s.client.uidSearch({ kind: "uid", set: `${afterUid + 1}:*` }))]
    .filter((u) => u > afterUid)
    .sort((a, b) => a - b);
  const wanted = uids.slice(0, limit);
  const rows = [];
  for (let i = 0; i < wanted.length; i += FETCH_CHUNK) {
    rows.push(
      ...await s.client.uidFetch(toUidSet(wanted.slice(i, i + FETCH_CHUNK)), { headerFields: HEADER_FIELDS }),
    );
  }
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

/** Ascending UIDs -> compact IMAP set, e.g. [1,2,3,7] -> "1:3,7". */
export function toUidSet(uids: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < uids.length;) {
    let j = i;
    while (j + 1 < uids.length && uids[j + 1] === uids[j] + 1) j++;
    parts.push(j > i ? `${uids[i]}:${uids[j]}` : String(uids[i]));
    i = j + 1;
  }
  return parts.join(",");
}
