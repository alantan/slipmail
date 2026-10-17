import { assert, assertEquals, assertRejects } from "@std/assert";
import { readCapped, run } from "../src/cli.ts";
import { OpError } from "../src/session.ts";
import { FakeSecrets, makeCtx, type TestCtx } from "./support/ctx.ts";
import {
  draftParts,
  type Harness,
  PASSWORD,
  rfc822,
  standardFolders,
  startHarness,
} from "./support/harness.ts";

const enc = new TextEncoder();

const MSG1 = rfc822({
  From: "Alice <alice@example.com>",
  Subject: "Hello",
  "Message-ID": "<a1@example.com>",
}, "Hi Alice\n");

const MSG2 = rfc822({
  From: "Bob <bob@example.com>",
  Subject: "Second",
  "Message-ID": "<a2@example.com>",
}, "Second body\n");

interface Outcome {
  code: number;
  writes: string[];
  doc: Record<string, unknown>;
}

interface Invoke {
  argv: string[];
  stdin?: Uint8Array;
  readStdin?: (maxBytes: number) => Promise<Uint8Array>;
  secrets?: { getPassword(account: string): Promise<string> };
}

/** Runs the CLI in-process, captures every write, and asserts the one-document contract. */
async function invoke(ctx: TestCtx, inv: Invoke): Promise<Outcome> {
  const writes: string[] = [];
  const code = await run(inv.argv, ctx.config, {
    secrets: inv.secrets ?? ctx.secrets,
    readStdin: inv.readStdin ?? (() => Promise.resolve(inv.stdin ?? new Uint8Array(0))),
    write: (json) => writes.push(json),
  });
  assertEquals(writes.length, 1, `expected exactly one JSON document, got ${writes.length}`);
  const doc = JSON.parse(writes[0]) as Record<string, unknown>;
  assertEquals(JSON.stringify(writes).includes(PASSWORD), false, "password leaked into CLI output");
  return { code, writes, doc };
}

function assertUsageFailure(out: Outcome) {
  assertEquals(out.code, 2);
  assertEquals(out.doc.ok, false);
  assertEquals((out.doc.error as { code: string }).code, "usage");
}

/** Starts the fake server with the standard folders and a fresh ctx; `inbox` seeds INBOX. */
async function setup(inbox: Array<{ raw: string }> = [{ raw: MSG1 }, { raw: MSG2 }]) {
  const h: Harness = await startHarness(standardFolders(inbox));
  const ctx = await makeCtx(h);
  return {
    h,
    ctx,
    async done() {
      await ctx.cleanup();
      await h.close();
    },
  };
}

// ---- Success paths -------------------------------------------------------------------------

Deno.test("cli: list-new --after-uid 0 returns both messages in one document", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, { argv: ["list-new", "--after-uid", "0"] });
    assertEquals(out.code, 0);
    assertEquals(out.doc.ok, true);
    const messages = out.doc.messages as Array<{ uid: number; messageId: string }>;
    assertEquals(messages.length, 2);
    assertEquals(messages.map((m) => m.uid), [1, 2]);
    assertEquals(out.doc.uidValidity, 1001);
  } finally {
    await s.done();
  }
});

Deno.test("cli: fetch 1 returns the message marked untrusted", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, { argv: ["fetch", "1"] });
    assertEquals(out.code, 0);
    assertEquals(out.doc.ok, true);
    assertEquals(out.doc.untrusted, true);
    assertEquals(out.doc.uid, 1);
    assert(String(out.doc.body).includes("Hi Alice"));
  } finally {
    await s.done();
  }
});

Deno.test("cli: handled-check returns the expected fields", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, {
      argv: ["handled-check", "1", "--message-id", "<a1@example.com>", "--uidvalidity", "1001"],
    });
    assertEquals(out.code, 0);
    assertEquals(out.doc.ok, true);
    assertEquals(out.doc.uid, 1);
    assertEquals(out.doc.uidValidity, 1001);
    assertEquals(out.doc.movedOutOfInbox, false);
    assertEquals(typeof out.doc.answered, "boolean");
    assertEquals(typeof out.doc.sentReply, "boolean");
    assertEquals(typeof out.doc.handled, "boolean");
  } finally {
    await s.done();
  }
});

Deno.test("cli: handled-check with a bad --uidvalidity is a usage error", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, { argv: ["handled-check", "1", "--uidvalidity", "x"] });
    assertUsageFailure(out);
    assertEquals(s.h.server.commandLog.length, 0);
  } finally {
    await s.done();
  }
});

Deno.test("cli: handled-check with a malformed --message-id is a usage error without connecting", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, { argv: ["handled-check", "1", "--message-id", "no-brackets"] });
    assertUsageFailure(out);
    assertEquals(s.h.server.commandLog.length, 0);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft appends a threaded reply to Drafts", async () => {
  const s = await setup();
  try {
    const stdin = enc.encode("Thanks!");
    let seenMax = -1;
    const out = await invoke(s.ctx, {
      argv: ["save-draft", "--reply-to", "1"],
      readStdin: (max) => {
        seenMax = max;
        return Promise.resolve(stdin);
      },
    });
    assertEquals(out.code, 0);
    assertEquals(out.doc.ok, true);
    assertEquals(out.doc.saved, true);
    assertEquals(out.doc.to, "alice@example.com");
    assertEquals(seenMax, s.ctx.config.limits.maxDraftBytes);
    const drafts = s.h.server.folder("Drafts").messages;
    assertEquals(drafts.length, 1);
    // Drafts are multipart/alternative with base64 parts (src/mime_out.ts).
    const raw = drafts[0].raw;
    const parts = draftParts(raw);
    assertEquals(parts["text/plain"], "Thanks!");
    assertEquals(parts["text/html"].includes("<p "), true);
    assert(raw.includes("In-Reply-To: <a1@example.com>"));
  } finally {
    await s.done();
  }
});

// ---- Usage errors: exit 2, no connection ---------------------------------------------------

Deno.test("cli: malformed fetch UIDs are usage errors without connecting", async () => {
  const s = await setup();
  try {
    for (const bad of [["abc"], ["0"], ["-1"], ["1", "2"], ["99999999999"]]) {
      const out = await invoke(s.ctx, { argv: ["fetch", ...bad] });
      assertUsageFailure(out);
    }
    assertEquals(s.h.server.commandLog, []);
  } finally {
    await s.done();
  }
});

Deno.test("cli: unknown, missing and malformed invocations are usage errors without connecting", async () => {
  const s = await setup();
  try {
    const cases: string[][] = [
      ["no-such-command"],
      [],
      ["list-new", "--after-uid", "1", "--host", "evil.example.com"],
      ["list-new", "--after-uid", "1", "--after-uid", "2"],
      ["list-new", "--after-uid"],
      ["list-new"],
      ["save-draft"],
      ["list-new", "--after-uid", "-5"],
    ];
    for (const argv of cases) {
      const out = await invoke(s.ctx, { argv });
      assertUsageFailure(out);
    }
    assertEquals(s.h.server.commandLog, []);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft refuses caller-supplied recipients and extra positionals", async () => {
  const s = await setup();
  try {
    const argvs: string[][] = [
      ["save-draft", "1", "--reply-to", "1"],
      ["save-draft", "--reply-to", "1", "--to", "someone@example.com"],
    ];
    for (const argv of argvs) {
      const out = await invoke(s.ctx, { argv, stdin: enc.encode("Thanks!") });
      assertUsageFailure(out);
    }
    assertEquals(s.h.server.commandLog, []);
    assertEquals(s.h.server.folder("Drafts").messages.length, 0);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft rejects invalid UTF-8 stdin with a usage error", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, {
      argv: ["save-draft", "--reply-to", "1"],
      stdin: new Uint8Array([0xff, 0xfe]),
    });
    assertUsageFailure(out);
    assertEquals(s.h.server.commandLog, []);
    assertEquals(s.h.server.folder("Drafts").messages.length, 0);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft oversize stdin surfaces too_large with exit 1", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, {
      argv: ["save-draft", "--reply-to", "1"],
      readStdin: () => Promise.reject(new OpError("too_large", "stdin exceeds limit")),
    });
    assertEquals(out.code, 1);
    assertEquals(out.doc.ok, false);
    assertEquals((out.doc.error as { code: string }).code, "too_large");
    assertEquals(s.h.server.folder("Drafts").messages.length, 0);
  } finally {
    await s.done();
  }
});

// ---- Credential and server failures: exit 1 ------------------------------------------------

Deno.test("cli: missing secret yields exit 1 with a generic internal error", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, {
      argv: ["list-new", "--after-uid", "0"],
      secrets: new FakeSecrets(null),
    });
    assertEquals(out.code, 1);
    assertEquals(out.doc.ok, false);
    const err = out.doc.error as { code: string; message: string };
    // A plain Error from the secret store is not mapped to a known class: cli.ts reports e.name.
    assertEquals(err.code, "internal");
    assertEquals(err.message, "Error");
  } finally {
    await s.done();
  }
});

Deno.test("cli: wrong password yields exit 1 with imap code and no password echo", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, {
      argv: ["list-new", "--after-uid", "0"],
      secrets: new FakeSecrets("wrong-password"),
    });
    assertEquals(out.code, 1);
    assertEquals(out.doc.ok, false);
    assertEquals((out.doc.error as { code: string }).code, "imap");
    assertEquals(out.writes.join("").includes("wrong-password"), false);
  } finally {
    await s.done();
  }
});

// ---- readCapped ----------------------------------------------------------------------------

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

Deno.test("readCapped: concatenates chunks under the cap", async () => {
  const out = await readCapped(
    streamOf([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]),
    10,
  );
  assertEquals(Array.from(out), [1, 2, 3, 4, 5]);
});

Deno.test("readCapped: rejects with too_large when the cap is exceeded", async () => {
  const err = await assertRejects(
    () => readCapped(streamOf([new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])]), 4),
    OpError,
  );
  assertEquals(err.code, "too_large");
});
