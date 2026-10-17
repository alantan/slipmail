import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ALLOWED_COMMANDS, ImapClient, ImapCommandError } from "../src/imap/client.ts";
import { ProtocolError, quoteString } from "../src/imap/protocol.ts";
import { PASSWORD, rfc822, standardFolders, startHarness, USER } from "./support/harness.ts";

const enc = new TextEncoder();

function msg(id: string, extra: Record<string, string> = {}, body = "Hi\n"): string {
  return rfc822({
    From: "Alice <alice@example.com>",
    To: "Bob <bob@example.test>",
    Subject: `Message ${id}`,
    "Message-ID": `<${id}@example.com>`,
    ...extra,
  }, body);
}

Deno.test("login: wrong password is rejected, right password succeeds", async () => {
  const h = await startHarness();
  try {
    const bad = await h.connect();
    try {
      await assertRejects(() => bad.login(USER, "wrong-password-not-real"), ImapCommandError);
    } finally {
      await bad.logout();
    }

    const good = await h.connect();
    try {
      await good.login(USER, PASSWORD);
    } finally {
      await good.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("examine(INBOX) reports UIDVALIDITY, EXISTS and UIDNEXT", async () => {
  const h = await startHarness(standardFolders([
    { uid: 2, raw: msg("a2") },
    { uid: 5, raw: msg("a5") },
    { uid: 7, raw: msg("a7") },
  ]));
  try {
    const c = await h.connect();
    try {
      await c.login(USER, PASSWORD);
      const info = await c.examine("INBOX");
      assertEquals(info.uidValidity, 1001);
      assertEquals(info.exists, h.server.folder("INBOX").messages.length);
      assertEquals(info.exists, 3);
      assertEquals(info.uidNext, 8);
    } finally {
      await c.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("full session only puts allow-listed verbs on the wire", async () => {
  const h = await startHarness(standardFolders([{ raw: msg("a1") }]));
  try {
    const c = await h.connect();
    try {
      await c.login(USER, PASSWORD);
      await c.list();
      await c.examine("INBOX");
      await c.uidFetch("1:*", { flags: true, size: true });
      await c.uidSearch({ kind: "all" });
      await c.appendDraft("Drafts", enc.encode(msg("d1")));
    } finally {
      await c.logout();
    }

    const expected = new Set([
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
    assert(h.server.commandLog.length > 0);
    for (const cmd of h.server.commandLog) {
      assert(expected.has(cmd), `unexpected command on the wire: ${cmd}`);
    }

    const forbidden = [
      "STORE",
      "UID STORE",
      "EXPUNGE",
      "COPY",
      "UID COPY",
      "MOVE",
      "UID MOVE",
      "DELETE",
      "CREATE",
      "RENAME",
      "SELECT",
      "SUBSCRIBE",
    ];
    for (const verb of forbidden) {
      assertEquals(ALLOWED_COMMANDS.has(verb), false, `${verb} must not be allow-listed`);
    }
  } finally {
    await h.close();
  }
});

Deno.test("uidFetch rejects malformed sets and header names without sending anything", async () => {
  const h = await startHarness(standardFolders([{ raw: msg("a1") }]));
  try {
    const c = await h.connect();
    try {
      await c.login(USER, PASSWORD);
      await c.examine("INBOX");
      const before = h.server.commandLog.length;
      await assertRejects(() => c.uidFetch("1;x", { flags: true }), ProtocolError);
      await assertRejects(
        () => c.uidFetch("1", { headerFields: ["From)\r\nX: y"] }),
        ProtocolError,
      );
      assertEquals(h.server.commandLog.length, before);
    } finally {
      await c.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("uidFetch source:true returns the original bytes and leaves flags unchanged", async () => {
  const raw = msg("a1", {}, "Body text, unread.\n");
  const h = await startHarness(standardFolders([{ raw, flags: ["\\Flagged"] }]));
  try {
    const c = await h.connect();
    try {
      await c.login(USER, PASSWORD);
      await c.examine("INBOX");
      const [r] = await c.uidFetch("1", { flags: true, source: true });
      assertEquals(r.source, enc.encode(raw));
      assertEquals(r.flags, ["\\Flagged"]);
      assertEquals(h.server.folder("INBOX").messages[0].flags, ["\\Flagged"]);
    } finally {
      await c.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("uidSearch: header and OR criteria match; hostile values are rejected", async () => {
  const h = await startHarness(standardFolders([
    { uid: 1, raw: msg("a1", { "In-Reply-To": "<a1@example.com>" }) },
    { uid: 2, raw: msg("b2", { "In-Reply-To": "<b2@example.com>" }) },
    { uid: 3, raw: msg("c3") },
  ]));
  try {
    const c = await h.connect();
    try {
      await c.login(USER, PASSWORD);
      await c.examine("INBOX");

      const one = await c.uidSearch({ kind: "header", name: "In-Reply-To", value: "<a1@example.com>" });
      assertEquals(one, [1]);

      const either = await c.uidSearch({
        kind: "or",
        a: { kind: "header", name: "In-Reply-To", value: "<a1@example.com>" },
        b: { kind: "header", name: "In-Reply-To", value: "<b2@example.com>" },
      });
      assertEquals(either, [1, 2]);

      for (const value of ['a"b', "a\r\nb", "café"]) {
        await assertRejects(
          () => c.uidSearch({ kind: "header", name: "In-Reply-To", value }),
          ProtocolError,
          "invalid search value",
        );
      }
    } finally {
      await c.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("appendDraft stores a \\Draft message; appending to a missing folder fails", async () => {
  const h = await startHarness();
  try {
    const c = await h.connect();
    try {
      await c.login(USER, PASSWORD);
      const raw = msg("d1", { Subject: "Draft reply" }, "Unsent body.\n");
      await c.appendDraft("Drafts", enc.encode(raw));

      const stored = h.server.folder("Drafts").messages;
      assertEquals(stored.length, 1);
      assertEquals(stored[0].flags, ["\\Draft"]);
      assertEquals(stored[0].raw, raw);

      await assertRejects(
        () => c.appendDraft("No Such Folder", enc.encode(raw)),
        ImapCommandError,
      );
    } finally {
      await c.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("server literal above maxLiteralBytes is rejected with ProtocolError", async () => {
  const raw = msg("big", {}, "x".repeat(300));
  assert(enc.encode(raw).length > 100);
  const h = await startHarness(standardFolders([{ raw }]));
  try {
    const c = await ImapClient.connect({
      host: "127.0.0.1",
      port: h.server.port,
      ca: h.ca,
      timeoutMs: 5000,
      maxLiteralBytes: 100,
    });
    try {
      await c.login(USER, PASSWORD);
      await c.examine("INBOX");
      await assertRejects(() => c.uidFetch("1", { source: true }), ProtocolError);
    } finally {
      await c.logout();
    }
  } finally {
    await h.close();
  }
});

Deno.test("quoteString escapes backslash and quote and rejects unsafe characters", () => {
  assertEquals(quoteString('a\\b"c'), '"a\\\\b\\"c"');
  for (const bad of ["a\rb", "a\nb", "a\u0000b", "café"]) {
    assertThrows(() => quoteString(bad), ProtocolError, undefined, `should reject ${JSON.stringify(bad)}`);
  }
});
