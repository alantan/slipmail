import { type ParsedHeaders, parseHeaders, validMessageId } from "../headers.ts";
import type { SearchCriterion } from "../imap/client.ts";
import { toUidSet } from "./list_new.ts";
import { OpError, type Session } from "../session.ts";

const MAX_VERIFY = 100;
const VERIFY_CHUNK = 50;

/** True if any candidate (newest first, bounded) satisfies `exact` once its headers are fetched. */
async function anyExact(
  s: Session,
  candidates: number[],
  fields: string[],
  exact: (h: ParsedHeaders) => boolean,
): Promise<boolean> {
  const uids = [...new Set(candidates)].sort((a, b) => b - a).slice(0, MAX_VERIFY).sort((a, b) => a - b);
  for (let i = 0; i < uids.length; i += VERIFY_CHUNK) {
    const rows = await s.client.uidFetch(toUidSet(uids.slice(i, i + VERIFY_CHUNK)), { headerFields: fields });
    for (const r of rows) if (exact(await parseHeaders(r))) return true;
  }
  return false;
}

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
  const rows = await s.client.uidFetch(String(uid), { flags: true, headerFields: ["Message-ID"] });
  const row = rows.find((r) => r.uid === uid);
  const inInbox = !!row;
  const answered = !!row?.flags.some((f) => f.toLowerCase() === "\\answered");
  const messageId = (row ? (await parseHeaders(row)).messageId : null) ?? opts.messageId ?? null;

  let sentReply = false;
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
    movedOutOfInbox,
    foundInArchive,
    handled: answered || sentReply || movedOutOfInbox,
  };
}
