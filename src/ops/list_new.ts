import { HEADER_FIELDS, parseHeaders } from "../headers.ts";
import type { Session } from "../session.ts";

const MAX_UID = 0xffffffff;
// Keep each command line well under the 1000-octet guidance in RFC 3501.
const FETCH_CHUNK = 50;
// UID discovery pages through bounded ranges: a SEARCH reply lists every match, and a 1 MiB reply
// line is our cap. 50k UIDs x up to 11 bytes stays under that, so no single reply can exceed it.
const START_WINDOW = 20_000;
const MAX_WINDOW = 50_000;
const MAX_SEARCHES = 40;

export async function listNew(s: Session, afterUid: number) {
  const info = await s.client.examine(s.folders.inbox);
  const limit = s.config.limits.maxListed;
  const base = { uidValidity: info.uidValidity, uidNext: info.uidNext || null };
  if (afterUid >= MAX_UID) return { ...base, messages: [], truncated: false, nextAfterUid: null };

  // Walk ascending UID windows. A window that finds nothing doubles the next one (sparse UIDs);
  // we stop once we hold more than `limit` UIDs (enough to know the list is truncated).
  // Never scan past the highest UID that exists: without UIDNEXT, ask for the last message's UID
  // (and handle an empty Inbox), so a cursor can never leap over mail that arrives later.
  const top = info.uidNext
    ? info.uidNext - 1
    : info.exists === 0
    ? 0
    : Math.max(0, ...await s.client.uidSearch({ kind: "last" }));
  const uids: number[] = [];
  let from = afterUid + 1;
  let width = START_WINDOW;
  let searches = 0;
  while (from <= top && uids.length <= limit && searches < MAX_SEARCHES) {
    const to = Math.min(from + width - 1, top);
    const hits = await s.client.uidSearch({ kind: "uid", set: `${from}:${to}` });
    uids.push(...new Set(hits.filter((u) => u >= from && u <= to)));
    searches++;
    from = to + 1;
    width = hits.length === 0 ? Math.min(width * 2, MAX_WINDOW) : START_WINDOW;
  }
  uids.sort((a, b) => a - b);
  const wanted = uids.slice(0, limit);
  const scanComplete = from > top;
  const truncated = uids.length > limit || !scanComplete;

  // Parse each batch as it arrives so raw header blocks are released instead of accumulating.
  const messages = [];
  for (let i = 0; i < wanted.length; i += FETCH_CHUNK) {
    const rows = await s.client.uidFetch(toUidSet(wanted.slice(i, i + FETCH_CHUNK)), {
      headerFields: HEADER_FIELDS,
    });
    for (const r of rows) {
      const h = await parseHeaders(r);
      messages.push({ uid: h.uid, messageId: h.messageId, from: h.from, subject: h.subject, date: h.date });
    }
  }
  messages.sort((a, b) => a.uid - b.uid);
  // Where to resume: after the last returned UID when the limit cut the list; otherwise past the
  // range already scanned (an empty-but-truncated result still makes forward progress).
  const nextAfterUid = !truncated ? null : uids.length > limit ? wanted[wanted.length - 1] : from - 1;
  return { ...base, messages, truncated, nextAfterUid };
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
