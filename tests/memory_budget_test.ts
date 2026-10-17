import { assertEquals } from "@std/assert";
import { HEADER_PARTIAL_BYTES } from "../src/imap/client.ts";
import { listNew } from "../src/ops/list_new.ts";
import { makeCtx } from "./support/ctx.ts";
import { PASSWORD, rfc822, standardFolders, startHarness, USER } from "./support/harness.ts";

// A Subject folded over many lines, far larger than the header budget.
const hugeSubject = Array.from({ length: 40_000 }, () => "word-word-word-word-word").join("\r\n ");
const hostile = rfc822({
  From: "Eve <eve@example.com>",
  Subject: hugeSubject,
  "Message-ID": "<big@example.com>",
}, "x\n");
const normal = rfc822(
  { From: "Bob <bob@example.com>", Subject: "hi", "Message-ID": "<ok@example.com>" },
  "x\n",
);

Deno.test("header fetch is bounded: a multi-megabyte header block is truncated by the partial fetch", async () => {
  const h = await startHarness(standardFolders([{ uid: 1, raw: hostile }]));
  try {
    const c = await h.connect();
    await c.login(USER, PASSWORD);
    await c.examine("INBOX");
    const [row] = await c.uidFetch("1", { headerFields: ["From", "Subject"] });
    assertEquals(hostile.length > 1_000_000, true);
    assertEquals(row.header!.length <= HEADER_PARTIAL_BYTES, true);
    await c.logout();
  } finally {
    await h.close();
  }
});

Deno.test("list-new survives a hostile oversized header and returns capped, clean output", async () => {
  const h = await startHarness(standardFolders([{ uid: 1, raw: hostile }, { uid: 2, raw: normal }]));
  const ctx = await makeCtx(h);
  try {
    const s = await ctx.open();
    try {
      const r = await listNew(s, 0);
      assertEquals(r.messages.map((m) => m.uid), [1, 2]);
      assertEquals(r.messages[0].subject.length <= 300, true);
      assertEquals(r.messages[1].subject, "hi");
    } finally {
      await s.client.logout();
    }
  } finally {
    await ctx.cleanup();
    await h.close();
  }
});

Deno.test("smoke: fake server tolerates a client that drops without LOGOUT", async () => {
  const h = await startHarness();
  try {
    const c = await h.connect();
    await c.login(USER, PASSWORD);
    // Simulate a transport drop: close the client's socket without LOGOUT.
    (c as unknown as { conn: Deno.Conn }).conn.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await h.close();
  }
});
