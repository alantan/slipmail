import { HEADER_FIELDS, parseHeaders } from "../headers.ts";
import { buildDraft, validAddress } from "../mime_out.ts";
import { OpError, type Session } from "../session.ts";

const MAX_REFERENCES = 10;

export async function saveDraft(s: Session, uid: number, body: string) {
  if (!body.trim()) throw new OpError("usage", "empty draft body");
  if (body.includes("\u0000")) throw new OpError("usage", "NUL in draft body");

  await s.client.examine(s.folders.inbox);
  const row = (await s.client.uidFetch(String(uid), { headerFields: HEADER_FIELDS })).find((r) =>
    r.uid === uid
  );
  if (!row) throw new OpError("not_found", "no such message in the Inbox");
  const h = await parseHeaders(row);

  // The recipient comes only from the original message: Reply-To, else From. Never from the caller.
  // The first usable address wins; an unparseable Reply-To entry does not block a valid later one or From.
  const to = [...h.replyTo, ...(h.from ? [h.from] : [])].map((a) => a.address).find(validAddress);
  if (!to) {
    throw new OpError("bad_recipient", "original message has no usable Reply-To/From address");
  }
  if (!h.messageId) {
    throw new OpError("no_message_id", "original message has no valid Message-ID; cannot thread a reply");
  }

  const subject = /^re:/i.test(h.subject) ? h.subject : `Re: ${h.subject}`;
  const references = [...h.references, h.messageId].slice(-MAX_REFERENCES);
  const mailbox = s.config.mailbox;
  const draft = buildDraft({
    from: mailbox,
    to,
    subject,
    inReplyTo: h.messageId,
    references,
    body,
    idDomain: mailbox.split("@")[1],
  });
  await s.client.appendDraft(s.folders.drafts, draft);
  return { saved: true, folder: "drafts", to, subject, inReplyTo: h.messageId };
}
