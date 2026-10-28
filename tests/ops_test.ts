import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import PostalMime from "postal-mime";
import type { BrokerConfig } from "../src/config.ts";
import { fetchMessage } from "../src/ops/fetch.ts";
import { handledCheck } from "../src/ops/handled_check.ts";
import { listNew } from "../src/ops/list_new.ts";
import { parseBatch, saveDraft, saveNewDraft, saveNewDrafts } from "../src/ops/save_draft.ts";
import { ImapCommandError, ProtocolError } from "../src/imap/client.ts";
import { OpError, type Session } from "../src/session.ts";
import { type FakeFolder, makeFolder } from "./support/fake_imap.ts";
import { draftParts, type Harness, rfc822, startHarness, USER } from "./support/harness.ts";
import { makeCtx, type TestCtx } from "./support/ctx.ts";

const enc = new TextEncoder();

/** Verbs the broker may put on the wire. Anything else in the server log is a failure. */
const ALLOWED_VERBS = new Set([
  "CAPABILITY",
  "AUTHENTICATE",
  "LOGIN",
  "LIST",
  "EXAMINE",
  "UID FETCH",
  "UID SEARCH",
  "APPEND",
  "LOGOUT",
]);

type Msg = { uid?: number; flags?: string[]; raw: string };

function mail(extra: Record<string, string> = {}, body = "Hi\n"): string {
  return rfc822({
    From: "Alice <alice@example.com>",
    Subject: "Hello",
    "Message-ID": "<m@example.com>",
    ...extra,
  }, body);
}

/** Mailboxes with the standard special-use names; each folder takes its own message list. */
function mailbox(
  opts: { inbox?: Msg[]; sent?: Msg[]; drafts?: Msg[]; archive?: Msg[] } = {},
): FakeFolder[] {
  return [
    makeFolder("INBOX", undefined, opts.inbox ?? []),
    makeFolder("Sent Items", "\\Sent", opts.sent ?? []),
    makeFolder("Drafts", "\\Drafts", opts.drafts ?? []),
    makeFolder("Archive", "\\Archive", opts.archive ?? []),
  ];
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** RFC 2047 B-encoded word for a UTF-8 string. */
function encWord(s: string): string {
  return `=?UTF-8?B?${b64(enc.encode(s))}?=`;
}

async function withSession(
  folders: FakeFolder[],
  limits: Partial<BrokerConfig["limits"]>,
  fn: (env: { s: Session; h: Harness; ctx: TestCtx }) => Promise<void>,
): Promise<void> {
  const h = await startHarness(folders);
  try {
    const ctx = await makeCtx(h, limits);
    try {
      const s = await ctx.open();
      try {
        await fn({ s, h, ctx });
      } finally {
        await s.client.logout();
      }
    } finally {
      await ctx.cleanup();
    }
  } finally {
    await h.close();
  }
}

async function expectOpError(fn: () => Promise<unknown>, code: string): Promise<void> {
  const err = await assertRejects(fn, OpError);
  assertEquals(err.code, code);
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) out.push(...await filesUnder(p));
    else out.push(p);
  }
  return out;
}

function assertSafeLog(h: Harness): void {
  for (const verb of h.server.commandLog) {
    assert(ALLOWED_VERBS.has(verb), `disallowed verb on the wire: ${verb}`);
  }
}

function draftCount(h: Harness): number {
  return h.server.folder("Drafts").messages.length;
}

function inboxSnapshot(h: Harness): string {
  return JSON.stringify(h.server.folder("INBOX").messages.map((m) => [m.uid, m.flags]));
}

async function parseDraft(h: Harness, index = -1) {
  const m = h.server.folder("Drafts").messages.at(index);
  assert(m, "no draft was appended");
  const parsed = await PostalMime.parse(enc.encode(m.raw));
  return { flags: m.flags, raw: m.raw, parsed };
}

// ---------------------------------------------------------------- list-new

Deno.test("list-new: returns only uid > afterUid, ascending, with decoded subject", async () => {
  const inbox = [1, 2, 3, 4, 5].map((uid) => ({
    uid,
    raw: mail({
      "Message-ID": `<m${uid}@example.com>`,
      Subject: uid === 3 ? encWord("Rechnung für März") : `Message ${uid}`,
    }),
  }));
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    const r = await listNew(s, 2);
    assertEquals(r.uidValidity, 1001);
    assertEquals(r.messages.map((m) => m.uid), [3, 4, 5]);
    assertEquals(r.messages[0].subject, "Rechnung für März");
    assertEquals(r.messages[0].messageId, "<m3@example.com>");
    assertEquals(r.messages[1].subject, "Message 4");
    assertEquals(r.truncated, false);
  });
});

Deno.test("list-new: afterUid above every uid returns an empty list", async () => {
  const inbox = [1, 2, 3].map((uid) => ({ uid, raw: mail({ "Message-ID": `<m${uid}@example.com>` }) }));
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    const r = await listNew(s, 100);
    assertEquals(r.messages, []);
    assertEquals(r.truncated, false);
  });
});

Deno.test("list-new: maxListed caps the result and sets truncated", async () => {
  const inbox = [1, 2, 3, 4, 5].map((uid) => ({ uid, raw: mail({ "Message-ID": `<m${uid}@example.com>` }) }));
  await withSession(mailbox({ inbox }), { maxListed: 2 }, async ({ s }) => {
    const r = await listNew(s, 0);
    assertEquals(r.messages.map((m) => m.uid), [1, 2]);
    assertEquals(r.truncated, true);
  });
});

Deno.test("list-new: control and bidi characters are stripped from subjects", async () => {
  const inbox = [{ uid: 1, raw: mail({ Subject: encWord("Pay\u202E\u0007 now\u200B") }) }];
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    const r = await listNew(s, 0);
    assertEquals(r.messages.length, 1);
    const subject = r.messages[0].subject;
    assert(/Pay/.test(subject) && /now/.test(subject), `unexpected subject: ${JSON.stringify(subject)}`);
    assert(
      // deno-lint-ignore no-control-regex
      !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(subject),
      `control or bidi character survived: ${JSON.stringify(subject)}`,
    );
  });
});

// ---------------------------------------------------------------- fetch

Deno.test("fetch: plain-text message returns body, untrusted flag and identifiers", async () => {
  const inbox = [{
    uid: 1,
    raw: mail({ "Message-ID": "<plain1@example.com>", Subject: "Plain" }, "Hello there.\n"),
  }];
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    const r = await fetchMessage(s, 1);
    assertEquals(r.untrusted, true);
    assertEquals(r.uid, 1);
    assertEquals(r.uidValidity, 1001);
    assertEquals(r.messageId, "<plain1@example.com>");
    assertEquals(r.body.trim(), "Hello there.");
    assertEquals(r.bodySource, "plain");
    assertEquals(r.from?.address, "alice@example.com");
    assertEquals(r.attachments, []);
  });
});

Deno.test("fetch: html-only message is stripped to text without script contents", async () => {
  const html = "<html><head><title>T</title></head><body>" +
    "<script>alert('pwned')</script><p>Hello <b>world</b></p>" +
    "<style>p { color: red }</style></body></html>\n";
  const inbox = [{ uid: 1, raw: mail({ "Content-Type": "text/html; charset=utf-8" }, html) }];
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    const r = await fetchMessage(s, 1);
    assertEquals(r.bodySource, "html-stripped");
    assert(r.body.includes("Hello"), `body: ${JSON.stringify(r.body)}`);
    assert(r.body.includes("world"), `body: ${JSON.stringify(r.body)}`);
    assert(!/[<>]/.test(r.body), `tags survived: ${JSON.stringify(r.body)}`);
    assert(!r.body.includes("alert"), `script contents survived: ${JSON.stringify(r.body)}`);
    assert(!r.body.includes("color"), `style contents survived: ${JSON.stringify(r.body)}`);
  });
});

const MULTI_BOUNDARY = "slipmail-boundary";

function attachmentPart(filename: string, type: string, bytes: Uint8Array): string {
  return [
    `--${MULTI_BOUNDARY}`,
    `Content-Type: ${type}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(bytes).replace(/(.{76})/g, "$1\n"),
    "",
  ].join("\n");
}

function multipartMail(parts: string[], extra: Record<string, string> = {}): string {
  const text = [`--${MULTI_BOUNDARY}`, "Content-Type: text/plain; charset=utf-8", "", "See attached.", ""]
    .join("\n");
  return mail(
    { "Content-Type": `multipart/mixed; boundary="${MULTI_BOUNDARY}"`, ...extra },
    [text, ...parts, `--${MULTI_BOUNDARY}--`, ""].join("\n"),
  );
}

Deno.test("fetch: real PDF attachment is saved under scratch with identical bytes", async () => {
  const pdf = enc.encode("%PDF-1.4\n%âã\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
  const inbox = [{
    uid: 1,
    raw: multipartMail([attachmentPart("report.pdf", "application/pdf", pdf)], {
      "Message-ID": "<pdf1@example.com>",
    }),
  }];
  await withSession(mailbox({ inbox }), {}, async ({ s, ctx }) => {
    const r = await fetchMessage(s, 1);
    assertEquals(r.attachments.length, 1);
    const att = r.attachments[0];
    assertEquals(att.saved, true);
    assertEquals(att.filename, "report.pdf");
    assert(att.path !== undefined, "saved attachment has no path");
    assert(att.path.startsWith(ctx.config.scratchDir), `path outside scratch: ${att.path}`);
    assertEquals(await Deno.readFile(att.path), pdf);
  });
});

Deno.test("fetch: traversal filename is saved inside scratch with no slashes in the name", async () => {
  const pdf = enc.encode("%PDF-1.4\n%%EOF\n");
  const inbox = [{
    uid: 1,
    raw: multipartMail([attachmentPart("../../evil.pdf", "application/pdf", pdf)], {
      "Message-ID": "<evil1@example.com>",
    }),
  }];
  await withSession(mailbox({ inbox }), {}, async ({ s, ctx }) => {
    const r = await fetchMessage(s, 1);
    assertEquals(r.attachments.length, 1);
    const att = r.attachments[0];
    assert(!att.filename.includes("/") && !att.filename.includes("\\"), `slash in ${att.filename}`);
    assertEquals(att.saved, true);
    assert(att.path !== undefined, "saved attachment has no path");
    const realPath = await Deno.realPath(att.path);
    const realScratch = await Deno.realPath(ctx.scratch);
    assert(realPath.startsWith(realScratch + "/"), `saved outside scratch: ${realPath}`);
  });
});

Deno.test("fetch: run.exe attachment is reported as skipped and never written", async () => {
  const inbox = [{
    uid: 1,
    raw: multipartMail([attachmentPart("run.exe", "application/octet-stream", enc.encode("MZ fake exe"))], {
      "Message-ID": "<exe1@example.com>",
    }),
  }];
  await withSession(mailbox({ inbox }), {}, async ({ s, ctx }) => {
    const r = await fetchMessage(s, 1);
    const att = r.attachments[0];
    assertEquals(att.saved, false);
    assertEquals(att.path, undefined);
    assertEquals(att.skippedReason, "file type not allowed");
    assertEquals((await filesUnder(ctx.scratch)).length, 0);
  });
});

Deno.test("fetch: PDF name with PNG content is skipped and never written", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const inbox = [{
    uid: 1,
    raw: multipartMail([attachmentPart("fake.pdf", "application/pdf", png)], {
      "Message-ID": "<fake1@example.com>",
    }),
  }];
  await withSession(mailbox({ inbox }), {}, async ({ s, ctx }) => {
    const r = await fetchMessage(s, 1);
    const att = r.attachments[0];
    assertEquals(att.saved, false);
    assertEquals(att.skippedReason, "content does not match extension");
    assertEquals((await filesUnder(ctx.scratch)).length, 0);
  });
});

Deno.test("fetch: message over maxMessageBytes is refused before its source is fetched", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<big1@example.com>" }, "x".repeat(2000) + "\n") }];
  await withSession(mailbox({ inbox }), { maxMessageBytes: 200 }, async ({ s, h }) => {
    await expectOpError(() => fetchMessage(s, 1), "too_large");
    // One UID FETCH for the RFC822.SIZE query only; the BODY[] fetch never happens.
    assertEquals(h.server.commandLog.filter((v) => v === "UID FETCH").length, 1);
  });
});

Deno.test("fetch: unknown UID is not_found", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<one@example.com>" }) }];
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    await expectOpError(() => fetchMessage(s, 999), "not_found");
  });
});

Deno.test("fetch: maxAttachments=1 saves the first attachment and skips the second", async () => {
  const inbox = [{
    uid: 1,
    raw: multipartMail([
      attachmentPart("a.txt", "text/plain", enc.encode("alpha\n")),
      attachmentPart("b.txt", "text/plain", enc.encode("beta\n")),
    ], { "Message-ID": "<two1@example.com>" }),
  }];
  await withSession(mailbox({ inbox }), { maxAttachments: 1 }, async ({ s }) => {
    const r = await fetchMessage(s, 1);
    assertEquals(r.attachments.length, 2);
    assertEquals(r.attachments[0].saved, true);
    assertEquals(r.attachments[1].saved, false);
    assertEquals(r.attachments[1].skippedReason, "attachment count limit");
  });
});

// ---------------------------------------------------------------- handled-check

Deno.test("handled-check: \\Answered flag makes the message handled", async () => {
  const inbox = [{ uid: 1, flags: ["\\Answered"], raw: mail({ "Message-ID": "<ans@example.com>" }) }];
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    const r = await handledCheck(s, 1);
    assertEquals(r.answered, true);
    assertEquals(r.handled, true);
    assertEquals(r.movedOutOfInbox, false);
  });
});

Deno.test("handled-check: Sent reply found via In-Reply-To or References only", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<orig@example.com>" }) }];
  const sentIrt = [{
    raw: mail({
      Subject: "Re: Hello",
      "Message-ID": "<s1@example.test>",
      "In-Reply-To": "<orig@example.com>",
    }),
  }];
  const sentRefs = [{
    raw: mail({
      Subject: "Re: Hello",
      "Message-ID": "<s2@example.test>",
      References: "<root@example.com> <orig@example.com>",
    }),
  }];
  await withSession(mailbox({ inbox, sent: sentIrt }), {}, async ({ s }) => {
    const r = await handledCheck(s, 1);
    assertEquals(r.sentReply, true);
    assertEquals(r.handled, true);
  });
  await withSession(mailbox({ inbox, sent: sentRefs }), {}, async ({ s }) => {
    const r = await handledCheck(s, 1);
    assertEquals(r.sentReply, true);
    assertEquals(r.handled, true);
  });
});

Deno.test("handled-check: untouched message is not handled and no flags are set", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<fresh@example.com>" }) }];
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    const r = await handledCheck(s, 1);
    assertEquals(r.answered, false);
    assertEquals(r.sentReply, false);
    assertEquals(r.movedOutOfInbox, false);
    assertEquals(r.foundInArchive, null);
    assertEquals(r.handled, false);
    assertEquals(r.messageId, "<fresh@example.com>");
  });
});

Deno.test("handled-check: UID gone from Inbox but Message-ID found in Archive", async () => {
  const archive = [{ raw: mail({ "Message-ID": "<gone@example.com>" }) }];
  // UID 7 was assigned earlier and has since left the Inbox, so UIDNEXT is already past it.
  const inbox = [{ uid: 9, raw: mail({ "Message-ID": "<later@example.com>" }) }];
  await withSession(mailbox({ inbox, archive }), {}, async ({ s }) => {
    const r = await handledCheck(s, 7, { messageId: "<gone@example.com>" });
    assertEquals(r.movedOutOfInbox, true);
    assertEquals(r.foundInArchive, true);
    assertEquals(r.handled, true);
    assertEquals(r.messageId, "<gone@example.com>");
  });
});

Deno.test("handled-check: uidValidity mismatch is rejected", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<uv@example.com>" }) }];
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    await expectOpError(() => handledCheck(s, 1, { uidValidity: 4242 }), "uidvalidity_changed");
  });
});

Deno.test("handled-check: malformed messageId option is usage error", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<mid@example.com>" }) }];
  await withSession(mailbox({ inbox }), {}, async ({ s }) => {
    await expectOpError(() => handledCheck(s, 1, { messageId: "x y" }), "usage");
  });
});

// ---------------------------------------------------------------- save-draft

Deno.test("save-draft: Reply-To preferred over From; threading and subject are correct", async () => {
  const inbox = [
    {
      uid: 1,
      raw: mail({
        From: "Alice <alice@example.com>",
        "Reply-To": "Help Desk <help@example.test>",
        Subject: "Invoice 42",
        "Message-ID": "<orig1@example.com>",
        References: "<root@example.com>",
      }),
    },
    {
      uid: 2,
      raw: mail({
        From: "Carol <carol@example.com>",
        Subject: "Re: Invoice 42",
        "Message-ID": "<orig2@example.com>",
      }),
    },
  ];
  await withSession(mailbox({ inbox }), {}, async ({ s, h }) => {
    await saveDraft(s, 1, "Thanks, will do.\n");
    const d1 = await parseDraft(h);
    assertEquals(d1.parsed.to?.length, 1);
    assertEquals(d1.parsed.to?.[0].address, "help@example.test");
    assertEquals(d1.parsed.from?.address, USER);
    assertEquals(d1.parsed.subject, "Re: Invoice 42");
    assertEquals(d1.parsed.inReplyTo, "<orig1@example.com>");
    assertEquals((d1.parsed.references ?? "").split(/\s+/), ["<root@example.com>", "<orig1@example.com>"]);
    assert(d1.flags.includes("\\Draft"), `flags: ${d1.flags}`);

    await saveDraft(s, 2, "Hi Carol.\n");
    const d2 = await parseDraft(h);
    assertEquals(d2.parsed.to?.[0].address, "carol@example.com");
    assertEquals(d2.parsed.subject, "Re: Invoice 42");
    assertEquals(draftCount(h), 2);
    assertSafeLog(h);
  });
});

Deno.test("save-draft: non-ASCII body and subject round-trip", async () => {
  const body = "Grüße – 日本語 ✓\nZweite Zeile";
  const inbox = [{
    uid: 1,
    raw: mail({ Subject: encWord("Café résumé ☕"), "Message-ID": "<utf1@example.com>" }),
  }];
  await withSession(mailbox({ inbox }), {}, async ({ s, h }) => {
    await saveDraft(s, 1, body);
    const d = await parseDraft(h);
    assertEquals(d.parsed.subject, "Re: Café résumé ☕");
    assertEquals((d.parsed.text ?? "").replace(/\r\n/g, "\n").trim(), body);
    assertSafeLog(h);
  });
});

Deno.test("save-draft: hostile subject cannot inject a Bcc header or extra recipient", async () => {
  const inbox = [{
    uid: 1,
    raw: mail({
      Subject: encWord("x\r\nBcc: evil@example.com"),
      "Message-ID": "<hostile@example.com>",
    }),
  }];
  await withSession(mailbox({ inbox }), {}, async ({ s, h }) => {
    await saveDraft(s, 1, "Reply body\n");
    const d = await parseDraft(h);
    assertEquals(d.parsed.to?.length, 1);
    assertEquals(d.parsed.to?.[0].address, "alice@example.com");
    assertEquals(d.parsed.bcc, undefined);
    const headerBlock = d.raw.split("\r\n\r\n")[0];
    for (const line of headerBlock.split("\r\n")) {
      assert(!/^bcc:/i.test(line), `Bcc header injected: ${JSON.stringify(line)}`);
    }
    assertSafeLog(h);
  });
});

Deno.test("save-draft: original without Message-ID is refused and nothing is appended", async () => {
  const inbox = [{ uid: 1, raw: rfc822({ From: "Alice <alice@example.com>", Subject: "No id" }, "Hi\n") }];
  await withSession(mailbox({ inbox }), {}, async ({ s, h }) => {
    await expectOpError(() => saveDraft(s, 1, "Hi\n"), "no_message_id");
    assertEquals(draftCount(h), 0);
    assertSafeLog(h);
  });
});

Deno.test("save-draft: unusable From and missing From are refused with bad_recipient", async () => {
  const inbox = [
    { uid: 1, raw: mail({ From: "not an address", "Message-ID": "<bad1@example.com>" }) },
    { uid: 2, raw: rfc822({ Subject: "No from", "Message-ID": "<bad2@example.com>" }, "Hi\n") },
  ];
  await withSession(mailbox({ inbox }), {}, async ({ s, h }) => {
    await expectOpError(() => saveDraft(s, 1, "Hi\n"), "bad_recipient");
    await expectOpError(() => saveDraft(s, 2, "Hi\n"), "bad_recipient");
    assertEquals(draftCount(h), 0);
    assertSafeLog(h);
  });
});

Deno.test("save-draft: empty body and NUL in body are usage errors", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<body1@example.com>" }) }];
  await withSession(mailbox({ inbox }), {}, async ({ s, h }) => {
    await expectOpError(() => saveDraft(s, 1, "   \n\t"), "usage");
    await expectOpError(() => saveDraft(s, 1, "hi\u0000there"), "usage");
    assertEquals(draftCount(h), 0);
    assertSafeLog(h);
  });
});

Deno.test("save-draft: only allowed verbs reach the wire and Inbox is unchanged", async () => {
  const inbox = [{
    uid: 1,
    flags: ["\\Seen", "\\Flagged"],
    raw: mail({ "Message-ID": "<inv1@example.com>", Subject: "Status" }),
  }];
  await withSession(mailbox({ inbox }), {}, async ({ s, h }) => {
    const before = inboxSnapshot(h);
    const beforeCount = h.server.folder("INBOX").messages.length;
    await saveDraft(s, 1, "Status update attached.\n");
    assertSafeLog(h);
    assertEquals(inboxSnapshot(h), before);
    assertEquals(h.server.folder("INBOX").messages.length, beforeCount);
    assertEquals(draftCount(h), 1);
  });
});

// ---------------------------------------------------------------- new-message drafts

const LIMIT = 256 * 1024;

Deno.test("parseBatch: valid JSON lines parse in order; blank lines are skipped", () => {
  const specs = parseBatch(
    '{"to":"a@example.com","subject":"A","body":"one"}\n\n   \r\n{"to":"b@example.com","subject":"B","body":"two"}\n',
    LIMIT,
  );
  assertEquals(specs, [
    { to: "a@example.com", subject: "A", body: "one" },
    { to: "b@example.com", subject: "B", body: "two" },
  ]);
});

Deno.test("parseBatch: an extra key is a usage error naming the line", () => {
  const err = assertThrows(
    () =>
      parseBatch(
        '{"to":"a@example.com","subject":"A","body":"x"}\n{"to":"a@example.com","subject":"A","body":"x","cc":"c@example.com"}',
        LIMIT,
      ),
    OpError,
  );
  assertEquals(err.code, "usage");
  assert(err.message.startsWith("batch line 2:"), err.message);
});

Deno.test("parseBatch: a body over the byte limit is a usage error naming the line", () => {
  const big = "\u00e9".repeat(LIMIT / 2 + 1); // 2 bytes per character, over the limit in bytes
  const line = JSON.stringify({ to: "a@example.com", subject: "A", body: big });
  const err = assertThrows(
    () => parseBatch(`{"to":"a@example.com","subject":"A","body":"ok"}\n${line}`, LIMIT),
    OpError,
  );
  assertEquals(err.code, "usage");
  assertEquals(err.message, `batch line 2: body exceeds ${LIMIT} bytes`);
});

Deno.test("saveNewDraft: appended draft has no threading headers and carries text and html parts", async () => {
  await withSession(mailbox(), {}, async ({ s, h }) => {
    const r = await saveNewDraft(s, "carol@example.com", "Intro", "Hello **Carol**\n\n> quoted");
    assertEquals(r, { to: "carol@example.com", subject: "Intro" });
    const d = await parseDraft(h);
    assertEquals(d.parsed.inReplyTo, undefined);
    assertEquals(d.parsed.references, undefined);
    assert(d.flags.includes("\\Draft"), `flags: ${d.flags}`);
    const parts = draftParts(d.raw);
    assertEquals(parts["text/plain"], "Hello Carol\r\n\r\n> quoted");
    assert(parts["text/html"].includes("<strong>Carol</strong>"));
    assertSafeLog(h);
  });
});

Deno.test("saveNewDrafts: reports count and each saved to/subject", async () => {
  await withSession(mailbox(), {}, async ({ s, h }) => {
    const out = await saveNewDrafts(s, [
      { to: "a@example.com", subject: "A", body: "one" },
      { to: "b@example.com", subject: "B", body: "two" },
    ]);
    assertEquals(out, {
      saved: true,
      folder: "drafts",
      count: 2,
      drafts: [{ to: "a@example.com", subject: "A" }, { to: "b@example.com", subject: "B" }],
    });
    assertEquals(draftCount(h), 2);
    assertSafeLog(h);
  });
});

Deno.test("saveNewDrafts: each client error class keeps its code and the progress prefix", async () => {
  const spec = [{ to: "a@example.com", subject: "A", body: "one" }];
  const cases: Array<[Error, string, string]> = [
    [new ImapCommandError("NO", "[OVERQUOTA] full"), "imap", "[OVERQUOTA] full"],
    [new ProtocolError("connection closed by server"), "protocol", "connection closed by server"],
    [new Error("secret internals"), "internal", "append failed"],
  ];
  for (const [thrown, code, reason] of cases) {
    const stub = {
      client: { appendDraft: () => Promise.reject(thrown) },
      folders: { drafts: "Drafts" },
      config: { mailbox: USER },
    } as unknown as Session;
    const err = await assertRejects(() => saveNewDrafts(stub, spec), OpError);
    assertEquals(err.code, code);
    assertEquals(err.message, `saved 0 of 1 drafts; stopped at draft 1: ${reason}`);
  }
});
