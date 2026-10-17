import { assertEquals } from "@std/assert";
import { writeAll } from "../src/imap/client.ts";
import { WireReader } from "../src/imap/protocol.ts";
import { parseHeaders } from "../src/headers.ts";
import { htmlToText } from "../src/ops/fetch.ts";
import { handledCheck } from "../src/ops/handled_check.ts";
import { saveDraft } from "../src/ops/save_draft.ts";
import { makeFolder } from "./support/fake_imap.ts";
import { makeCtx } from "./support/ctx.ts";
import { rfc822, startHarness } from "./support/harness.ts";

const enc = new TextEncoder();

Deno.test("writeAll: keeps writing when the socket accepts only a prefix", async () => {
  const got: number[] = [];
  const w = {
    write(p: Uint8Array) {
      const n = Math.min(3, p.length);
      got.push(...p.subarray(0, n));
      return Promise.resolve(n);
    },
  };
  const data = enc.encode('s1 APPEND "Drafts" {10}\r\n');
  await writeAll(w, data);
  assertEquals(new Uint8Array(got), data);
});

Deno.test("WireReader.readExact: large literal arrives intact and in linear time", async () => {
  const size = 25 * 1024 * 1024;
  let sent = 0;
  const src = {
    read(p: Uint8Array) {
      if (sent >= size + 2) return Promise.resolve(null);
      const n = Math.min(65536, p.length, size + 2 - sent);
      for (let i = 0; i < n; i++) p[i] = (sent + i) % 251;
      sent += n;
      return Promise.resolve(n);
    },
  };
  const r = new WireReader(src, 5000);
  const t0 = performance.now();
  const out = await r.readExact(size);
  const ms = performance.now() - t0;
  assertEquals(out.length, size);
  assertEquals([out[0], out[250], out[251], out[size - 1]], [0, 250, 0, (size - 1) % 251]);
  assertEquals(ms < 3000, true, `took ${ms} ms`);
});

Deno.test("htmlToText: drops script/style/head and comments, keeps text and literal <", () => {
  const t = htmlToText(
    "<html><head><title>T</title></head><body><!-- c --><p>Hello</p><script>evil()</script>a < b &amp; c<br>next</body>",
  );
  assertEquals(t.includes("evil"), false);
  assertEquals(t.includes("<title>"), false);
  assertEquals(t.includes("T\n") || t.startsWith("T"), false);
  assertEquals(t.replace(/\n /g, "\n"), "Hello\na < b & c\nnext");
});

Deno.test("htmlToText: adversarial input is processed in linear time", () => {
  const cases = [
    "<script>".repeat(400_000),
    "<style>x".repeat(400_000),
    "<".repeat(2_000_000),
    "<a ".repeat(600_000),
    "<!--".repeat(500_000),
    "<script></script".repeat(200_000),
  ];
  for (const c of cases) {
    const t0 = performance.now();
    htmlToText(c);
    const ms = performance.now() - t0;
    assertEquals(ms < 2000, true, `${c.slice(0, 12)} took ${ms} ms`);
  }
});

Deno.test("htmlToText: unterminated constructs end the scan", () => {
  assertEquals(htmlToText("keep<script>drop"), "keep");
  assertEquals(htmlToText("keep<div class='x"), "keep");
  assertEquals(htmlToText("keep<!-- never closed"), "keep");
});

Deno.test("parseHeaders: an over-long address is dropped, never truncated", async () => {
  const long = "a".repeat(250) + "@example.com";
  const header = enc.encode(`From: <${long}>\r\nReply-To: <${long}>\r\nSubject: s\r\n\r\n`);
  const h = await parseHeaders({ seq: 1, uid: 1, flags: [], header });
  assertEquals(h.from, null);
  assertEquals(h.replyTo, []);
});

Deno.test("save-draft: over-long Reply-To falls back to From instead of a truncated address", async () => {
  const long = "a".repeat(250) + "@example.com";
  const raw = rfc822(
    { From: "Bob <bob@example.com>", "Reply-To": `<${long}>`, Subject: "Q", "Message-ID": "<q@example.com>" },
    "hi\n",
  );
  const h = await startHarness([
    makeFolder("INBOX", undefined, [{ uid: 1, raw }]),
    makeFolder("Sent Items", "\\Sent"),
    makeFolder("Drafts", "\\Drafts"),
  ]);
  const ctx = await makeCtx(h);
  try {
    const s = await ctx.open();
    try {
      const r = await saveDraft(s, 1, "ok");
      assertEquals(r.to, "bob@example.com");
    } finally {
      await s.client.logout();
    }
  } finally {
    await ctx.cleanup();
    await h.close();
  }
});

Deno.test("handled-check: Message-ID matching is exact, not a case-insensitive substring", async () => {
  const inbox = [{
    uid: 5,
    raw: rfc822({ From: "a@example.com", "Message-ID": "<abc@example.com>" }, "x\n"),
  }];
  const sent = [{
    uid: 1,
    raw: rfc822({
      From: "me@example.test",
      "In-Reply-To": "<ABC@example.com>",
      "Message-ID": "<s1@example.test>",
    }, "r\n"),
  }];
  const archive = [{ uid: 1, raw: rfc822({ "Message-ID": "<ABC2@example.com>" }, "x\n") }];
  const h = await startHarness([
    makeFolder("INBOX", undefined, inbox),
    makeFolder("Sent Items", "\\Sent", sent),
    makeFolder("Drafts", "\\Drafts"),
    makeFolder("Archive", "\\Archive", archive),
  ]);
  const ctx = await makeCtx(h);
  try {
    const s = await ctx.open();
    try {
      const wrongCase = await handledCheck(s, 5);
      assertEquals(wrongCase.sentReply, false);
      assertEquals(wrongCase.handled, false);
      // Gone from the Inbox: the Archive holds only a differently-cased / longer id, which must not match.
      const gone = await handledCheck(s, 4, { messageId: "<abc2@example.com>" });
      assertEquals(gone.foundInArchive, false);
      const exact = await handledCheck(s, 4, { messageId: "<ABC2@example.com>" });
      assertEquals(exact.foundInArchive, true);
    } finally {
      await s.client.logout();
    }
  } finally {
    await ctx.cleanup();
    await h.close();
  }
});

Deno.test("uidFetch: merges interleaved fragments by UID and returns only requested UIDs", async () => {
  const mk = (id: string) =>
    rfc822({ From: "a@example.com", Subject: id, "Message-ID": `<${id}@example.com>` }, "body\n");
  const h = await startHarness(
    [
      makeFolder("INBOX", undefined, [{ uid: 1, raw: mk("one") }, {
        uid: 2,
        raw: mk("two"),
        flags: ["\\Answered"],
      }]),
      makeFolder("Sent Items", "\\Sent"),
      makeFolder("Drafts", "\\Drafts"),
    ],
    { interleaveFetch: true },
  );
  try {
    const c = await h.connect();
    await c.login("me@example.test", "test-password-not-real");
    await c.examine("INBOX");
    const rows = await c.uidFetch("2", { flags: true, headerFields: ["Subject"] });
    assertEquals(rows.length, 1);
    assertEquals(rows[0].uid, 2);
    assertEquals(rows[0].flags, ["\\Answered"]);
    assertEquals(new TextDecoder().decode(rows[0].header).includes("Subject: two"), true);
    const all = await c.uidFetch("1:2", { headerFields: ["Subject"] });
    assertEquals(all.map((r) => r.uid).sort(), [1, 2]);
    await c.logout();
  } finally {
    await h.close();
  }
});

Deno.test("htmlToText: non-ASCII characters whose lowercase changes length do not shift offsets", () => {
  assertEquals(
    htmlToText("İ<script>hidden()</script><p>Visible</p>").trim(),
    "İ\nVisible",
  );
  assertEquals(htmlToText("İİİ<SCRIPT>x</SCRIPT>after").includes("x"), false);
  assertEquals(htmlToText("İ<b>bold</b>"), "İbold");
});

Deno.test("htmlToText: an omitted </head> does not discard the body", () => {
  const out = htmlToText(
    '<html><head><meta charset="utf-8"><title>t</title><body><p>Hello</p><p>World</p></body></html>',
  );
  assertEquals(out.includes("Hello"), true);
  assertEquals(out.includes("World"), true);
  assertEquals(out.includes("<meta"), false);
});

Deno.test("htmlToText: unclosed <li>/<p> elements stay on separate lines", () => {
  assertEquals(htmlToText("<ul><li>Item 1<li>Item 2</ul>"), "Item 1\nItem 2");
});
