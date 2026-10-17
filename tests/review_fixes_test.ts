import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { resolveBuildConfig } from "../scripts/build.ts";
import { checkSources } from "../scripts/security_check.ts";
import { type BrokerConfig, DEFAULT_LIMITS } from "../src/config.ts";
import { run } from "../src/cli.ts";
import { fetchMessage } from "../src/ops/fetch.ts";
import { handledCheck } from "../src/ops/handled_check.ts";
import { listNew } from "../src/ops/list_new.ts";
import { OpError, type Session } from "../src/session.ts";
import { SecretError, type SecretStore } from "../src/secrets.ts";
import { type FakeFolder, makeFolder } from "./support/fake_imap.ts";
import { type Harness, PASSWORD, rfc822, standardFolders, startHarness, USER } from "./support/harness.ts";
import { FakeSecrets, makeCtx, type TestCtx } from "./support/ctx.ts";

const enc = new TextEncoder();

type Msg = { uid?: number; flags?: string[]; raw: string };
type Style = "untagged" | "tagged-only" | "no-uidnext";

function mail(extra: Record<string, string> = {}, body = "Hi\n"): string {
  return rfc822({
    From: "Alice <alice@example.com>",
    Subject: "Hello",
    "Message-ID": "<m@example.com>",
    ...extra,
  }, body);
}

function mailbox(
  opts: { inbox?: Msg[]; sent?: Msg[]; drafts?: Msg[]; archive?: Msg[] } = {},
): FakeFolder[] {
  return [
    makeFolder("INBOX", undefined, opts.inbox ?? []),
    makeFolder("Sent Items", "\\Sent", opts.sent ?? []),
    makeFolder("Drafts", "\\Drafts", opts.drafts ?? []),
    makeFolder("Archive", "\\Archive", opts.archive ?? []),
  ];
}

async function withSession(
  folders: FakeFolder[],
  fn: (env: { s: Session; h: Harness; ctx: TestCtx }) => Promise<void>,
  opts: { examineStyle?: Style; limits?: Partial<BrokerConfig["limits"]> } = {},
): Promise<void> {
  const h = await startHarness(folders, { examineStyle: opts.examineStyle });
  try {
    const ctx = await makeCtx(h, opts.limits ?? {});
    try {
      const s = await ctx.open();
      try {
        await fn({ s, h, ctx });
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

async function expectOpError(fn: () => Promise<unknown>, code: string): Promise<void> {
  const err = await assertRejects(fn, OpError);
  assertEquals(err.code, code);
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const MULTI_BOUNDARY = "slipmail-review-boundary";

function attachmentPart(filename: string, type: string, bytes: Uint8Array): string {
  return [
    `--${MULTI_BOUNDARY}`,
    `Content-Type: ${type}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(bytes).replace(/(.{76})/g, "$1\n"),
    "",
  ].join("\n");
}

function multipartMail(parts: string[], extra: Record<string, string> = {}): string {
  const text = [`--${MULTI_BOUNDARY}`, "Content-Type: text/plain; charset=utf-8", "", "See attached.", ""]
    .join("\n");
  return mail(
    { "Content-Type": `multipart/mixed; boundary="${MULTI_BOUNDARY}"`, ...extra },
    [text, ...parts, `--${MULTI_BOUNDARY}--`, ""].join("\n"),
  );
}

// ---------------------------------------------------------------- list-new

Deno.test("list-new: Inbox with UIDs starting at 50000 returns all of them, not truncated", async () => {
  const inbox = [50000, 50001, 50002].map((uid) => ({
    uid,
    raw: mail({ "Message-ID": `<big${uid}@example.com>`, Subject: `Msg ${uid}` }),
  }));
  await withSession(mailbox({ inbox }), async ({ s }) => {
    const r = await listNew(s, 0);
    assertEquals(r.messages.map((m) => m.uid), [50000, 50001, 50002]);
    assertEquals(r.truncated, false);
    assertEquals(r.uidNext, 50003);
  });
});

Deno.test("list-new: examineStyle no-uidnext still returns messages with uidNext null", async () => {
  const inbox = [1, 2].map((uid) => ({ uid, raw: mail({ "Message-ID": `<n${uid}@example.com>` }) }));
  await withSession(mailbox({ inbox }), async ({ s }) => {
    const r = await listNew(s, 0);
    assertEquals(r.messages.map((m) => m.uid), [1, 2]);
    assertEquals(r.uidNext, null);
    assertEquals(r.uidValidity, 1001);
  }, { examineStyle: "no-uidnext" });
});

// ---------------------------------------------------------------- examine

Deno.test("examine: tagged-only server reports UIDVALIDITY and UIDNEXT from the tagged OK", async () => {
  const inbox = [1, 2].map((uid) => ({ uid, raw: mail({ "Message-ID": `<t${uid}@example.com>` }) }));
  const h = await startHarness(standardFolders(inbox), { examineStyle: "tagged-only" });
  try {
    const client = await h.connect();
    try {
      await client.login(USER, PASSWORD);
      const info = await client.examine("INBOX");
      assertEquals(info.uidValidity, 1001);
      assertEquals(info.uidNext, 3);
      assertEquals(info.exists, 2);
    } finally {
      await client.logout();
    }
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- fetch

Deno.test("fetch: repeat fetch of the same attachment is idempotent; altered scratch file is scratch_conflict", async () => {
  const pdf = enc.encode("%PDF-1.4\n%%EOF\n");
  const inbox = [{
    uid: 1,
    raw: multipartMail([attachmentPart("doc.pdf", "application/pdf", pdf)], {
      "Message-ID": "<rep1@example.com>",
    }),
  }];
  await withSession(mailbox({ inbox }), async ({ s }) => {
    const first = (await fetchMessage(s, 1)).attachments[0];
    assertEquals(first.saved, true);
    assert(first.path !== undefined, "first fetch saved no path");

    const second = (await fetchMessage(s, 1)).attachments[0];
    assertEquals(second.saved, true);
    assertEquals(second.path, first.path);
    assertEquals(await Deno.readFile(first.path), pdf);

    // Same length, different bytes: the existing file must not be accepted as a match.
    const other = new Uint8Array(pdf.length).fill(0x41);
    await Deno.writeFile(first.path, other);
    await expectOpError(() => fetchMessage(s, 1), "scratch_conflict");
    assertEquals(await Deno.readFile(first.path), other);
  });
});

// ---------------------------------------------------------------- handled-check

Deno.test("handled-check: UID at or above Inbox UIDNEXT is not_found", async () => {
  const inbox = [1, 2].map((uid) => ({ uid, raw: mail({ "Message-ID": `<h${uid}@example.com>` }) }));
  await withSession(mailbox({ inbox }), async ({ s }) => {
    // UIDNEXT is 3, so UID 3 and anything beyond it have not been assigned yet.
    await expectOpError(() => handledCheck(s, 3), "not_found");
    await expectOpError(() => handledCheck(s, 10), "not_found");
  });
});

Deno.test("handled-check: UID below UIDNEXT that is absent reports movedOutOfInbox", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<k1@example.com>" }) }, {
    uid: 3,
    raw: mail({ "Message-ID": "<k3@example.com>" }),
  }];
  await withSession(mailbox({ inbox }), async ({ s }) => {
    const r = await handledCheck(s, 2);
    assertEquals(r.movedOutOfInbox, true);
    assertEquals(r.handled, true);
    assertEquals(r.messageId, null);
  });
});

Deno.test("handled-check: caller-supplied messageId finds a Sent reply when the Inbox copy has no Message-ID", async () => {
  const sent = [{
    raw: mail({
      Subject: "Re: Question",
      "Message-ID": "<reply1@example.test>",
      "In-Reply-To": "<nomid@example.com>",
    }),
  }];

  // Variant 1: the UID has left the Inbox, so the caller's Message-ID is the only handle.
  const movedInbox = [{ uid: 9, raw: mail({ "Message-ID": "<later@example.com>" }) }];
  await withSession(mailbox({ inbox: movedInbox, sent }), async ({ s }) => {
    const r = await handledCheck(s, 7, { messageId: "<nomid@example.com>" });
    assertEquals(r.movedOutOfInbox, true);
    assertEquals(r.messageId, "<nomid@example.com>");
    assertEquals(r.sentReply, true);
    assertEquals(r.handled, true);
  });

  // Variant 2: the UID is still in the Inbox but its copy has no Message-ID header.
  const noIdInbox = [{
    uid: 1,
    raw: rfc822({ From: "Alice <alice@example.com>", Subject: "No id" }, "Hi\n"),
  }];
  await withSession(mailbox({ inbox: noIdInbox, sent }), async ({ s }) => {
    const r = await handledCheck(s, 1, { messageId: "<nomid@example.com>" });
    assertEquals(r.movedOutOfInbox, false);
    assertEquals(r.messageId, "<nomid@example.com>");
    assertEquals(r.sentReply, true);
    assertEquals(r.handled, true);
  });
});

// ---------------------------------------------------------------- CLI error mapping

class ThrowingSecrets implements SecretStore {
  getPassword(): Promise<string> {
    return Promise.reject(new SecretError("keychain item not found or access denied"));
  }
}

interface CliResult {
  code: number;
  writes: string[];
  doc: { ok: boolean; error?: { code: string; message: string } };
}

async function runCli(config: BrokerConfig, argv: string[], secrets: SecretStore): Promise<CliResult> {
  const writes: string[] = [];
  const code = await run(argv, config, {
    secrets,
    readStdin: () => Promise.resolve(new Uint8Array(0)),
    write: (json) => writes.push(json),
  });
  assertEquals(writes.length, 1, `expected one JSON document, got ${writes.length}`);
  return { code, writes, doc: JSON.parse(writes[0]) };
}

Deno.test("cli: SecretError from the secret store maps to code credentials, exit 1", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<c1@example.com>" }) }];
  const h = await startHarness(standardFolders(inbox));
  try {
    const ctx = await makeCtx(h);
    try {
      const out = await runCli(ctx.config, ["list-new", "--after-uid", "0"], new ThrowingSecrets());
      assertEquals(out.code, 1);
      assertEquals(out.doc.ok, false);
      assertEquals(out.doc.error?.code, "credentials");
      assert(!out.writes[0].includes(PASSWORD));
    } finally {
      await ctx.cleanup();
    }
  } finally {
    await h.close();
  }
});

Deno.test("cli: folders without Drafts maps to code folders, exit 1, and no password echo", async () => {
  const inbox = [{ uid: 1, raw: mail({ "Message-ID": "<d1@example.com>" }) }];
  const folders = [makeFolder("INBOX", undefined, inbox), makeFolder("Sent Items", "\\Sent")];
  const h = await startHarness(folders);
  try {
    const ctx = await makeCtx(h);
    try {
      const out = await runCli(ctx.config, ["list-new", "--after-uid", "0"], new FakeSecrets());
      assertEquals(out.code, 1);
      assertEquals(out.doc.ok, false);
      assertEquals(out.doc.error?.code, "folders");
      assert(out.doc.error?.message.includes("Drafts"), `unexpected message: ${out.doc.error?.message}`);
      assert(!out.writes[0].includes(PASSWORD));
    } finally {
      await ctx.cleanup();
    }
  } finally {
    await h.close();
  }
});

async function baseConfig(port: number): Promise<{ config: BrokerConfig; cleanup: () => Promise<void> }> {
  const scratch = await Deno.makeTempDir({ prefix: "slipmail-scratch-" });
  return {
    config: {
      host: "127.0.0.1",
      port,
      mailbox: USER,
      scratchDir: scratch,
      limits: { ...DEFAULT_LIMITS },
    },
    cleanup: () => Deno.remove(scratch, { recursive: true }),
  };
}

Deno.test("cli: connection to a closed port exits 1 with a generic code and no password echo", async () => {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const { config, cleanup } = await baseConfig(port);
  try {
    const out = await runCli(config, ["list-new", "--after-uid", "0"], new FakeSecrets());
    assertEquals(out.code, 1);
    assertEquals(out.doc.ok, false);
    // Connection failures are not mapped to a known class, so cli.ts reports the error name.
    assertEquals(out.doc.error?.code, "internal");
    assert(!out.writes[0].includes(PASSWORD));
  } finally {
    await cleanup();
  }
});

Deno.test("cli: a server that closes without a TLS greeting exits 1 with no password echo", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const acceptor = (async () => {
    try {
      for await (const conn of listener) {
        try {
          await conn.write(enc.encode("garbage that is not TLS\r\n"));
        } finally {
          conn.close();
        }
      }
    } catch {
      // listener closed
    }
  })();
  const { config, cleanup } = await baseConfig(port);
  try {
    const out = await runCli(config, ["list-new", "--after-uid", "0"], new FakeSecrets());
    assertEquals(out.code, 1);
    assertEquals(out.doc.ok, false);
    assertEquals(out.doc.error?.code, "internal");
    assert(!out.writes[0].includes(PASSWORD));
  } finally {
    await cleanup();
    listener.close();
    await acceptor;
  }
});

// ---------------------------------------------------------------- security_check: checkSources

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = `${root}/${rel}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

Deno.test("checkSources: primitives are flagged only outside their allowed files", async () => {
  const root = await Deno.makeTempDir({ prefix: "slipmail-sec-" });
  try {
    await writeTree(root, {
      "src/a.ts": 'export const f = () => fetch("https://x");\n',
      "src/b.ts": "// talks to nodemailer\nexport const b = 1;\n",
      "src/imap/client.ts": "export const c = () => Deno.connectTls({ hostname: 'h', port: 993 });\n",
      "src/other.ts": "export const o = () => Deno.connectTls({ hostname: 'h', port: 993 });\n",
      "src/ok.ts": "export const ok = 1;\n",
      "dist/entry.ts": "export {};\n",
    });
    const errs = await checkSources(root);
    assert(errs.some((e) => e.startsWith("src/a.ts:")), `expected src/a.ts error in ${JSON.stringify(errs)}`);
    assert(errs.some((e) => e.startsWith("src/b.ts:")), `expected src/b.ts error in ${JSON.stringify(errs)}`);
    assert(
      errs.some((e) => e.startsWith("src/other.ts:")),
      `expected src/other.ts error in ${JSON.stringify(errs)}`,
    );
    assertEquals(errs.filter((e) => e.startsWith("src/imap/client.ts:")), []);
    assertEquals(errs.filter((e) => e.startsWith("src/ok.ts:")), []);
    assertEquals(errs.filter((e) => e.startsWith("dist/entry.ts:")), []);
    assertEquals(errs.length, 3, `unexpected errors: ${JSON.stringify(errs)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkSources: a clean tree produces no errors", async () => {
  const root = await Deno.makeTempDir({ prefix: "slipmail-sec-" });
  try {
    await writeTree(root, {
      "src/ok.ts": "export const ok = 1;\n",
      "dist/entry.ts": "export {};\n",
    });
    assertEquals(await checkSources(root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------- build: resolveBuildConfig

const BASE_ENV: Record<string, string> = {
  IMAP_HOST: "imap.example.test",
  MAILBOX_ADDRESS: "me@example.test",
  SCRATCH_DIR: "/var/tmp/slipmail",
};

function envWith(extra: Record<string, string>): (k: string) => string | undefined {
  const all = { ...BASE_ENV, ...extra };
  return (k) => all[k];
}

Deno.test("build: non-ASCII FOLDER_SENT is rejected", () => {
  assertThrows(
    () => resolveBuildConfig(envWith({ FOLDER_SENT: "Envoyés" })),
    Error,
    "must be ASCII",
  );
});

Deno.test("build: ASCII folder overrides are accepted into overrides", () => {
  const c = resolveBuildConfig(envWith({ FOLDER_SENT: "Sent Items", FOLDER_DRAFTS: "Drafts" }));
  assertEquals(c.overrides, { sent: "Sent Items", drafts: "Drafts" });
});

Deno.test("build: modified UTF-7 folder name (ASCII form) is accepted", () => {
  const c = resolveBuildConfig(envWith({ FOLDER_SENT: "Envoy&AOk-s" }));
  assertEquals(c.overrides, { sent: "Envoy&AOk-s" });
});
