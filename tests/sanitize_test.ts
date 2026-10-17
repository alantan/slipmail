import { assertEquals } from "@std/assert";
import { sanitizeFilename } from "../src/sanitize.ts";

const FB = "attachment";

function assertSafe(name: string): void {
  assertEquals(name.includes("/"), false, `slash in ${JSON.stringify(name)}`);
  assertEquals(name.includes("\\"), false, `backslash in ${JSON.stringify(name)}`);
  assertEquals(name.includes("\u0000"), false, `NUL in ${JSON.stringify(name)}`);
  assertEquals(name.startsWith("."), false, `leading dot in ${JSON.stringify(name)}`);
}

Deno.test("path traversal keeps only the last component", () => {
  assertEquals(sanitizeFilename("../../etc/passwd", FB), { name: "passwd", ext: null, allowed: false });
  assertEquals(sanitizeFilename("a/../b.txt", FB), { name: "b.txt", ext: "txt", allowed: true });
});

Deno.test("absolute and Windows paths keep only the file name", () => {
  assertEquals(sanitizeFilename("/abs/path/file.pdf", FB), { name: "file.pdf", ext: "pdf", allowed: true });
  assertEquals(sanitizeFilename("C:\\Users\\x\\a.docx", FB), { name: "a.docx", ext: "docx", allowed: true });
});

Deno.test("dot-only and empty names fall back", () => {
  assertEquals(sanitizeFilename("..", FB), { name: FB, ext: null, allowed: false });
  assertEquals(sanitizeFilename(".", FB), { name: FB, ext: null, allowed: false });
  assertEquals(sanitizeFilename("....", FB), { name: FB, ext: null, allowed: false });
  assertEquals(sanitizeFilename("", FB), { name: FB, ext: null, allowed: false });
  assertEquals(sanitizeFilename(null, FB), { name: FB, ext: null, allowed: false });
  assertEquals(sanitizeFilename(undefined, FB), { name: FB, ext: null, allowed: false });
});

Deno.test("NUL and control characters are removed", () => {
  assertEquals(sanitizeFilename("a\u0000b.pdf", FB), { name: "ab.pdf", ext: "pdf", allowed: true });
});

Deno.test("RTL override is removed so the real extension is exposed", () => {
  assertEquals(sanitizeFilename("report\u202Efdp.exe", FB), {
    name: "reportfdp.exe",
    ext: "exe",
    allowed: false,
  });
});

Deno.test("Windows reserved device names are prefixed", () => {
  assertEquals(sanitizeFilename("CON.txt", FB), { name: "_CON.txt", ext: "txt", allowed: true });
  assertEquals(sanitizeFilename("nul", FB), { name: "_nul", ext: null, allowed: false });
  assertEquals(sanitizeFilename("com1.tar.gz", FB), { name: "_com1.tar.gz", ext: "gz", allowed: false });
});

Deno.test("double extension yields the last extension, not allowed", () => {
  assertEquals(sanitizeFilename("invoice.pdf.exe", FB), {
    name: "invoice.pdf.exe",
    ext: "exe",
    allowed: false,
  });
});

Deno.test("extension is lowercased and matched case-insensitively", () => {
  assertEquals(sanitizeFilename("photo.JPG", FB), { name: "photo.jpg", ext: "jpg", allowed: true });
});

Deno.test("non-ASCII characters become underscores", () => {
  assertEquals(sanitizeFilename("résumé.pdf", FB), { name: "r_sum_.pdf", ext: "pdf", allowed: true });
});

Deno.test("long base is truncated to 80 characters", () => {
  const out = sanitizeFilename("a".repeat(500) + ".pdf", FB);
  assertEquals(out, { name: "a".repeat(80) + ".pdf", ext: "pdf", allowed: true });
});

Deno.test("dotfiles lose their leading dot", () => {
  assertEquals(sanitizeFilename(".bashrc", FB), { name: "bashrc", ext: null, allowed: false });
});

Deno.test("hostile inputs never produce separators, NUL, or a leading dot", () => {
  const hostile = [
    "../../../../etc/passwd",
    "/etc/shadow",
    "\\\\server\\share\\x.exe",
    "C:\\Windows\\system32\\cmd.exe",
    "~/.ssh/id_rsa",
    "~root/.bashrc",
    "..\\..\\boot.ini",
    "foo\u0000/../../bar",
    "\u0000",
    "a\u0000/b",
    "....//....//x",
    ".\\.\\.\\x",
    "file\u202e.gpj",
    "\uFEFF.\u200Bhidden",
    "name\nwith\rnewline",
    "tab\there",
    "x\u007f.txt",
    "\u009b31m.txt",
    "...",
    "/",
    "\\",
    "//",
    "%2e%2e%2fetc",
    ".. ",
    " . . .",
  ];
  for (const input of hostile) {
    const { name } = sanitizeFilename(input, FB);
    assertSafe(name);
  }
});
