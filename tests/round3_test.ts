import { assertEquals, assertRejects } from "@std/assert";
import { run } from "../src/cli.ts";
import { OpError } from "../src/session.ts";
import { fetchMessage } from "../src/ops/fetch.ts";
import { PASSWORD, rfc822, standardFolders, startHarness } from "./support/harness.ts";
import { FakeSecrets, makeCtx } from "./support/ctx.ts";

const pdfMail = (extra: Record<string, string> = {}) =>
  rfc822(
    {
      From: "Alice <alice@example.com>",
      Subject: "Doc",
      "Message-ID": "<d1@example.com>",
      "MIME-Version": "1.0",
      "Content-Type": 'multipart/mixed; boundary="zz"',
      ...extra,
    },
    '--zz\nContent-Type: text/plain\n\nbody\n--zz\nContent-Type: application/pdf; name="a.pdf"\n' +
      'Content-Disposition: attachment; filename="a.pdf"\nContent-Transfer-Encoding: base64\n\n' +
      `${btoa("%PDF-1.4 test")}\n--zz--\n`,
  );

Deno.test("round3 fetch: a symlink planted at the message scratch dir is refused", async () => {
  const h = await startHarness(standardFolders([{ uid: 1, raw: pdfMail() }]));
  const ctx = await makeCtx(h);
  const outside = await Deno.makeTempDir({ prefix: "slipmail-outside-" });
  try {
    await Deno.symlink(outside, `${ctx.scratch}/1001-1`);
    const s = await ctx.open();
    try {
      const err = await assertRejects(() => fetchMessage(s, 1), OpError);
      assertEquals(err.code, "scratch_conflict");
      assertEquals([...Deno.readDirSync(outside)].length, 0);
    } finally {
      await s.client.logout();
    }
  } finally {
    await ctx.cleanup();
    await Deno.remove(outside, { recursive: true });
    await h.close();
  }
});

Deno.test("round3 fetch: a symlink planted at the attachment path is not followed", async () => {
  const h = await startHarness(standardFolders([{ uid: 1, raw: pdfMail() }]));
  const ctx = await makeCtx(h);
  const outside = await Deno.makeTempDir({ prefix: "slipmail-outside-" });
  try {
    await Deno.mkdir(`${ctx.scratch}/1001-1`);
    await Deno.symlink(`${outside}/target.pdf`, `${ctx.scratch}/1001-1/1-a.pdf`);
    const s = await ctx.open();
    try {
      await assertRejects(() => fetchMessage(s, 1), Error);
      assertEquals([...Deno.readDirSync(outside)].length, 0);
    } finally {
      await s.client.logout();
    }
  } finally {
    await ctx.cleanup();
    await Deno.remove(outside, { recursive: true });
    await h.close();
  }
});

Deno.test("round3 fetch: a hostile Date header is cleaned and capped", async () => {
  const raw = pdfMail({ Date: "not a date \u202e" + "x".repeat(500) });
  const h = await startHarness(standardFolders([{ uid: 1, raw }]));
  const ctx = await makeCtx(h);
  try {
    const s = await ctx.open();
    try {
      const r = await fetchMessage(s, 1);
      const d = r.date ?? "";
      assertEquals(d.length <= 60, true);
      assertEquals([...d].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 0x202e), false);
    } finally {
      await s.client.logout();
    }
  } finally {
    await ctx.cleanup();
    await h.close();
  }
});

Deno.test("round3 cli: out-of-range or zero --uidvalidity is a usage error without connecting", async () => {
  const h = await startHarness();
  const ctx = await makeCtx(h);
  try {
    for (const uv of ["4294967296", "0", "x"]) {
      const out: string[] = [];
      const code = await run(["handled-check", "1", "--uidvalidity", uv], ctx.config, {
        secrets: new FakeSecrets(PASSWORD),
        readStdin: () => Promise.resolve(new Uint8Array()),
        write: (j) => out.push(j),
      });
      assertEquals(code, 2, uv);
      assertEquals(JSON.parse(out[0]).error.code, "usage");
    }
    assertEquals(h.server.commandLog.length, 0);
  } finally {
    await ctx.cleanup();
    await h.close();
  }
});

Deno.test("round3 cli: invalid draft bodies are rejected before connecting", async () => {
  const h = await startHarness();
  const ctx = await makeCtx(h);
  try {
    for (const body of ["   \n", "a\u0000b"]) {
      const out: string[] = [];
      const code = await run(["save-draft", "--reply-to", "1"], ctx.config, {
        secrets: new FakeSecrets(PASSWORD),
        readStdin: () => Promise.resolve(new TextEncoder().encode(body)),
        write: (j) => out.push(j),
      });
      assertEquals(code, 2);
    }
    assertEquals(h.server.commandLog.length, 0);
  } finally {
    await ctx.cleanup();
    await h.close();
  }
});
