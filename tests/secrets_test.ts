import { assertEquals, assertRejects } from "@std/assert";
import { KeychainStore, type Runner, type RunResult, SecretError } from "../src/secrets.ts";

interface Call {
  cmd: string;
  args: string[];
}

/** A fake Runner that records every invocation and answers with a fixed result or error. */
function fakeRunner(answer: RunResult | "throw"): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = (cmd, args) => {
    calls.push({ cmd, args });
    if (answer === "throw") throw new Error("spawn failed: /usr/bin/security missing");
    return Promise.resolve(answer);
  };
  return { run, calls };
}

const ACCOUNT = "me@example.test";

Deno.test("keychain: success returns the password with one trailing newline stripped", async () => {
  const { run } = fakeRunner({ code: 0, stdout: "s3cret-value\n" });
  const store = new KeychainStore("slipmail", "/usr/bin/security", run);
  assertEquals(await store.getPassword(ACCOUNT), "s3cret-value");
});

Deno.test("keychain: CRLF line ending is stripped, but a second newline is kept", async () => {
  const crlf = new KeychainStore(
    "slipmail",
    "/usr/bin/security",
    fakeRunner({ code: 0, stdout: "pw\r\n" }).run,
  );
  assertEquals(await crlf.getPassword(ACCOUNT), "pw");

  const double = new KeychainStore(
    "slipmail",
    "/usr/bin/security",
    fakeRunner({ code: 0, stdout: "pw\n\n" }).run,
  );
  assertEquals(await double.getPassword(ACCOUNT), "pw\n");
});

Deno.test("keychain: argv and binary path are exactly the find-generic-password invocation", async () => {
  const { run, calls } = fakeRunner({ code: 0, stdout: "pw\n" });
  const store = new KeychainStore("slipmail", "/usr/bin/security", run);
  await store.getPassword(ACCOUNT);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].cmd, "/usr/bin/security");
  assertEquals(calls[0].args, ["find-generic-password", "-s", "slipmail", "-a", ACCOUNT, "-w"]);
});

Deno.test("keychain: default binary path is /usr/bin/security and service is passed through", async () => {
  const { run, calls } = fakeRunner({ code: 0, stdout: "pw\n" });
  const store = new KeychainStore("other-service", undefined, run);
  await store.getPassword(ACCOUNT);
  assertEquals(calls[0].cmd, "/usr/bin/security");
  assertEquals(calls[0].args.slice(0, 3), ["find-generic-password", "-s", "other-service"]);
});

Deno.test("keychain: unsafe account values are refused without calling the runner", async () => {
  const bad = [
    "",
    "-x@example.test",
    "--help",
    "a\nb@example.test",
    "a\r@example.test",
    "a\u0000b@example.test",
  ];
  for (const account of bad) {
    const { run, calls } = fakeRunner({ code: 0, stdout: "pw\n" });
    const store = new KeychainStore("slipmail", "/usr/bin/security", run);
    await assertRejects(() => store.getPassword(account), SecretError);
    assertEquals(calls.length, 0, `runner was called for ${JSON.stringify(account)}`);
  }
});

Deno.test("keychain: non-zero exit is a SecretError that does not echo stdout", async () => {
  const leaked = "partial-secret-value-do-not-print";
  const { run } = fakeRunner({ code: 44, stdout: leaked + "\n" });
  const store = new KeychainStore("slipmail", "/usr/bin/security", run);
  const err = await assertRejects(() => store.getPassword(ACCOUNT), SecretError);
  assertEquals(err.message.includes(leaked), false, `stdout leaked into error: ${err.message}`);
  assertEquals(err.message.includes(ACCOUNT), true);
});

Deno.test("keychain: runner throwing is mapped to a SecretError", async () => {
  const { run } = fakeRunner("throw");
  const store = new KeychainStore("slipmail", "/usr/bin/security", run);
  const err = await assertRejects(() => store.getPassword(ACCOUNT), SecretError);
  assertEquals(err.message.includes("missing"), false, "runner error text must not be surfaced");
});

Deno.test("keychain: empty stdout is a SecretError", async () => {
  for (const stdout of ["", "\n", "\r\n"]) {
    const { run } = fakeRunner({ code: 0, stdout });
    const store = new KeychainStore("slipmail", "/usr/bin/security", run);
    await assertRejects(() => store.getPassword(ACCOUNT), SecretError);
  }
});

Deno.test("keychain: password with spaces and special characters is preserved verbatim", async () => {
  const pw = `p@ss w0rd! "quoted" 'single' $HOME \`tick\` \\back ünï 日本 ;|&`;
  const { run } = fakeRunner({ code: 0, stdout: pw + "\n" });
  const store = new KeychainStore("slipmail", "/usr/bin/security", run);
  assertEquals(await store.getPassword(ACCOUNT), pw);
});
