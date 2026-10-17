import { assertEquals, assertThrows } from "@std/assert";
import { resolveBuildConfig } from "../scripts/build.ts";
import {
  checkBinaryStrings,
  checkGraph,
  checkPermissions,
  extractMetadata,
} from "../scripts/security_check.ts";

const manifest = {
  out: "dist/slipmail",
  host: "imap.example.test",
  port: 993,
  scratchDir: "/var/tmp/slipmail",
};
const goodPerms = {
  allow_env: null,
  allow_net: ["imap.example.test:993"],
  allow_ffi: null,
  allow_read: ["/var/tmp/slipmail"],
  allow_run: ["/usr/bin/security"],
  allow_sys: null,
  allow_write: ["/var/tmp/slipmail"],
  allow_import: ["imap.example.test:993"],
  prompt: false,
};
const meta = (over: Record<string, unknown> = {}) => ({ permissions: { ...goodPerms, ...over } });

Deno.test("permissions: exact intended set passes", () => {
  assertEquals(checkPermissions(meta(), manifest), []);
});

Deno.test("permissions: any widening is reported", () => {
  for (
    const over of [
      { allow_env: [] },
      { allow_sys: ["hostname"] },
      { allow_ffi: [] },
      { allow_net: ["imap.example.test:993", "other.example.test:25"] },
      { allow_net: null },
      { allow_run: ["security"] },
      { allow_read: null },
      { allow_write: ["/"] },
      { allow_import: ["jsr.io:443"] },
      { prompt: true },
    ]
  ) {
    assertEquals(checkPermissions(meta(over), manifest).length > 0, true, JSON.stringify(over));
  }
});

Deno.test("metadata is extracted from surrounding binary noise", () => {
  const json = JSON.stringify({ argv: [], note: 'has "quotes" and } braces', ...meta() });
  const bytes = new TextEncoder().encode(`\u0000\u0001garbage${json}trailing}}}`);
  assertEquals(extractMetadata(bytes).permissions, goodPerms);
  assertThrows(() => extractMetadata(new TextEncoder().encode("nothing here")));
});

Deno.test("graph: smtp-capable and unlisted packages are rejected", () => {
  assertEquals(
    checkGraph({
      modules: [{ specifier: "file:///x/src/cli.ts" }],
      npmPackages: { "postal-mime@2.4.3": {} },
    }),
    [],
  );
  assertEquals(checkGraph({ npmPackages: { "nodemailer@7.0.6": {} } }).length, 2);
  assertEquals(checkGraph({ npmPackages: { "left-pad@1.0.0": {} } }).length, 1);
  assertEquals(checkGraph({ modules: [{ specifier: "https://evil.example.com/x.ts" }] }).length, 1);
  assertEquals(checkGraph({ modules: [{ specifier: "npm:/smtp-connection@1.0.0" }] }).length, 1);
});

Deno.test("binary scan flags SMTP client markers only", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assertEquals(checkBinaryStrings(enc("a gateway for IMAP and SMTP servers")), []);
  assertEquals(checkBinaryStrings(enc("RCPT TO:<x>")).length, 1);
  assertEquals(checkBinaryStrings(enc("/usr/sbin/sendmail -t")).length, 1);
});

Deno.test("build config: valid values and rejections", () => {
  const env = (o: Record<string, string | undefined>) => (k: string) => o[k];
  const ok = {
    IMAP_HOST: "imap.example.test",
    MAILBOX_ADDRESS: "me@example.test",
    SCRATCH_DIR: "/var/tmp/slipmail/",
  };
  const c = resolveBuildConfig(env(ok));
  assertEquals([c.host, c.port, c.scratchDir], ["imap.example.test", 993, "/var/tmp/slipmail"]);
  for (
    const bad of [
      { IMAP_HOST: "a b" },
      { IMAP_HOST: "evil.example.com,other.example.com" },
      { IMAP_PORT: "0" },
      { IMAP_PORT: "99999" },
      { IMAP_PORT: "993;x" },
      { MAILBOX_ADDRESS: "not-an-address" },
      { MAILBOX_ADDRESS: "-x@example.test" },
      { SCRATCH_DIR: "relative/path" },
      { SCRATCH_DIR: "/tmp/a,/etc" },
      { SCRATCH_DIR: "/tmp/../etc" },
      { SCRATCH_DIR: "/" },
      { FOLDER_SENT: 'a"b' },
    ]
  ) {
    assertThrows(() => resolveBuildConfig(env({ ...ok, ...bad })), Error);
  }
});
