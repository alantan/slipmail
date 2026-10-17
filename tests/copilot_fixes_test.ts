import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import PostalMime from "postal-mime";
import { resolveBuildConfig } from "../scripts/build.ts";
import { buildDraft } from "../src/mime_out.ts";
import { ImapClient, ImapCommandError } from "../src/imap/client.ts";
import { FakeImapServer, makeTestCerts } from "./support/fake_imap.ts";
import { standardFolders } from "./support/harness.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- build: SCRATCH_DIR normalisation

function scratchEnv(scratch: string): (k: string) => string | undefined {
  const all: Record<string, string> = {
    IMAP_HOST: "imap.example.test",
    MAILBOX_ADDRESS: "me@example.test",
    SCRATCH_DIR: scratch,
  };
  return (k) => all[k];
}

for (const bad of ["/.", "/./.", "/./", "//", "/a/./b", "/a//b"]) {
  Deno.test(`copilot build: SCRATCH_DIR ${JSON.stringify(bad)} is rejected`, () => {
    assertThrows(() => resolveBuildConfig(scratchEnv(bad)), Error, "SCRATCH_DIR");
  });
}

for (const good of ["/var/tmp/slipmail", "/var/tmp/my.dir", "/var/tmp/.cache-x"]) {
  Deno.test(`copilot build: SCRATCH_DIR ${JSON.stringify(good)} is accepted`, () => {
    const c = resolveBuildConfig(scratchEnv(good));
    assertEquals(c.scratchDir, good);
  });
}

// ---------------------------------------------------------------- mime_out: References folding

function tenLongIds(): string[] {
  return Array.from(
    { length: 10 },
    (_, i) => `<${String(i).padStart(2, "0")}.${"x".repeat(190)}@example.test>`,
  );
}

function draftWithReferences(ids: string[]): Uint8Array {
  return buildDraft({
    from: "me@example.test",
    to: "you@example.test",
    subject: "Re: thread",
    inReplyTo: ids[ids.length - 1],
    references: ids,
    body: "Hello\n",
    now: new Date("2026-01-02T03:04:05Z"),
    idDomain: "example.test",
  });
}

/** Raw header lines of the draft (everything before the blank line), as text. */
function headerLines(raw: Uint8Array): string[] {
  const text = dec.decode(raw);
  const end = text.indexOf("\r\n\r\n");
  return text.slice(0, end).split("\r\n");
}

/** The physical lines making up the References header, including its continuation lines. */
function referencesPhysicalLines(lines: string[]): string[] {
  const start = lines.findIndex((l) => l.startsWith("References:"));
  assert(start >= 0, "no References header");
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length && /^[ \t]/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

Deno.test("copilot mime: no physical header line exceeds 998 octets with 10 long References ids", () => {
  const raw = draftWithReferences(tenLongIds());
  for (const line of headerLines(raw)) {
    assert(enc.encode(line).length <= 998, `header line too long: ${enc.encode(line).length} octets`);
  }
});

Deno.test("copilot mime: References folds keep physical lines within 78 characters per id", () => {
  const ids = tenLongIds();
  const phys = referencesPhysicalLines(headerLines(draftWithReferences(ids)));
  // Each id is ~195 chars, so every id sits on its own physical line.
  assertEquals(phys.length, ids.length);
  assertEquals(phys[0].startsWith("References: "), true);
  for (const line of phys.slice(1)) assertEquals(line.startsWith(" "), true);
});

Deno.test("copilot mime: unfolding References yields the space-joined identifier list", () => {
  const ids = tenLongIds();
  const phys = referencesPhysicalLines(headerLines(draftWithReferences(ids)));
  const unfolded = phys.join("\r\n").replace(/\r\n[ \t]/g, " ");
  assertEquals(unfolded, `References: ${ids.join(" ")}`);
});

Deno.test("copilot mime: PostalMime parses the folded References back to the same ids", async () => {
  const ids = tenLongIds();
  const parsed = await PostalMime.parse(draftWithReferences(ids));
  const refs = parsed.references as unknown;
  const list = Array.isArray(refs) ? refs.map(String) : String(refs).trim().split(/\s+/);
  assertEquals(list, ids);
});

Deno.test("copilot mime: short References stay on one physical line", () => {
  const phys = referencesPhysicalLines(
    headerLines(draftWithReferences(["<a@example.test>", "<b@example.test>"])),
  );
  assertEquals(phys, ["References: <a@example.test> <b@example.test>"]);
});

// ---------------------------------------------------------------- fake IMAP: AUTH=PLAIN UTF-8

Deno.test("copilot fake_imap: AUTHENTICATE accepts non-ASCII credentials and still rejects a wrong password", async () => {
  const user = "me@example.test";
  const password = "päss-ünï";
  const dir = await Deno.makeTempDir({ prefix: "slipmail-test-" });
  try {
    const { cert, key, ca } = await makeTestCerts(dir);
    const server = new FakeImapServer({ user, password, cert, key, folders: standardFolders() });
    try {
      const client = await ImapClient.connect({ host: "127.0.0.1", port: server.port, ca, timeoutMs: 5000 });
      await client.login(user, password);
      await client.logout();

      const bad = await ImapClient.connect({ host: "127.0.0.1", port: server.port, ca, timeoutMs: 5000 });
      await assertRejects(() => bad.login(user, "wrong-päss"), ImapCommandError);
      await bad.logout().catch(() => {});
    } finally {
      await server.close().catch(() => {});
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("buildDraft: the message ends with CRLF", () => {
  const raw = dec.decode(draftWithReferences(["<a@example.test>"]));
  assertEquals(raw.endsWith("\r\n"), true);
  assertEquals(raw.endsWith("\r\n\r\n"), false);
});
