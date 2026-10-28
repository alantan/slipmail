import { assert, assertEquals, assertRejects } from "@std/assert";
import { readCapped, run } from "../src/cli.ts";
import { OpError } from "../src/session.ts";
import { FakeSecrets, makeCtx, type TestCtx } from "./support/ctx.ts";
import type { FakeServerOptions } from "./support/fake_imap.ts";
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
  /** Contents served by readFile, keyed by path. Strings are UTF-8 encoded; bytes are served as-is. */
  files?: Record<string, string | Uint8Array>;
  readStdin?: (maxBytes: number) => Promise<Uint8Array>;
  secrets?: { getPassword(account: string): Promise<string> };
}

/** Runs the CLI in-process, captures every write, and asserts the one-document contract. */
async function invoke(ctx: TestCtx, inv: Invoke): Promise<Outcome> {
  const writes: string[] = [];
  const code = await run(inv.argv, ctx.config, {
    secrets: inv.secrets ?? ctx.secrets,
    readStdin: inv.readStdin ?? (() => Promise.resolve(inv.stdin ?? new Uint8Array(0))),
    readFile: (path, maxBytes) => {
      const f = inv.files?.[path];
      if (f === undefined) return Promise.reject(new Deno.errors.NotFound());
      const bytes = typeof f === "string" ? enc.encode(f) : f;
      // Mirrors readCapped: an over-cap file is refused with too_large, never returned.
      if (bytes.length > maxBytes) {
        return Promise.reject(new OpError("too_large", `batch file exceeds ${maxBytes} bytes`));
      }
      return Promise.resolve(bytes);
    },
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
async function setup(
  inbox: Array<{ raw: string }> = [{ raw: MSG1 }, { raw: MSG2 }],
  extra: Partial<FakeServerOptions> = {},
) {
  const h: Harness = await startHarness(standardFolders(inbox), extra);
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

Deno.test("cli: save-draft refuses mixed forms and extra positionals", async () => {
  const s = await setup();
  try {
    const argvs: string[][] = [
      ["save-draft", "1", "--reply-to", "1"],
      ["save-draft", "--reply-to", "1", "--to", "someone@example.com"],
      ["save-draft", "--reply-to", "1", "--subject", "x"],
      ["save-draft", "--to", "someone@example.com"],
      ["save-draft", "--subject", "x"],
      ["save-draft", "--to", "someone@example.com", "--subject", "x", "--from-name-only"],
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

// ---- New-message drafts (--to/--subject and --batch) --------------------------------------------

Deno.test("cli: save-draft --to saves an unthreaded multipart draft and never sends", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, {
      argv: ["save-draft", "--to", "carol@example.com", "--subject", "Intro \u00e9"],
      stdin: enc.encode("Hello **Carol**\n\n> quoted"),
    });
    assertEquals(out.code, 0);
    assertEquals(out.doc, {
      ok: true,
      saved: true,
      folder: "drafts",
      to: "carol@example.com",
      subject: "Intro \u00e9",
    });
    const drafts = s.h.server.folder("Drafts").messages;
    assertEquals(drafts.length, 1);
    const raw = drafts[0].raw;
    assert(raw.includes("To: carol@example.com\r\n"));
    assertEquals(/^(In-Reply-To|References):/mi.test(raw), false);
    const parts = draftParts(raw);
    assertEquals(parts["text/plain"], "Hello Carol\r\n\r\n> quoted");
    assert(parts["text/html"].includes("<strong>Carol</strong>"));
    assertEquals(s.h.server.commandLog.some((c) => /SEND|SMTP|DATA|RCPT/i.test(c)), false);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft --to validates address, subject and body before connecting", async () => {
  const s = await setup();
  try {
    const bad: string[][] = [
      ["not-an-address", "Hi"],
      ["a@example.com, b@example.com", "Hi"],
      ["Carol <carol@example.com>", "Hi"],
      ["carol@example.com", ""],
      ["carol@example.com", "Hi\r\nBcc: x@example.com"],
      ["carol@example.com", "x".repeat(301)],
    ];
    for (const [to, subject] of bad) {
      assertUsageFailure(
        await invoke(s.ctx, {
          argv: ["save-draft", "--to", to, "--subject", subject],
          stdin: enc.encode("Body"),
        }),
      );
    }
    assertUsageFailure(
      await invoke(s.ctx, {
        argv: ["save-draft", "--to", "c@example.com", "--subject", "Hi"],
        stdin: enc.encode(" "),
      }),
    );
    assertEquals(s.h.server.commandLog, []);
  } finally {
    await s.done();
  }
});

function batchLines(n: number): string {
  return Array.from(
    { length: n },
    (_, i) =>
      JSON.stringify({ to: `p${i}@example.com`, subject: `Subject ${i}`, body: `Body ${i} **bold**` }),
  ).join("\n");
}

Deno.test("cli: save-draft --batch saves 40 drafts in one session and lists each", async () => {
  const s = await setup();
  try {
    const file = `${s.ctx.config.scratchDir}/drafts.jsonl`;
    const out = await invoke(s.ctx, {
      argv: ["save-draft", "--batch", file],
      files: { [file]: batchLines(40) + "\n" },
    });
    assertEquals(out.code, 0);
    assertEquals(out.doc.count, 40);
    const listed = out.doc.drafts as Array<{ to: string; subject: string }>;
    assertEquals(listed[39], { to: "p39@example.com", subject: "Subject 39" });
    assertEquals(s.h.server.folder("Drafts").messages.length, 40);
    assertEquals(s.h.server.commandLog.filter((c) => c === "LIST").length, 1);
    assertEquals(/^(In-Reply-To|References):/mi.test(s.h.server.folder("Drafts").messages[0].raw), false);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft --batch validates every line before saving any", async () => {
  const s = await setup();
  try {
    const file = `${s.ctx.config.scratchDir}/b.jsonl`;
    const cases: string[] = [
      batchLines(2) + "\nnot json",
      batchLines(2) + '\n{"to":"x@example.com","subject":"s"}',
      batchLines(2) + '\n{"to":"x@example.com","subject":"s","body":"b","cc":"y@example.com"}',
      batchLines(2) + '\n{"to":"bad","subject":"s","body":"b"}',
      "\n\n",
      batchLines(101),
    ];
    for (const content of cases) {
      assertUsageFailure(
        await invoke(s.ctx, { argv: ["save-draft", "--batch", file], files: { [file]: content } }),
      );
    }
    assertEquals(s.h.server.commandLog, []);
    assertEquals(s.h.server.folder("Drafts").messages.length, 0);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft --batch only accepts files inside the scratch directory", async () => {
  const s = await setup();
  try {
    const dir = s.ctx.config.scratchDir;
    for (
      const path of [
        "/etc/passwd",
        "relative.jsonl",
        `${dir}/../x.jsonl`,
        `${dir}/a/../b.jsonl`,
        dir,
        `${dir}-other/x`,
      ]
    ) {
      assertUsageFailure(
        await invoke(s.ctx, { argv: ["save-draft", "--batch", path], files: { [path]: batchLines(1) } }),
      );
    }
    assertUsageFailure(
      await invoke(s.ctx, { argv: ["save-draft", "--batch", `${dir}/b.jsonl`, "--to", "a@example.com"] }),
    );
    assertEquals(s.h.server.commandLog, []);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft --batch reports partial progress when an APPEND fails midway", async () => {
  const s = await setup(undefined, { failAppendAfter: 2 });
  try {
    const file = `${s.ctx.config.scratchDir}/partial.jsonl`;
    const out = await invoke(s.ctx, {
      argv: ["save-draft", "--batch", file],
      files: { [file]: batchLines(4) },
    });
    assertEquals(out.code, 1);
    assertEquals(out.doc.ok, false);
    assertEquals(out.doc.error, {
      code: "imap",
      message: "saved 2 of 4 drafts; stopped at draft 3: APPEND failed: [OVERQUOTA] append refused",
    });
    assertEquals(s.h.server.folder("Drafts").messages.length, 2);
  } finally {
    await s.done();
  }
});

Deno.test("readCapped: names the source in the too_large message", async () => {
  const err = await assertRejects(
    () => readCapped(streamOf([new Uint8Array([1, 2, 3])]), 2, "batch file"),
    OpError,
  );
  assertEquals(err.code, "too_large");
  assertEquals(err.message, "batch file exceeds 2 bytes");
  const stdinErr = await assertRejects(
    () => readCapped(streamOf([new Uint8Array([1, 2, 3])]), 2),
    OpError,
  );
  assertEquals(stdinErr.message, "stdin exceeds 2 bytes");
});

Deno.test("cli: save-draft --batch with a missing file is a usage error", async () => {
  const s = await setup();
  try {
    const out = await invoke(s.ctx, {
      argv: ["save-draft", "--batch", `${s.ctx.config.scratchDir}/missing.jsonl`],
    });
    assertUsageFailure(out);
    assertEquals((out.doc.error as { message: string }).message, "cannot read batch file");
    assertEquals(s.h.server.commandLog, []);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft --batch rejects a file that is not valid UTF-8", async () => {
  const s = await setup();
  try {
    const file = `${s.ctx.config.scratchDir}/latin1.jsonl`;
    const bytes = new Uint8Array([...enc.encode(batchLines(1)), 0xff, 0xfe, 0x0a]);
    const out = await invoke(s.ctx, { argv: ["save-draft", "--batch", file], files: { [file]: bytes } });
    assertUsageFailure(out);
    assertEquals((out.doc.error as { message: string }).message, "batch file must be valid UTF-8");
    assertEquals(s.h.server.commandLog, []);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft --batch caps each body at maxDraftBytes, counted in UTF-8 bytes", async () => {
  const s = await setup();
  try {
    const limit = s.ctx.config.limits.maxDraftBytes;
    const file = `${s.ctx.config.scratchDir}/big.jsonl`;
    const cases = [
      "x".repeat(limit + 1), // one byte per character, over by one
      "é".repeat(Math.floor(limit / 2) + 1), // two bytes per character: under in chars, over in bytes
    ];
    for (const body of cases) {
      const line = JSON.stringify({ to: "p@example.com", subject: "Big", body });
      const out = await invoke(s.ctx, { argv: ["save-draft", "--batch", file], files: { [file]: line } });
      assertUsageFailure(out);
      assertEquals(
        (out.doc.error as { message: string }).message,
        `batch line 1: body exceeds ${limit} bytes`,
      );
    }
    assertEquals(s.h.server.commandLog, []);
  } finally {
    await s.done();
  }
});

Deno.test("cli: save-draft --batch refuses a file over 4 MiB before reading or connecting", async () => {
  const s = await setup();
  try {
    const file = `${s.ctx.config.scratchDir}/huge.jsonl`;
    const out = await invoke(s.ctx, {
      argv: ["save-draft", "--batch", file],
      files: { [file]: new Uint8Array(4 * 1024 * 1024 + 1).fill(0x0a) },
    });
    assertEquals(out.code, 1);
    assertEquals(out.doc.error, { code: "too_large", message: "batch file exceeds 4194304 bytes" });
    assertEquals(s.h.server.commandLog, []);
  } finally {
    await s.done();
  }
});
