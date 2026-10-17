import { assertEquals, assertRejects } from "@std/assert";
import { baseSubject, handledCheck } from "../src/ops/handled_check.ts";
import { parseInternalDate } from "../src/imap/client.ts";
import { ProtocolError } from "../src/imap/protocol.ts";
import { type FakeFolder, makeFolder } from "./support/fake_imap.ts";
import { type Harness, PASSWORD, rfc822, startHarness, USER } from "./support/harness.ts";
import { makeCtx } from "./support/ctx.ts";
import type { Session } from "../src/session.ts";

// A message id with "+" and mixed case, like the ones that exposed the bug.
const ORIG_ID = "<CAx9LBrEq+Zk3=Tm_Pq7Vw-Ab@mail.example.com>";
const RECEIVED = "17-Oct-2026 10:00:00 +0000";

type Msg = { uid?: number; flags?: string[]; raw: string; internalDate?: string };

function original(extra: Record<string, string> = {}): Msg {
  return {
    uid: 1,
    internalDate: RECEIVED,
    raw: rfc822({
      From: "Alice <alice@example.com>",
      To: "me@example.test",
      Cc: "bob@example.com",
      Subject: "Quarterly figures",
      "Message-ID": ORIG_ID,
      ...extra,
    }, "Hi\n"),
  };
}

/** A Sent copy as some webmail stores it: no In-Reply-To, no References. */
function sentCopy(extra: Record<string, string> = {}, internalDate = "17-Oct-2026 10:20:00 +0000"): Msg {
  return {
    internalDate,
    raw: rfc822({
      From: "me@example.test",
      To: "alice@example.com, bob@example.com",
      Subject: "Re: Quarterly figures",
      "Message-ID": "<sent1@example.test>",
      ...extra,
    }, "Thanks\n"),
  };
}

function folders(inbox: Msg[], sent: Msg[]): FakeFolder[] {
  return [
    makeFolder("INBOX", undefined, inbox),
    makeFolder("Sent Items", "\\Sent", sent),
    makeFolder("Drafts", "\\Drafts", []),
    makeFolder("Archive", "\\Archive", []),
  ];
}

async function check(inbox: Msg[], sent: Msg[]) {
  const h: Harness = await startHarness(folders(inbox, sent));
  try {
    const ctx = await makeCtx(h);
    try {
      const s: Session = await ctx.open();
      try {
        return { r: await handledCheck(s, 1), log: h.server.commandLog.slice() };
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

Deno.test("sent fallback: reply without threading headers is found by subject, recipient and date", async () => {
  const { r } = await check([original()], [sentCopy()]);
  assertEquals(r.messageId, ORIG_ID);
  assertEquals(r.sentReply, true);
  assertEquals(r.sentReplyBasis, "subject-and-recipient");
  assertEquals(r.handled, true);
});

Deno.test("sent fallback: exact threading headers still win and are reported as such", async () => {
  const { r } = await check([original()], [sentCopy({ "In-Reply-To": ORIG_ID, References: ORIG_ID })]);
  assertEquals(r.sentReply, true);
  assertEquals(r.sentReplyBasis, "threading-headers");
});

Deno.test("sent fallback: an earlier reply to the same sender and subject does not count", async () => {
  const { r } = await check([original()], [sentCopy({}, "17-Oct-2026 09:59:59 +0000")]);
  assertEquals(r.sentReply, false);
  assertEquals(r.sentReplyBasis, null);
});

Deno.test("sent fallback: a reply sent the previous day is excluded even though SINCE is day-granular", async () => {
  const { r } = await check([original()], [sentCopy({}, "16-Oct-2026 23:59:00 +0000")]);
  assertEquals(r.sentReply, false);
});

Deno.test("sent fallback: needs the Re: prefix, the same base subject and the sender as a recipient", async () => {
  const cases: Record<string, string>[] = [
    { Subject: "Quarterly figures" }, // not a reply
    { Subject: "Re: Something else" },
    { To: "carol@example.com" }, // reply, but not to the sender
    { To: "alice@example.org" }, // look-alike domain
    { To: "xalice@example.com" }, // substring of another address
  ];
  for (const extra of cases) {
    const { r } = await check([original()], [sentCopy(extra)]);
    assertEquals(r.sentReply, false, JSON.stringify(extra));
  }
});

Deno.test("sent fallback: matches Re:/RE: stacking and Cc, case-insensitively", async () => {
  const { r } = await check([original()], [
    sentCopy({ Subject: "RE:  re: QUARTERLY   figures", To: "carol@example.com", Cc: "Alice@Example.com" }),
  ]);
  assertEquals(r.sentReply, true);
});

Deno.test("sent fallback: Reply-To, not From, is the sender to look for", async () => {
  const msg = original({ "Reply-To": "desk@example.com" });
  const wrong = await check([msg], [sentCopy()]); // sent to From, not to Reply-To
  assertEquals(wrong.r.sentReply, false);
  const right = await check([msg], [sentCopy({ To: "desk@example.com" })]);
  assertEquals(right.r.sentReply, true);
});

Deno.test("sent fallback: a forged old Date header cannot make an old reply count", async () => {
  const forged = original({ Date: "Mon, 01 Jan 2024 00:00:00 +0000" });
  const { r } = await check([forged], [
    sentCopy({}, "01-Mar-2025 10:00:00 +0000"),
  ]);
  assertEquals(r.sentReply, false);
});

Deno.test("sent fallback: only read-only verbs went on the wire, and Sent was EXAMINEd", async () => {
  const { log } = await check([original()], [sentCopy()]);
  const allowed = new Set([
    "CAPABILITY",
    "AUTHENTICATE",
    "LOGIN",
    "LIST",
    "EXAMINE",
    "UID FETCH",
    "UID SEARCH",
    "LOGOUT",
  ]);
  for (const verb of log) assertEquals(allowed.has(verb), true, `disallowed verb on the wire: ${verb}`);
  assertEquals(log.filter((v) => v === "UID SEARCH").length >= 1, true);
});

Deno.test("parseInternalDate and baseSubject", () => {
  assertEquals(parseInternalDate("17-Oct-2026 10:00:00 +0000"), Date.UTC(2026, 9, 17, 10));
  assertEquals(parseInternalDate("17-Oct-2026 12:00:00 +0200"), Date.UTC(2026, 9, 17, 10));
  assertEquals(parseInternalDate("nonsense"), null);
  assertEquals(parseInternalDate(undefined), null);
  assertEquals(baseSubject("Re: RE:  Fwd: Hello   World "), "hello world");
  assertEquals(baseSubject("Re:"), "");
});

const PAD = "x".repeat(70_000); // more than the 64 KiB partial header fetch

Deno.test("sent fallback: truncated headers on the original skip the fallback", async () => {
  // From/Subject/Message-ID come before the cut, so without the guard this would match the default Sent copy.
  const { r } = await check([original({ "Reply-To": `${PAD}@example.com` })], [sentCopy()]);
  assertEquals(r.sentReply, false);
});

Deno.test("sent fallback: a Sent message with truncated headers is not trusted", async () => {
  // Subject and To come before the cut, so without the guard this would match.
  const { r } = await check([original()], [sentCopy({ Cc: `${PAD}@example.com` })]);
  assertEquals(r.sentReply, false);
});

Deno.test("sent fallback: empty subject, or an unparseable INTERNALDATE, never matches", async () => {
  const noSubject = await check([original({ Subject: "Re:" })], [sentCopy({ Subject: "Re:" })]);
  assertEquals(noSubject.r.sentReply, false);
  const badDate = await check([{ ...original(), internalDate: "not a date" }], [sentCopy()]);
  assertEquals(badDate.r.sentReply, false);
});

Deno.test("search: an invalid SINCE date is refused before anything is sent", async () => {
  const h = await startHarness(folders([original()], []));
  try {
    const c = await h.connect();
    try {
      await c.login(USER, PASSWORD);
      await c.examine("INBOX");
      await assertRejects(() => c.uidSearch({ kind: "since", day: new Date(NaN) }), ProtocolError, "SINCE");
    } finally {
      await c.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("parseHeaders: an unparseable header block fails closed as truncated instead of throwing", async () => {
  const { parseHeaders } = await import("../src/headers.ts");
  const h = await parseHeaders({
    seq: 1,
    uid: 1,
    flags: [],
    header: new TextEncoder().encode(`To: ${"x".repeat(70_000)}`),
    headerTruncated: true,
  });
  assertEquals(h.truncated, true);
  assertEquals(h.messageId, null);
});
