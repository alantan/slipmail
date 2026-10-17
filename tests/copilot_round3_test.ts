import { assert, assertEquals, assertRejects } from "@std/assert";
import { HEADER_PARTIAL_BYTES } from "../src/imap/client.ts";
import { HEADER_FIELDS, messageIds, parseHeaders } from "../src/headers.ts";
import { htmlToText } from "../src/ops/fetch.ts";
import { handledCheck } from "../src/ops/handled_check.ts";
import { listNew } from "../src/ops/list_new.ts";
import { saveDraft } from "../src/ops/save_draft.ts";
import { OpError, type Session } from "../src/session.ts";
import { makeFolder } from "./support/fake_imap.ts";
import { makeCtx, type TestCtx } from "./support/ctx.ts";
import { type Harness, PASSWORD, rfc822, standardFolders, startHarness, USER } from "./support/harness.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A header value of exactly `total` bytes, folded with CRLF SP roughly every 80 bytes. */
function foldedValue(total: number): string {
  const folds = Math.floor(total / 80);
  let left = total - 3 * folds; // each fold is "\r\n " (3 bytes)
  const parts: string[] = [];
  for (let i = 0; i <= folds; i++) {
    const n = Math.floor(left / (folds + 1 - i));
    parts.push("a".repeat(n));
    left -= n;
  }
  return parts.join("\r\n ");
}

const REPLY_TO = "user@example.com.evil.test";
const MID_LINE = "Message-ID: <big@example.com>\r\n";

/**
 * Message-ID, then a folded Subject of `subjectBytes`, then Reply-To. The partial fetch returns the
 * header fields in message order, so the 64 KiB cut position is determined by the bytes above.
 */
function hostileRaw(subjectBytes: number): string {
  return rfc822({
    "Message-ID": "<big@example.com>",
    Subject: foldedValue(subjectBytes),
    "Reply-To": REPLY_TO,
  }, "hi\n");
}

/** Variant A: the 64 KiB partial fetch ends inside the (~70 KiB) Subject. */
const cutInSubject = hostileRaw(70 * 1024);

/** Variant B: the cut lands 9 bytes into the Reply-To address ("user@exa"). */
const cutInAddress = (() => {
  const fixed = enc.encode(MID_LINE).length + "Subject: ".length + "\r\n".length + "Reply-To: ".length;
  // Bytes before the Reply-To value must total 65536 - 9 so that the cut falls 9 bytes into it.
  return hostileRaw(HEADER_PARTIAL_BYTES - 9 - fixed);
})();

const normalRaw = rfc822(
  { From: "Bob <bob@example.com>", Subject: "Q", "Message-ID": "<ok@example.com>" },
  "hi\n",
);

async function withSession(h: Harness, fn: (ctx: TestCtx, s: Session) => Promise<void>, limits = {}) {
  const ctx = await makeCtx(h, limits);
  try {
    const s = await ctx.open();
    try {
      await fn(ctx, s);
    } finally {
      await s.client.logout();
    }
  } finally {
    await ctx.cleanup();
    await h.close();
  }
}

// ---------------------------------------------------------------------------
// 1. Truncated header block must never be used to pick a Reply-To.
// ---------------------------------------------------------------------------

Deno.test("save-draft: cut inside a long Subject rejects with headers_too_large and drafts nothing", async () => {
  const h = await startHarness(standardFolders([{ uid: 1, raw: cutInSubject }]));
  await withSession(h, async (_ctx, s) => {
    const err = await assertRejects(() => saveDraft(s, 1, "body"), OpError);
    assertEquals(err.code, "headers_too_large");
    assertEquals(h.server.folder("Drafts").messages.length, 0);
  });
});

Deno.test("save-draft: cut inside the Reply-To address rejects with headers_too_large and drafts nothing", async () => {
  // Prove the cut really lands inside the address (byte offsets within the raw header block).
  const valueStart = cutInAddress.indexOf("Reply-To: ") + "Reply-To: ".length;
  const valueEnd = valueStart + REPLY_TO.length;
  assertEquals(valueStart, HEADER_PARTIAL_BYTES - 9);
  assert(
    valueStart < HEADER_PARTIAL_BYTES && HEADER_PARTIAL_BYTES < valueEnd,
    "cut must fall inside the address",
  );

  const h = await startHarness(standardFolders([{ uid: 1, raw: cutInAddress }]));
  await withSession(h, async (_ctx, s) => {
    const err = await assertRejects(() => saveDraft(s, 1, "body"), OpError);
    assertEquals(err.code, "headers_too_large");
    assertEquals(h.server.folder("Drafts").messages.length, 0);
  });
});

Deno.test("save-draft: a normal message still drafts fine", async () => {
  const h = await startHarness(standardFolders([{ uid: 1, raw: normalRaw }]));
  await withSession(h, async (_ctx, s) => {
    const r = await saveDraft(s, 1, "ok");
    assertEquals(r.saved, true);
    assertEquals(r.to, "bob@example.com");
    assertEquals(h.server.folder("Drafts").messages.length, 1);
  });
});

Deno.test("uidFetch: oversized header is flagged truncated and cut at a CRLF; normal header is not", async () => {
  for (const raw of [cutInSubject, cutInAddress]) {
    const h = await startHarness(standardFolders([{ uid: 1, raw }]));
    try {
      const c = await h.connect();
      await c.login(USER, PASSWORD);
      await c.examine("INBOX");
      const [row] = await c.uidFetch("1", { headerFields: HEADER_FIELDS });
      assertEquals(row.headerTruncated, true);
      assertEquals(row.header!.length <= HEADER_PARTIAL_BYTES, true);
      assertEquals(row.header!.length >= 2, true);
      assertEquals(row.header![row.header!.length - 2], 13);
      assertEquals(row.header![row.header!.length - 1], 10);
      assertEquals(dec.decode(row.header!).includes("user@"), false, "no partial Reply-To value may survive");
      await c.logout();
    } finally {
      await h.close();
    }
  }

  const h = await startHarness(standardFolders([{ uid: 1, raw: normalRaw }]));
  try {
    const c = await h.connect();
    await c.login(USER, PASSWORD);
    await c.examine("INBOX");
    const [row] = await c.uidFetch("1", { headerFields: HEADER_FIELDS });
    assert(!row.headerTruncated, "a normal header must not be flagged truncated");
    await c.logout();
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Multi-parent In-Reply-To.
// ---------------------------------------------------------------------------

Deno.test("messageIds: returns every valid id in a multi-parent field", () => {
  assertEquals(messageIds("<orig@example.com> <other@example.com>"), [
    "<orig@example.com>",
    "<other@example.com>",
  ]);
});

Deno.test("messageIds: ignores junk around ids", () => {
  assertEquals(messageIds("x <a@example.com>y  <b@example.com>"), ["<a@example.com>", "<b@example.com>"]);
});

Deno.test("messageIds: null and undefined yield an empty list", () => {
  assertEquals(messageIds(null), []);
  assertEquals(messageIds(undefined), []);
});

Deno.test("messageIds: ids with non-ASCII or quotes are dropped", () => {
  assertEquals(messageIds('<é@example.com> <"q"@example.com> <ok@example.com>'), ["<ok@example.com>"]);
});

Deno.test("parseHeaders: multi-parent In-Reply-To yields every parent", async () => {
  const header = enc.encode("In-Reply-To: <orig@example.com> <other@example.com>\r\n\r\n");
  const h = await parseHeaders({ seq: 1, uid: 1, flags: [], header });
  assertEquals(h.inReplyTo, ["<orig@example.com>", "<other@example.com>"]);
});

function handledFixture(inReplyTo: string) {
  const inbox = [{
    uid: 1,
    raw: rfc822({ From: "a@example.com", "Message-ID": "<orig@example.com>" }, "x\n"),
  }];
  const sent = [{
    uid: 1,
    raw: rfc822({
      From: "me@example.test",
      "In-Reply-To": inReplyTo,
      "Message-ID": "<s1@example.test>",
    }, "r\n"),
  }];
  return startHarness([
    makeFolder("INBOX", undefined, inbox),
    makeFolder("Sent Items", "\\Sent", sent),
    makeFolder("Drafts", "\\Drafts"),
  ]);
}

Deno.test("handled-check: a Sent reply whose In-Reply-To lists several parents counts as handled", async () => {
  const h = await handledFixture("<orig@example.com> <other@example.com>");
  await withSession(h, async (_ctx, s) => {
    const r = await handledCheck(s, 1);
    assertEquals(r.sentReply, true);
    assertEquals(r.handled, true);
  });
});

Deno.test("handled-check: the replied-to message may be any parent in In-Reply-To, not just the first", async () => {
  const h = await handledFixture("<other@example.com> <orig@example.com>");
  await withSession(h, async (_ctx, s) => {
    const r = await handledCheck(s, 1);
    assertEquals(r.sentReply, true);
    assertEquals(r.handled, true);
  });
});

Deno.test("handled-check: a Sent message whose In-Reply-To lists only other parents is not a reply", async () => {
  const h = await handledFixture("<other@example.com>");
  await withSession(h, async (_ctx, s) => {
    const r = await handledCheck(s, 1);
    assertEquals(r.sentReply, false);
    assertEquals(r.handled, false);
  });
});

// ---------------------------------------------------------------------------
// 3. htmlToText closing-tag boundaries.
// ---------------------------------------------------------------------------

Deno.test("htmlToText: a </scripture> inside <script> does not close the block", () => {
  const t = htmlToText('<script>const s = "</scripture>"; hidden()</script><p>Visible</p>');
  assert(t.includes("Visible"));
  assertEquals(t.includes("hidden"), false);
  assertEquals(t.includes("scripture"), false);
});

Deno.test("htmlToText: a </stylesheet> inside <style> does not close the block", () => {
  const t = htmlToText("<style>a{} </stylesheet> b{}</style>after");
  assert(t.includes("after"));
  assertEquals(t.includes("stylesheet"), false);
  assertEquals(t.includes("b{}"), false);
});

Deno.test("htmlToText: <script-x> is a different element and its text is kept", () => {
  assert(htmlToText("<script-x>keep</script-x>").includes("keep"));
});

Deno.test("htmlToText: uppercase <SCRIPT> with a space before > is dropped; following text kept", () => {
  assertEquals(htmlToText("<SCRIPT>x</SCRIPT >y"), "y");
});

Deno.test("htmlToText: adversarial </scripture> repetition finishes in linear time", () => {
  const input = "<script></scripture>".repeat(100_000);
  const t0 = performance.now();
  const out = htmlToText(input);
  const ms = performance.now() - t0;
  assertEquals(out, "");
  assert(ms < 2000, `took ${ms} ms`);
});

// ---------------------------------------------------------------------------
// 4. list-new bounded UID discovery.
// ---------------------------------------------------------------------------

const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

function tinyMsg(n: number): string {
  return rfc822({ From: "a@example.com", "Message-ID": `<${n}@example.com>` }, "");
}

Deno.test("list-new: 60,000-message Inbox is discovered in bounded windows and pages forward", async () => {
  const items = Array.from({ length: 60_000 }, (_, i) => ({ raw: tinyMsg(i + 1) }));
  const h = await startHarness(standardFolders(items));
  await withSession(h, async (_ctx, s) => {
    const searchesBefore = h.server.commandLog.filter((c) => c === "UID SEARCH").length;
    const first = await listNew(s, 0);
    const searchesFirst = h.server.commandLog.filter((c) => c === "UID SEARCH").length - searchesBefore;
    assertEquals(first.messages.map((m) => m.uid), range(1, 200));
    assertEquals(first.truncated, true);
    assertEquals(first.nextAfterUid, 200);

    // Paging continues where the previous page stopped.
    const second = await listNew(s, 200);
    assertEquals(second.messages.map((m) => m.uid), range(201, 400));
    assertEquals(second.truncated, true);
    assertEquals(second.nextAfterUid, 400);

    // Case (d): the first call stays within the SEARCH budget; every reply parsed (no ProtocolError).
    assert(searchesFirst >= 1 && searchesFirst <= 40, `UID SEARCH count was ${searchesFirst}`);
  }, { maxListed: 200 });
});

Deno.test("list-new: dense 5-message Inbox is not truncated", async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ raw: tinyMsg(i + 1) }));
  const h = await startHarness(standardFolders(items));
  await withSession(h, async (_ctx, s) => {
    const r = await listNew(s, 0);
    assertEquals(r.messages.map((m) => m.uid), range(1, 5));
    assertEquals(r.truncated, false);
    assertEquals(r.nextAfterUid, null);
  });
});

Deno.test("list-new: sparse high UIDs are found by paging through empty windows", async () => {
  const items = range(0, 4).map((i) => ({ uid: 3_000_000 + i, raw: tinyMsg(i + 1) }));
  const h = await startHarness(standardFolders(items));
  await withSession(h, async (_ctx, s) => {
    const searchesBefore = h.server.commandLog.filter((c) => c === "UID SEARCH").length;
    const first = await listNew(s, 0);
    const searches = h.server.commandLog.filter((c) => c === "UID SEARCH").length - searchesBefore;
    assertEquals(first.messages, []);
    assertEquals(first.truncated, true);
    assert(first.nextAfterUid !== null && first.nextAfterUid > 0, "must make forward progress");
    assert(first.nextAfterUid <= 3_000_000, `nextAfterUid ${first.nextAfterUid} overshot the sparse UIDs`);
    assertEquals(searches, 40, "the first call should exhaust MAX_SEARCHES on empty windows");

    const seen: number[] = [];
    let after = 0;
    let last: Awaited<ReturnType<typeof listNew>> | null = null;
    let next: number | null = first.nextAfterUid;
    for (let i = 0; i < 5 && next !== null; i++) {
      assert(next > after, `nextAfterUid did not increase: ${after} -> ${next}`);
      after = next;
      last = await listNew(s, after);
      seen.push(...last.messages.map((m) => m.uid));
      next = last.nextAfterUid;
      if (!last.truncated) break;
    }
    assertEquals(seen, range(3_000_000, 3_000_004));
    assert(last !== null && last.truncated === false, "scan must complete within 5 iterations");
    assertEquals(last!.nextAfterUid, null);
  });
});
