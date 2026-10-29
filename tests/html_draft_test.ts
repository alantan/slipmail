import { assert, assertEquals, assertRejects } from "@std/assert";
import { escapeHtml, stripBold, textToHtml } from "../src/html_out.ts";
import { buildDraft } from "../src/mime_out.ts";
import { saveDraft } from "../src/ops/save_draft.ts";
import { OpError, type Session } from "../src/session.ts";
import { makeCtx } from "./support/ctx.ts";
import { draftParts, type Harness, rfc822, standardFolders, startHarness } from "./support/harness.ts";

const Q = 'style="margin:0;padding-left:1em;border-left:2px solid #ccc"';
const SP = "<div><br></div>";
const wrap = (inner: string) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${inner}</body></html>`;

// ---------------------------------------------------------------- converter

Deno.test("html: blank-line separated blocks become divs with spacers between, single newlines become <br>", () => {
  assertEquals(
    textToHtml("Hi Alice,\n\nLine one\nLine two\n\n\n\nBye\n"),
    wrap(`<div>Hi Alice,</div>${SP}<div>Line one<br>Line two</div>${SP}<div>Bye</div>`),
  );
});

Deno.test("html: a single block has no spacer and no paragraph tags", () => {
  const html = textToHtml("Only one");
  assertEquals(html, wrap("<div>Only one</div>"));
  const tagNames = (html.match(/<[a-z]+/gi) ?? []).map((t) => t.toLowerCase());
  assert(!tagNames.some((t) => t.slice(1) === "p"), "no paragraph tags");
});

Deno.test("html: CRLF and CR line endings behave like LF", () => {
  assertEquals(textToHtml("a\r\nb\r\n\r\nc\rd"), textToHtml("a\nb\n\nc\nd"));
});

Deno.test("html: a signature block keeps its lines together", () => {
  assertEquals(
    textToHtml("Thanks\n\n-- \nAlan\nExample Co"),
    wrap(`<div>Thanks</div>${SP}<div>-- <br>Alan<br>Example Co</div>`),
  );
});

Deno.test("html: leading spaces become &nbsp; and later spaces are untouched", () => {
  assertEquals(textToHtml("  a  b"), wrap(`<div>&nbsp;&nbsp;a  b</div>`));
  assertEquals(textToHtml("x\n   y"), wrap(`<div>x<br>&nbsp;&nbsp;&nbsp;y</div>`));
});

Deno.test("html: a quote block drops its > prefixes and recurses for deeper levels", () => {
  assertEquals(
    textToHtml("> one\n> two"),
    wrap(`<blockquote ${Q}><div>one<br>two</div></blockquote>`),
  );
  assertEquals(
    textToHtml("> outer\n>\n> > inner\n> > more\n>\n> back"),
    wrap(
      `<blockquote ${Q}><div>outer</div>${SP}<blockquote ${Q}><div>inner<br>more</div></blockquote>` +
        `${SP}<div>back</div></blockquote>`,
    ),
  );
  assertEquals(
    textToHtml(">> deep"),
    wrap(`<blockquote ${Q}><blockquote ${Q}><div>deep</div></blockquote></blockquote>`),
  );
});

Deno.test("html: pathological quote nesting is bounded and does not overflow the stack", () => {
  const html = textToHtml(">".repeat(100_000) + " deep");
  assertEquals(html.match(/<blockquote /g)!.length, 20);
  assert(html.includes("&gt;&gt;&gt;"), "levels past the cap are escaped text");
  assertEquals(html.match(/<blockquote /g)!.length, html.match(/<\/blockquote>/g)!.length);
});

Deno.test("html: a bare quote marker produces no empty blockquote and no stray spacer", () => {
  assertEquals(textToHtml(">\n\nhi"), wrap(`<div>hi</div>`));
  assertEquals(textToHtml("hi\n\n>\n\nthere"), wrap(`<div>hi</div>${SP}<div>there</div>`));
  assertEquals(textToHtml("> \n>"), wrap(""));
});

// ---------------------------------------------------------------- bold

const S = (t: string) => `<strong>${t}</strong>`;

Deno.test("bold: **x** pairs on one line become <strong>, in place", () => {
  assertEquals(textToHtml("**Alan Tanaman**"), wrap(`<div>${S("Alan Tanaman")}</div>`));
  assertEquals(textToHtml("a **b** c **d** e"), wrap(`<div>a ${S("b")} c ${S("d")} e</div>`));
  assertEquals(textToHtml("**Alan**\nExample Co"), wrap(`<div>${S("Alan")}<br>Example Co</div>`));
  assertEquals(textToHtml("  **x**"), wrap(`<div>&nbsp;&nbsp;${S("x")}</div>`));
});

Deno.test("bold: works inside quoted lines", () => {
  assertEquals(
    textToHtml("> **Quoted** name"),
    wrap(`<blockquote ${Q}><div>${S("Quoted")} name</div></blockquote>`),
  );
  assertEquals(
    textToHtml(">> **deep**"),
    wrap(`<blockquote ${Q}><blockquote ${Q}><div>${S("deep")}</div></blockquote></blockquote>`),
  );
});

Deno.test("bold: unmatched, empty and line-spanning markers stay literal", () => {
  assertEquals(textToHtml("a ** b"), wrap(`<div>a ** b</div>`));
  assertEquals(textToHtml("****"), wrap(`<div>****</div>`));
  assertEquals(textToHtml("a **b\nc** d"), wrap(`<div>a **b<br>c** d</div>`));
  assertEquals(textToHtml("**a**b**c"), wrap(`<div>${S("a")}b**c</div>`));
});

Deno.test("bold: no nesting and no other markup", () => {
  assertEquals(textToHtml("**a *b* c**"), wrap(`<div>${S("a *b* c")}</div>`));
  assertEquals(textToHtml("*i* _i_ [l](http://x)"), wrap(`<div>*i* _i_ [l](http://x)</div>`));
  assertEquals(textToHtml("**a **b** c**"), wrap(`<div>${S("a ")}b${S(" c")}</div>`));
});

Deno.test("bold: bold text cannot smuggle tags or attributes", () => {
  for (
    const t of [
      "**<b onclick=x>**",
      "**a**<script>alert(1)</script>",
      '**"><img src=x onerror=1>**',
      "**&lt;b&gt;**",
    ]
  ) {
    const html = textToHtml(t);
    const tags = (html.match(/<[^>]*>/g) ?? []).map((x) => x.replace(/ .*/, "").replace(/>$/, ""));
    for (const x of tags) {
      assert(
        [
          "<!DOCTYPE",
          "<html",
          "<head",
          "<meta",
          "</head",
          "<body",
          "</body",
          "</html",
          "<div",
          "</div",
          "<br",
          "<strong",
          "</strong",
        ]
          .includes(x),
        `unexpected tag ${x} for ${t}`,
      );
    }
    assert(!/<script|<img|<b /i.test(html), t);
  }
  assertEquals(textToHtml("**<b onclick=x>**"), wrap(`<div>${S("&lt;b onclick=x&gt;")}</div>`));
  assertEquals(textToHtml("**a**<script>"), wrap(`<div>${S("a")}&lt;script&gt;</div>`));
  assertEquals(textToHtml("**&lt;b&gt;**"), wrap(`<div>${S("&amp;lt;b&amp;gt;")}</div>`));
});

Deno.test("bold: stripBold removes markers exactly where the HTML makes bold", () => {
  assertEquals(stripBold("**Alan Tanaman**"), "Alan Tanaman");
  assertEquals(stripBold("a **b** c"), "a b c");
  assertEquals(stripBold("a ** d"), "a ** d");
  assertEquals(stripBold("****"), "****");
  assertEquals(stripBold("> **q**"), "> q");
});

Deno.test("bold: very long runs and many pairs stay linear", () => {
  const cases = [
    "**" + "a".repeat(500_000) + "**",
    "**a** ".repeat(10_000),
    "** ".repeat(50_000), // many unmatched-looking openers
    "**a".repeat(100_000), // never closed
    "*".repeat(200_000),
    "**a*".repeat(50_000),
  ];
  for (const c of cases) {
    const t0 = performance.now();
    textToHtml(c);
    stripBold(c);
    assert(performance.now() - t0 < 1000, `slow on input of length ${c.length}`);
  }
  assertEquals(textToHtml("**a** ".repeat(10_000)).match(/<strong>/g)!.length, 10_000);
});

Deno.test("html: a block that mixes quoted and unquoted lines is an escaped block", () => {
  assertEquals(textToHtml("On Monday, A wrote:\n> hi"), wrap(`<div>On Monday, A wrote:<br>&gt; hi</div>`));
});

Deno.test("html: & < > \" ' are all escaped", () => {
  assertEquals(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assertEquals(
    textToHtml(`a & b <c> "d" 'e'`),
    wrap(`<div>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;</div>`),
  );
});

Deno.test("html: hostile text is only ever emitted as escaped text", () => {
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "javascript:alert(1)",
    "[click](javascript:alert(1)) https://evil.example/x.png",
    "> <iframe src=//evil.example></iframe>",
    '"><svg/onload=alert(1)>',
    "Bcc: attacker@evil.example\r\nSubject: pwned",
  ].join("\n\n");
  const html = textToHtml(hostile);
  // The only tags present are the fixed ones the converter emits itself.
  const tags = html.match(/<[^>]*>/g)!.map((t) => t.replace(/ .*/, "").replace(/>$/, ""));
  const allowed = new Set([
    "<!DOCTYPE",
    "<html",
    "<head",
    "<meta",
    "</head",
    "<body",
    "</body",
    "</html",
    "<div",
    "</div",
    "<br",
    "<blockquote",
    "</blockquote",
  ]);
  for (const t of tags) assert(allowed.has(t), `unexpected tag ${t}`);
  assert(!/<script|<img|<iframe|<svg|<a /i.test(html));
  assert(html.includes("&lt;script&gt;"));
  assert(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert(html.includes("javascript:alert(1)")); // plain text, never inside an attribute
  assert(!/href=|src=|url\(|@import|<link|<style/i.test(html.replace(/&lt;[^]*?&gt;/g, "")));
});

// ---------------------------------------------------------------- message structure

Deno.test("draft: empty references array emits no References header; In-Reply-To stays independent", () => {
  const base = {
    from: "me@example.test",
    to: "you@example.test",
    subject: "Hi",
    body: "x",
    now: new Date("2026-01-02T03:04:05Z"),
    idDomain: "example.test",
  };
  const bare = new TextDecoder().decode(buildDraft({ ...base, references: [] }));
  assertEquals(/^References:/mi.test(bare), false);
  assertEquals(/^In-Reply-To:/mi.test(bare), false);
  const replyOnly = new TextDecoder().decode(
    buildDraft({ ...base, inReplyTo: "<a@example.test>", references: [] }),
  );
  assert(replyOnly.includes("In-Reply-To: <a@example.test>\r\n"));
  assertEquals(/^References:/mi.test(replyOnly), false);
});

function build(body: string, subject = "Re: x"): string {
  return new TextDecoder().decode(buildDraft({
    from: "me@example.test",
    to: "you@example.test",
    subject,
    inReplyTo: "<a@example.test>",
    references: ["<a@example.test>"],
    body,
    now: new Date("2026-01-02T03:04:05Z"),
    idDomain: "example.test",
  }));
}

Deno.test("draft: multipart/alternative with an unchanged text/plain part and a generated text/html part", () => {
  const body = "Héllo ☃\n\n> quoted\n\n  indented\n";
  const raw = build(body);
  const boundary = /boundary="slipmail-([0-9a-f-]{36})"/.exec(raw);
  assert(boundary, "boundary is a UUID");
  assert(raw.includes("MIME-Version: 1.0\r\nContent-Type: multipart/alternative;"));
  assert(raw.endsWith(`--slipmail-${boundary[1]}--\r\n`));
  const parts = draftParts(raw);
  assertEquals(Object.keys(parts), ["text/plain", "text/html"]); // plain first, richest last
  assertEquals(parts["text/plain"], body.replace(/\n/g, "\r\n"));
  assertEquals(parts["text/html"], textToHtml(body));
  assert(parts["text/html"].includes("☃"));
  assert([...raw].every((c) => c.charCodeAt(0) < 0x80), "everything on the wire is 7-bit");
});

Deno.test("draft: the plain part has the ** markers removed, the HTML part has <strong>", () => {
  const parts = draftParts(build("Thanks,\n\n**Alan Tanaman**\nExample Co\n\nkeep ** this\n> **q**"));
  assertEquals(parts["text/plain"], "Thanks,\r\n\r\nAlan Tanaman\r\nExample Co\r\n\r\nkeep ** this\r\n> q");
  assert(parts["text/html"].includes("<strong>Alan Tanaman</strong><br>Example Co"));
  assert(parts["text/html"].includes("keep ** this"));
  assert(parts["text/html"].includes("<strong>q</strong>"));
  assert(!parts["text/html"].includes("**Alan"));
});

Deno.test("draft: each build uses a fresh boundary", () => {
  const a = /boundary="([^"]+)"/.exec(build("x"))![1];
  const b = /boundary="([^"]+)"/.exec(build("x"))![1];
  assert(a !== b);
});

Deno.test("draft: header injection attempts in the body stay inside the encoded parts", () => {
  const raw = build(
    "hi\r\nBcc: attacker@evil.example\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<script>1</script>",
  );
  const headers = raw.slice(0, raw.indexOf("\r\n\r\n"));
  assert(!/bcc/i.test(headers) && !/bcc/i.test(raw), "no cleartext Bcc anywhere in the message");
  assert(!/<script/i.test(raw), "no cleartext markup in the message");
  const parts = draftParts(raw);
  assert(parts["text/html"].includes("Bcc: attacker@evil.example"));
  assert(!parts["text/html"].includes("<script"));
});

Deno.test("draft: header injection through the subject is still neutralised", () => {
  const raw = build("body", "Re: x\r\nBcc: attacker@evil.example");
  const headers = raw.slice(0, raw.indexOf("\r\n\r\n"));
  assert(!/^Bcc:/mi.test(headers));
});

// ---------------------------------------------------------------- end to end against the fake server

async function withSession(
  inbox: Array<{ uid: number; raw: string }>,
  fn: (env: { s: Session; h: Harness }) => Promise<void>,
) {
  const h = await startHarness(standardFolders(inbox));
  try {
    const ctx = await makeCtx(h);
    try {
      const s = await ctx.open();
      try {
        await fn({ s, h });
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

Deno.test("save-draft: stores a multipart/alternative draft, threaded, with the Draft flag", async () => {
  const inbox = [{
    uid: 1,
    raw: rfc822(
      { From: "Alice <alice@example.com>", Subject: "Hello", "Message-ID": "<a1@example.com>" },
      "Hi\n",
    ),
  }];
  await withSession(inbox, async ({ s, h }) => {
    await saveDraft(s, 1, "Thanks!\n\n> Hi\n<script>x</script>");
    const drafts = h.server.folder("Drafts").messages;
    assertEquals(drafts.length, 1);
    assertEquals(h.server.folder("INBOX").messages.length, 1);
    const raw = drafts[0].raw;
    assert(raw.includes("To: alice@example.com"));
    assert(raw.includes("In-Reply-To: <a1@example.com>"));
    assert(drafts[0].flags.includes("\\Draft"));
    const parts = draftParts(raw);
    assertEquals(parts["text/plain"], "Thanks!\r\n\r\n> Hi\r\n<script>x</script>");
    assert(parts["text/html"].includes("&lt;script&gt;x&lt;/script&gt;"));
    assert(!parts["text/html"].includes("<script"));
  });
});

Deno.test("save-draft: an empty body is still rejected", async () => {
  await withSession([], async ({ s }) => {
    const err = await assertRejects(() => saveDraft(s, 1, "  \n "), OpError);
    assertEquals(err.code, "usage");
  });
});
