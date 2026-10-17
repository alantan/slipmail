import { assertEquals } from "@std/assert";
import { contentMatchesExtension } from "../src/filetype.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const MZ_EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);

Deno.test("pdf accepts header at offset 0", () => {
  assertEquals(contentMatchesExtension("pdf", enc("%PDF-1.7\n%...")), true);
});

Deno.test("pdf accepts 500 bytes of leading junk", () => {
  const junk = new Uint8Array(500).fill(0x41);
  assertEquals(contentMatchesExtension("pdf", new Uint8Array([...junk, ...enc("%PDF-1.4")])), true);
});

Deno.test("pdf rejects 2000 bytes of leading junk", () => {
  const junk = new Uint8Array(2000).fill(0x41);
  assertEquals(contentMatchesExtension("pdf", new Uint8Array([...junk, ...enc("%PDF-1.4")])), false);
});

Deno.test("pdf rejects PNG bytes", () => {
  assertEquals(contentMatchesExtension("pdf", PNG), false);
});

Deno.test("jpg accepts FF D8 FF header", () => {
  assertEquals(contentMatchesExtension("jpg", JPEG), true);
});

Deno.test("jpg rejects ZIP bytes", () => {
  assertEquals(contentMatchesExtension("jpg", ZIP), false);
});

Deno.test("jpeg accepts FF D8 FF header", () => {
  assertEquals(contentMatchesExtension("jpeg", JPEG), true);
});

Deno.test("jpeg rejects PNG bytes", () => {
  assertEquals(contentMatchesExtension("jpeg", PNG), false);
});

Deno.test("png accepts full 8-byte signature", () => {
  assertEquals(contentMatchesExtension("png", PNG), true);
});

Deno.test("png rejects truncated signature", () => {
  assertEquals(contentMatchesExtension("png", PNG.subarray(0, 7)), false);
});

Deno.test("png rejects JPEG bytes", () => {
  assertEquals(contentMatchesExtension("png", JPEG), false);
});

Deno.test("docx accepts ZIP local file header", () => {
  assertEquals(contentMatchesExtension("docx", ZIP), true);
});

Deno.test("docx rejects PDF header", () => {
  assertEquals(contentMatchesExtension("docx", enc("%PDF-1.4")), false);
});

Deno.test("xlsx accepts ZIP local file header", () => {
  assertEquals(contentMatchesExtension("xlsx", ZIP), true);
});

Deno.test("xlsx rejects JPEG bytes", () => {
  assertEquals(contentMatchesExtension("xlsx", JPEG), false);
});

Deno.test("txt accepts plain text with common whitespace", () => {
  assertEquals(contentMatchesExtension("txt", enc("hello world\r\n\tline two\n\fpage\n")), true);
});

Deno.test("txt accepts UTF-8 text", () => {
  assertEquals(contentMatchesExtension("txt", enc("héllo wörld 你好")), true);
});

Deno.test("txt rejects MZ executable with NUL bytes", () => {
  assertEquals(contentMatchesExtension("txt", MZ_EXE), false);
});

Deno.test("txt rejects mostly-binary content without NULs", () => {
  const bytes = new Uint8Array(40).fill(0x01);
  bytes.set(enc("abcdefghij"), 0);
  assertEquals(contentMatchesExtension("txt", bytes), false);
});

Deno.test("txt tolerates control characters under 10 percent", () => {
  const bytes = new Uint8Array(100).fill(0x61);
  bytes.set([0x01, 0x02, 0x03, 0x04, 0x05], 0);
  assertEquals(contentMatchesExtension("txt", bytes), true);
});

Deno.test("csv accepts comma-separated text", () => {
  assertEquals(contentMatchesExtension("csv", enc("name,amount\nalice,10\nbob,20\n")), true);
});

Deno.test("csv rejects content containing NUL bytes", () => {
  assertEquals(contentMatchesExtension("csv", enc("a,b\n\u0000,2\n")), false);
});

Deno.test("csv rejects ZIP bytes", () => {
  assertEquals(contentMatchesExtension("csv", ZIP), false);
});

Deno.test("unknown extension exe returns false even for MZ header", () => {
  assertEquals(contentMatchesExtension("exe", MZ_EXE), false);
});

Deno.test("empty extension returns false", () => {
  assertEquals(contentMatchesExtension("", enc("plain text")), false);
});

Deno.test("empty input returns false for every extension", () => {
  const empty = new Uint8Array(0);
  for (const ext of ["pdf", "jpg", "jpeg", "png", "docx", "xlsx", "txt", "csv", "exe", ""]) {
    assertEquals(contentMatchesExtension(ext, empty), false, `ext=${ext}`);
  }
});

Deno.test("PNG bytes with ext pdf return false", () => {
  assertEquals(contentMatchesExtension("pdf", PNG), false);
});
