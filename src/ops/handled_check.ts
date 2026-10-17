import { parseHeaders, validMessageId } from "../headers.ts";
import type { SearchCriterion } from "../imap/client.ts";
import { OpError, type Session } from "../session.ts";

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
  const rows = await s.client.uidFetch(String(uid), { flags: true, headerFields: ["Message-ID"] });
  const row = rows.find((r) => r.uid === uid);
  const inInbox = !!row;
  const answered = !!row?.flags.some((f) => f.toLowerCase() === "\\answered");
  const messageId = row ? (await parseHeaders(row)).messageId : opts.messageId ?? null;

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
    sentReply = hits.length > 0;
  }

  let foundInArchive: boolean | null = null;
  if (!inInbox && messageId && s.folders.archive) {
    await s.client.examine(s.folders.archive);
    foundInArchive =
      (await s.client.uidSearch({ kind: "header", name: "Message-ID", value: messageId })).length > 0;
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
