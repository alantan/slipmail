import { assert, assertEquals } from "@std/assert";
import { listNew } from "../src/ops/list_new.ts";
import { openSession, type Session } from "../src/session.ts";
import { makeCtx, type TestCtx } from "./support/ctx.ts";
import { type Harness, PASSWORD, rfc822, standardFolders, startHarness, USER } from "./support/harness.ts";

function tinyMsg(n: number): string {
  return rfc822({ From: "a@example.com", "Message-ID": `<${n}@example.com>` }, "");
}

function range(lo: number, hi: number): number[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

function count(h: Harness, cmd: string): number {
  return h.server.commandLog.filter((c) => c === cmd).length;
}

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
// PREAUTH greeting: the session starts authenticated and login() must not re-authenticate.
// ---------------------------------------------------------------------------

Deno.test("preauth: client is authenticated after connect and login() is a no-op", async () => {
  const h = await startHarness(standardFolders(), { preauth: true });
  try {
    const c = await h.connect();
    assertEquals(c.authenticated, true);
    await c.login(USER, PASSWORD);
    assertEquals(h.server.commandLog.includes("LOGIN"), false, "no LOGIN may be sent");
    assertEquals(h.server.commandLog.includes("AUTHENTICATE"), false, "no AUTHENTICATE may be sent");

    const folders = await c.list();
    assert(folders.some((f) => f.name === "Sent Items"), "list() must find Sent Items");
    await c.logout();
  } finally {
    await h.close();
  }
});

Deno.test("preauth: openSession succeeds, discovers folders, and sends no LOGIN/AUTHENTICATE", async () => {
  const h = await startHarness(standardFolders(), { preauth: true });
  const ctx = await makeCtx(h);
  try {
    const s = await openSession(ctx.config, ctx.secrets);
    try {
      assertEquals(s.folders.drafts, "Drafts");
      assertEquals(h.server.commandLog.includes("LOGIN"), false);
      assertEquals(h.server.commandLog.includes("AUTHENTICATE"), false);
    } finally {
      await s.client.logout();
    }
  } finally {
    await ctx.cleanup();
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Normal (non-PREAUTH) path: regression guard.
// ---------------------------------------------------------------------------

Deno.test("login: unauthenticated greeting leaves authenticated false until login, and a second login sends nothing", async () => {
  const h = await startHarness(standardFolders());
  try {
    const c = await h.connect();
    assertEquals(c.authenticated, false);
    await c.login(USER, PASSWORD);
    assertEquals(c.authenticated, true);

    const authsBefore = count(h, "LOGIN") + count(h, "AUTHENTICATE");
    assertEquals(authsBefore, 1, "the first login must authenticate exactly once");
    await c.login(USER, PASSWORD);
    assertEquals(
      count(h, "LOGIN") + count(h, "AUTHENTICATE"),
      authsBefore,
      "second login must send no auth command",
    );
    assertEquals(c.authenticated, true);
    await c.logout();
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// list-new without UIDNEXT in EXAMINE.
// ---------------------------------------------------------------------------

Deno.test("list-new no-uidnext: two messages found in few searches, nextAfterUid null, new mail picked up later", async () => {
  const h = await startHarness(
    standardFolders([{ uid: 1, raw: tinyMsg(1) }, { uid: 2, raw: tinyMsg(2) }]),
    { examineStyle: "no-uidnext" },
  );
  await withSession(h, async (_ctx, s) => {
    const before = count(h, "UID SEARCH");
    const r = await listNew(s, 0);
    const searches = count(h, "UID SEARCH") - before;
    assertEquals(r.messages.map((m) => m.uid), [1, 2]);
    assertEquals(r.truncated, false);
    assertEquals(r.nextAfterUid, null);
    assert(searches <= 3, `UID SEARCH count was ${searches}, expected <= 3`);

    // Mail arriving between calls must not be skipped.
    const inbox = h.server.folder("INBOX");
    inbox.messages.push({ uid: 3, flags: [], raw: tinyMsg(3) });
    inbox.nextUid = 4;
    const again = await listNew(s, 2);
    assertEquals(again.messages.map((m) => m.uid), [3]);
    assertEquals(again.truncated, false);
  });
});

Deno.test("list-new no-uidnext: empty Inbox returns nothing and issues no UID SEARCH", async () => {
  const h = await startHarness(standardFolders([]), { examineStyle: "no-uidnext" });
  await withSession(h, async (_ctx, s) => {
    const before = count(h, "UID SEARCH");
    const r = await listNew(s, 0);
    assertEquals(r.messages, []);
    assertEquals(r.truncated, false);
    assertEquals(r.nextAfterUid, null);
    assertEquals(count(h, "UID SEARCH"), before, "no UID SEARCH may be issued for an empty Inbox");
  });
});

Deno.test("list-new no-uidnext: truncated paging never passes the highest UID and reaches all 5 in <= 3 calls", async () => {
  const items = range(1, 5).map((n) => ({ uid: n, raw: tinyMsg(n) }));
  const h = await startHarness(standardFolders(items), { examineStyle: "no-uidnext" });
  await withSession(h, async (_ctx, s) => {
    const seen: number[] = [];
    let after = 0;
    let calls = 0;
    let truncated = true;
    while (truncated && calls < 3) {
      const r = await listNew(s, after);
      calls++;
      seen.push(...r.messages.map((m) => m.uid));
      truncated = r.truncated;
      if (r.truncated) {
        assert(r.nextAfterUid !== null, "a truncated page must carry a cursor");
        assert(r.nextAfterUid! <= 5, `nextAfterUid ${r.nextAfterUid} exceeds the highest UID 5`);
        assert(r.nextAfterUid! > after, "cursor must advance");
        after = r.nextAfterUid!;
      } else {
        assertEquals(r.nextAfterUid, null);
      }
    }
    assertEquals(seen, range(1, 5));
    assert(calls <= 3, `took ${calls} calls`);
  }, { maxListed: 2 });
});

// ---------------------------------------------------------------------------
// Client-level UID SEARCH * (kind "last").
// ---------------------------------------------------------------------------

Deno.test("client uidSearch last: returns the highest UID and is sent as UID SEARCH", async () => {
  const h = await startHarness(standardFolders([
    { uid: 4, raw: tinyMsg(4) },
    { uid: 9, raw: tinyMsg(9) },
    { uid: 12, raw: tinyMsg(12) },
  ]));
  try {
    const c = await h.connect();
    await c.login(USER, PASSWORD);
    await c.examine("INBOX");
    const before = count(h, "UID SEARCH");
    assertEquals(await c.uidSearch({ kind: "last" }), [12]);
    assertEquals(count(h, "UID SEARCH") - before, 1);
    await c.logout();
  } finally {
    await h.close();
  }
});
