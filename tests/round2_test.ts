import { assert, assertEquals, assertRejects } from "@std/assert";
import type { BrokerConfig } from "../src/config.ts";
import { run } from "../src/cli.ts";
import { ImapClient, ImapCommandError, ProtocolError } from "../src/imap/client.ts";
import { fetchMessage } from "../src/ops/fetch.ts";
import { handledCheck } from "../src/ops/handled_check.ts";
import { listNew, toUidSet } from "../src/ops/list_new.ts";
import { saveDraft } from "../src/ops/save_draft.ts";
import { validMessageId } from "../src/headers.ts";
import { OpError, type Session } from "../src/session.ts";
import { type FakeFolder, FakeImapServer, makeFolder, makeTestCerts } from "./support/fake_imap.ts";
import { type Harness, PASSWORD, rfc822, standardFolders, startHarness, USER } from "./support/harness.ts";
import { makeCtx, type TestCtx } from "./support/ctx.ts";

type Msg = { uid?: number; flags?: string[]; raw: string };

function mail(extra: Record<string, string> = {}, body = "Hi\n"): string {
  return rfc822({
    From: "Alice <alice@example.com>",
    Subject: "Hello",
    "Message-ID": "<m@example.com>",
    ...extra,
  }, body);
}

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

async function withSession(
  folders: FakeFolder[],
  fn: (env: { s: Session; h: Harness; ctx: TestCtx }) => Promise<void>,
  opts: { limits?: Partial<BrokerConfig["limits"]> } = {},
): Promise<void> {
  const h = await startHarness(folders);
  try {
    const ctx = await makeCtx(h, opts.limits ?? {});
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

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const MULTI_BOUNDARY = "slipmail-round2-boundary";

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

/** Plain-text message with a Reply-To header, for save-draft cases. */
function replyMail(replyTo: string | null): string {
  const headers: Record<string, string> = {
    From: "Alice <alice@example.com>",
    Subject: "Question",
    "Message-ID": "<q1@example.com>",
  };
  if (replyTo !== null) headers["Reply-To"] = replyTo;
  return rfc822(headers, "Can you help?\n");
}

// ---------------------------------------------------------------- validMessageId

Deno.test("round2 validMessageId: accepts a plain printable-ASCII Message-ID", () => {
  assert(validMessageId("<a1@example.com>"));
  assert(validMessageId("<" + "a".repeat(200) + ">"));
});

Deno.test("round2 validMessageId: rejects non-ASCII, spaces, quotes, backslash, nested brackets, empty, oversize, null", () => {
  const bad = [
    "<é@example.com>",
    "<a b@example.com>",
    '<a"b@example.com>',
    "<a\\b@example.com>",
    "<<x>",
    "<>",
    "<" + "a".repeat(201) + ">",
    "",
  ];
  for (const s of bad) assertEquals(validMessageId(s), false, `expected rejection of ${JSON.stringify(s)}`);
  assertEquals(validMessageId(null), false);
  assertEquals(validMessageId(undefined), false);
});

// ---------------------------------------------------------------- handled-check

Deno.test("round2 handled-check: non-ASCII or unusable Message-ID in Inbox does not throw; messageId null, sentReply false", async () => {
  for (const id of ["<a b@example.com>", "<é@example.com>", '<a"b@example.com>']) {
    const inbox = [{ uid: 1, raw: mail({ "Message-ID": id }) }];
    await withSession(mailbox({ inbox }), async ({ s }) => {
      const r = await handledCheck(s, 1);
      assertEquals(r.messageId, null, `messageId for ${id}`);
      assertEquals(r.sentReply, false);
      assertEquals(r.movedOutOfInbox, false);
    });
  }
});

// ---------------------------------------------------------------- toUidSet

Deno.test("round2 toUidSet: compacts ascending UIDs into IMAP set syntax", () => {
  assertEquals(toUidSet([]), "");
  assertEquals(toUidSet([5]), "5");
  assertEquals(toUidSet([1, 2, 3]), "1:3");
  assertEquals(toUidSet([1, 2, 3, 7, 9, 10]), "1:3,7,9:10");
});

// ---------------------------------------------------------------- list-new

Deno.test("round2 list-new: 120 messages with UID gaps are all returned ascending, fetched in chunks", async () => {
  const inbox = Array.from({ length: 120 }, (_, i) => {
    const uid = 1 + 2 * i;
    return { uid, raw: mail({ "Message-ID": `<gap${uid}@example.com>`, Subject: `Gap ${uid}` }) };
  });
  await withSession(mailbox({ inbox }), async ({ s, h }) => {
    const before = h.server.commandLog.length;
    const r = await listNew(s, 0);
    assertEquals(r.messages.length, 120);
    assertEquals(r.messages.map((m) => m.uid), inbox.map((m) => m.uid));
    assertEquals(r.truncated, false);
    const fetches = h.server.commandLog.slice(before).filter((c) => c === "UID FETCH").length;
    assert(fetches >= 3, `expected at least 3 UID FETCH commands for 120 messages, got ${fetches}`);
  }, { limits: { maxListed: 120 } });
});

Deno.test("round2 list-new: afterUid 4294967295 returns empty without UID SEARCH or UID FETCH", async () => {
  const inbox = [1, 2].map((uid) => ({ uid, raw: mail({ "Message-ID": `<top${uid}@example.com>` }) }));
  await withSession(mailbox({ inbox }), async ({ s, h }) => {
    const before = h.server.commandLog.length;
    const r = await listNew(s, 4294967295);
    assertEquals(r.messages, []);
    assertEquals(r.truncated, false);
    const issued = h.server.commandLog.slice(before);
    assertEquals(issued.includes("UID SEARCH"), false, `unexpected UID SEARCH in ${issued}`);
    assertEquals(issued.includes("UID FETCH"), false, `unexpected UID FETCH in ${issued}`);
  });
});

Deno.test("round2 CLI list-new: --after-uid 4294967296 is a usage error (exit 2)", async () => {
  const h = await startHarness(standardFolders([{ raw: mail() }]));
  try {
    const ctx = await makeCtx(h);
    try {
      const writes: string[] = [];
      const code = await run(["list-new", "--after-uid", "4294967296"], ctx.config, {
        secrets: ctx.secrets,
        readStdin: () => Promise.resolve(new Uint8Array(0)),
        write: (j) => writes.push(j),
      });
      assertEquals(code, 2);
      assertEquals(writes.length, 1);
      const doc = JSON.parse(writes[0]);
      assertEquals(doc.ok, false);
      assertEquals(doc.error.code, "usage");
    } finally {
      await ctx.cleanup();
    }
  } finally {
    await h.close();
  }
});

Deno.test("round2 CLI list-new: --after-uid 4294967295 succeeds with an empty list (exit 0)", async () => {
  const h = await startHarness(standardFolders([{ raw: mail() }]));
  try {
    const ctx = await makeCtx(h);
    try {
      const writes: string[] = [];
      const code = await run(["list-new", "--after-uid", "4294967295"], ctx.config, {
        secrets: ctx.secrets,
        readStdin: () => Promise.resolve(new Uint8Array(0)),
        write: (j) => writes.push(j),
      });
      assertEquals(code, 0);
      assertEquals(writes.length, 1);
      const doc = JSON.parse(writes[0]);
      assertEquals(doc.ok, true);
      assertEquals(doc.messages, []);
    } finally {
      await ctx.cleanup();
    }
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- save-draft

Deno.test("round2 save-draft: invalid first Reply-To entry, valid second entry -> draft goes to the valid address", async () => {
  const inbox = [{ uid: 1, raw: replyMail('"bad" <bad@@example.com>, ok@example.com') }];
  await withSession(mailbox({ inbox }), async ({ s, h }) => {
    const r = await saveDraft(s, 1, "Yes.\n");
    assertEquals(r.to, "ok@example.com");
    assertEquals(h.server.folder("Drafts").messages.length, 1);
  });
});

Deno.test("round2 save-draft: Reply-To with only an invalid address falls back to a valid From", async () => {
  const inbox = [{ uid: 1, raw: replyMail("bad@@example.com") }];
  await withSession(mailbox({ inbox }), async ({ s, h }) => {
    const r = await saveDraft(s, 1, "Yes.\n");
    assertEquals(r.to, "alice@example.com");
    assertEquals(h.server.folder("Drafts").messages.length, 1);
  });
});

Deno.test("round2 save-draft: invalid Reply-To and invalid From -> bad_recipient, nothing appended", async () => {
  const inbox = [{ uid: 1, raw: replyMail("bad@@example.com") }];
  inbox[0].raw = inbox[0].raw.replace("From: Alice <alice@example.com>", "From: Alice <alice@@example.com>");
  await withSession(mailbox({ inbox }), async ({ s, h }) => {
    await expectOpError(() => saveDraft(s, 1, "Yes.\n"), "bad_recipient");
    assertEquals(h.server.folder("Drafts").messages.length, 0);
  });
});

// ---------------------------------------------------------------- login

Deno.test("round2 login: no AUTH=PLAIN and non-ASCII password -> ImapCommandError, no LOGIN sent", async () => {
  const h = await startHarness(standardFolders(), {
    capabilities: ["IMAP4rev1", "SPECIAL-USE", "UIDPLUS"],
  });
  try {
    const client = await h.connect();
    try {
      const err = await assertRejects(
        () => client.login(USER, "pässword-not-real"),
        ImapCommandError,
      );
      assert(err.message.includes("non-ASCII"), `message was: ${err.message}`);
      assertEquals(h.server.commandLog.includes("LOGIN"), false);
    } finally {
      await client.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("round2 login: no AUTH=PLAIN and non-ASCII user -> ImapCommandError, no LOGIN sent", async () => {
  const h = await startHarness(standardFolders(), {
    capabilities: ["IMAP4rev1", "SPECIAL-USE", "UIDPLUS"],
  });
  try {
    const client = await h.connect();
    try {
      await assertRejects(() => client.login("jöhn@example.test", PASSWORD), ImapCommandError, "non-ASCII");
      assertEquals(h.server.commandLog.includes("LOGIN"), false);
    } finally {
      await client.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("round2 login: no AUTH=PLAIN with ASCII credentials falls back to LOGIN and succeeds", async () => {
  const h = await startHarness(standardFolders(), {
    capabilities: ["IMAP4rev1", "SPECIAL-USE", "UIDPLUS"],
  });
  try {
    const client = await h.connect();
    try {
      await client.login(USER, PASSWORD);
      assert(h.server.commandLog.includes("LOGIN"), "expected a LOGIN command");
      assertEquals(h.server.commandLog.includes("AUTHENTICATE"), false);
    } finally {
      await client.logout();
    }
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- logout after transport failure

Deno.test("round2 logout: after a transport failure it resolves promptly and never sends a second LOGOUT", async () => {
  // Own server instead of startHarness: the test closes the server itself, and the harness would close it twice.
  const dir = await Deno.makeTempDir({ prefix: "slipmail-test-" });
  try {
    const { cert, key, ca } = await makeTestCerts(dir);
    const server = new FakeImapServer({
      user: USER,
      password: PASSWORD,
      cert,
      key,
      folders: standardFolders(),
    });
    try {
      const client = await ImapClient.connect({ host: "127.0.0.1", port: server.port, ca, timeoutMs: 300 });
      await client.login(USER, PASSWORD);
      await server.close();
      // The next command fails at the transport layer (connection closed by the server).
      await assertRejects(() => client.examine("INBOX"), ProtocolError);

      const started = performance.now();
      await client.logout();
      const elapsed = performance.now() - started;
      assert(elapsed < 1000, `logout took ${elapsed} ms`);
      assertEquals(server.commandLog.filter((c) => c === "LOGOUT").length, 0);
    } finally {
      await server.close().catch(() => {});
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------- fetch attachment bytes

Deno.test("round2 fetch: binary PNG-signature attachment is saved with byte-identical content", async () => {
  const png = new Uint8Array(28);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Arbitrary binary tail: includes NUL, 0xff and CR/LF bytes that a string round trip would mangle.
  for (let i = 8; i < png.length; i++) png[i] = (i * 37 + 11) & 0xff;
  png[12] = 0x00;
  png[13] = 0xff;
  png[14] = 0x0d;
  png[15] = 0x0a;
  const inbox = [{
    uid: 1,
    raw: multipartMail([attachmentPart("x.png", "image/png", png)]),
  }];
  await withSession(mailbox({ inbox }), async ({ s }) => {
    const r = await fetchMessage(s, 1);
    assertEquals(r.attachments.length, 1);
    const att = r.attachments[0];
    assertEquals(att.skippedReason, undefined);
    assertEquals(att.saved, true);
    assertEquals(att.size, png.length);
    assert(att.path !== undefined, "saved attachment has no path");
    const onDisk = await Deno.readFile(att.path);
    assertEquals(onDisk, png);
  });
});
