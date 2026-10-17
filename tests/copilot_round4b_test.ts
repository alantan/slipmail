import { assert, assertEquals, assertRejects } from "@std/assert";
import { ImapClient, ProtocolError } from "../src/imap/client.ts";
import { htmlToText } from "../src/ops/fetch.ts";
import { PASSWORD, rfc822, standardFolders, startHarness, USER } from "./support/harness.ts";

Deno.test("htmlToText: a '>' inside a double- or single-quoted attribute does not end the tag", () => {
  assertEquals(htmlToText('<div title="1 > 0">Visible</div>'), "Visible\n".trim());
  assertEquals(htmlToText("<div title='a > b'>Visible</div>").trim(), "Visible");
  assertEquals(htmlToText("<a href=\"x\" data-x='>' >Link</a>"), "Link");
  assertEquals(htmlToText('<img alt="a > b" src=y>after'), "after");
});

Deno.test("htmlToText: unquoted '=' values, apostrophes in text and unterminated quotes", () => {
  assertEquals(htmlToText("<p class=big>Hi</p>").trim(), "Hi");
  assertEquals(htmlToText("it's <b>fine</b>"), "it's fine");
  // An unterminated quoted value swallows the rest of the input, as in a browser.
  assertEquals(htmlToText('keep<div title="never closed > hidden'), "keep");
});

Deno.test("htmlToText: quote handling stays linear on adversarial input", () => {
  for (const c of ['<a b="'.repeat(300_000), "<a b='>".repeat(300_000), '<a b=""'.repeat(300_000)]) {
    const t0 = performance.now();
    htmlToText(c);
    const ms = performance.now() - t0;
    assert(ms < 2000, `${c.slice(0, 8)} took ${ms} ms`);
  }
});

Deno.test("uidFetch header cap never exceeds a tighter connection-wide maxLiteralBytes", async () => {
  const raw = rfc822(
    { From: "a@example.com", Subject: "x".repeat(300), "Message-ID": "<c@example.com>" },
    "b\n",
  );
  const h = await startHarness(standardFolders([{ uid: 1, raw }]));
  try {
    const c = await ImapClient.connect({
      host: "127.0.0.1",
      port: h.server.port,
      ca: h.ca,
      timeoutMs: 5000,
      maxLiteralBytes: 100,
    });
    await c.login(USER, PASSWORD);
    await c.examine("INBOX");
    await assertRejects(() => c.uidFetch("1", { headerFields: ["Subject"] }), ProtocolError, "exceeds cap");
    await c.logout();
  } finally {
    await h.close();
  }
});
