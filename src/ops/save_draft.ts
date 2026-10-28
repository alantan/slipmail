import { HEADER_FIELDS, parseHeaders } from "../headers.ts";
import { buildDraft, validAddress } from "../mime_out.ts";
import { OpError, type Session } from "../session.ts";

const MAX_REFERENCES = 10;

/** Cheap checks the CLI runs before opening a connection. */
export function validateDraftBody(body: string): void {
  if (!body.trim()) throw new OpError("usage", "empty draft body");
  if (body.includes("\u0000")) throw new OpError("usage", "NUL in draft body");
}

export async function saveDraft(s: Session, uid: number, body: string) {
  validateDraftBody(body);

  await s.client.examine(s.folders.inbox);
  const row = (await s.client.uidFetch(String(uid), { headerFields: HEADER_FIELDS })).find((r) =>
    r.uid === uid
  );
  if (!row) throw new OpError("not_found", "no such message in the Inbox");
  const h = await parseHeaders(row);
  // A cut-off block could lose the real Reply-To (or clip an address) and misdirect the draft.
  if (h.truncated) {
    throw new OpError("headers_too_large", "original message headers are too large to read safely");
  }

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

const MAX_SUBJECT_CHARS = 300;

/** Cheap checks for a new-message draft; the CLI runs them before opening a connection. */
export function validateNewDraft(to: string, subject: string, body: string): void {
  if (!validAddress(to)) throw new OpError("usage", "invalid --to address");
  if (
    !subject.trim() || subject.length > MAX_SUBJECT_CHARS ||
    /\p{Cc}/u.test(subject.replace(/\t/g, " "))
  ) {
    throw new OpError(
      "usage",
      `subject must be 1-${MAX_SUBJECT_CHARS} characters without control characters`,
    );
  }
  validateDraftBody(body);
}

/** Saves a new (unthreaded) message to Drafts. Like every draft it is never sent. */
export async function saveNewDraft(s: Session, to: string, subject: string, body: string) {
  validateNewDraft(to, subject, body);
  const mailbox = s.config.mailbox;
  const draft = buildDraft({ from: mailbox, to, subject, body, idDomain: mailbox.split("@")[1] });
  await s.client.appendDraft(s.folders.drafts, draft);
  return { to, subject };
}

export interface NewDraftSpec {
  to: string;
  subject: string;
  body: string;
}

const MAX_BATCH = 100;

/** Parses JSON lines of {to, subject, body}. Every line is validated before anything is saved. */
export function parseBatch(text: string): NewDraftSpec[] {
  const specs: NewDraftSpec[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const at = `batch line ${i + 1}`;
    let o: unknown;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      throw new OpError("usage", `${at}: not valid JSON`);
    }
    const r = o as Record<string, unknown>;
    if (
      typeof o !== "object" || o === null || Array.isArray(o) || Object.keys(r).length !== 3 ||
      typeof r.to !== "string" || typeof r.subject !== "string" || typeof r.body !== "string"
    ) {
      throw new OpError("usage", `${at}: expected exactly {"to","subject","body"} as strings`);
    }
    try {
      validateNewDraft(r.to, r.subject, r.body);
    } catch (e) {
      throw new OpError("usage", `${at}: ${(e as Error).message}`);
    }
    if (specs.length === MAX_BATCH) throw new OpError("usage", `batch exceeds ${MAX_BATCH} drafts`);
    specs.push({ to: r.to, subject: r.subject, body: r.body });
  }
  if (!specs.length) throw new OpError("usage", "batch file has no drafts");
  return specs;
}

/** Saves drafts in order on one session. A failure reports how many were already saved. */
export async function saveNewDrafts(s: Session, specs: NewDraftSpec[]) {
  const drafts: Array<{ to: string; subject: string }> = [];
  for (const [i, d] of specs.entries()) {
    try {
      drafts.push(await saveNewDraft(s, d.to, d.subject, d.body));
    } catch (e) {
      const code = e instanceof OpError ? e.code : "imap";
      throw new OpError(
        code,
        `saved ${drafts.length} of ${specs.length} drafts; stopped at draft ${i + 1}: ${
          e instanceof OpError ? e.message : "append failed"
        }`,
      );
    }
  }
  return { saved: true, folder: "drafts", count: drafts.length, drafts };
}
