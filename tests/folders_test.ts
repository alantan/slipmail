import { assertEquals, assertThrows } from "@std/assert";
import { discoverFolders, FolderError } from "../src/folders.ts";
import type { ListEntry } from "../src/imap/client.ts";

const entry = (name: string, attrs: string[] = [], delimiter: string | null = "/"): ListEntry => ({
  name,
  attrs,
  delimiter,
});

/** A minimal mailbox list that satisfies discoverFolders' INBOX/Sent/Drafts requirements. */
function baseList(): ListEntry[] {
  return [
    entry("INBOX"),
    entry("Sent", ["\\Sent"]),
    entry("Drafts", ["\\Drafts"]),
  ];
}

Deno.test("folders: special-use attribute wins over a folder named Sent", () => {
  const list = [
    entry("INBOX"),
    entry("Sent"),
    entry("Weird", ["\\Sent"]),
    entry("Drafts", ["\\Drafts"]),
  ];
  assertEquals(discoverFolders(list).sent, "Weird");
});

Deno.test("folders: fallback by last path segment with '/' and '.' delimiters", () => {
  const dotted = [
    entry("INBOX", [], "."),
    entry("INBOX.Sent Items", [], "."),
    entry("INBOX.Drafts", [], "."),
  ];
  const f = discoverFolders(dotted);
  assertEquals(f.sent, "INBOX.Sent Items");
  assertEquals(f.drafts, "INBOX.Drafts");

  const slashed = [
    entry("INBOX"),
    entry("Mail/Sent Mail"),
    entry("Mail/Drafts"),
  ];
  const g = discoverFolders(slashed);
  assertEquals(g.sent, "Mail/Sent Mail");
  assertEquals(g.drafts, "Mail/Drafts");
});

Deno.test("folders: fallback name match is case-insensitive", () => {
  const list = [entry("INBOX"), entry("SENT ITEMS"), entry("drafts")];
  const f = discoverFolders(list);
  assertEquals(f.sent, "SENT ITEMS");
  assertEquals(f.drafts, "drafts");
});

Deno.test("folders: \\Archive is preferred over \\All", () => {
  const list = [...baseList(), entry("All Mail", ["\\All"]), entry("Old", ["\\Archive"])];
  assertEquals(discoverFolders(list).archive, "Old");
});

Deno.test("folders: \\All is used when there is no \\Archive", () => {
  const list = [...baseList(), entry("[Gmail]/All Mail", ["\\All"]), entry("Archive")];
  assertEquals(discoverFolders(list).archive, "[Gmail]/All Mail");
});

Deno.test("folders: archive is null when neither attribute nor name matches", () => {
  assertEquals(discoverFolders(baseList()).archive, null);
});

Deno.test("folders: archive falls back to a common name when no attribute is present", () => {
  const list = [...baseList(), entry("Archives")];
  assertEquals(discoverFolders(list).archive, "Archives");
});

Deno.test("folders: missing INBOX is a FolderError", () => {
  const list = [entry("Sent", ["\\Sent"]), entry("Drafts", ["\\Drafts"])];
  assertThrows(() => discoverFolders(list), FolderError, "INBOX not found");
});

Deno.test("folders: missing Sent is a FolderError", () => {
  const list = [entry("INBOX"), entry("Drafts", ["\\Drafts"])];
  assertThrows(() => discoverFolders(list), FolderError, "Sent folder not found");
});

Deno.test("folders: missing Drafts is a FolderError", () => {
  const list = [entry("INBOX"), entry("Sent", ["\\Sent"])];
  assertThrows(() => discoverFolders(list), FolderError, "Drafts folder not found");
});

Deno.test("folders: \\Noselect and \\NonExistent entries are ignored", () => {
  const onlyNoselect = [
    entry("INBOX"),
    entry("Sent", ["\\Noselect", "\\Sent"]),
    entry("Drafts", ["\\Drafts"]),
  ];
  assertThrows(() => discoverFolders(onlyNoselect), FolderError, "Sent folder not found");

  const nonExistent = [
    entry("INBOX"),
    entry("Gone", ["\\Sent", "\\NonExistent"]),
    entry("Sent Items"),
    entry("Drafts", ["\\Drafts"]),
  ];
  assertEquals(discoverFolders(nonExistent).sent, "Sent Items");

  const archiveNoselect = [...baseList(), entry("Hidden", ["\\Archive", "\\Noselect"])];
  assertEquals(discoverFolders(archiveNoselect).archive, null);
});

Deno.test("folders: an unselectable INBOX is treated as missing", () => {
  const list = [entry("INBOX", ["\\Noselect"]), entry("Sent", ["\\Sent"]), entry("Drafts", ["\\Drafts"])];
  assertThrows(() => discoverFolders(list), FolderError, "INBOX not found");
});

Deno.test("folders: overrides take precedence over attributes and names", () => {
  const list = [
    entry("INBOX"),
    entry("Sent", ["\\Sent"]),
    entry("Custom Sent"),
    entry("Drafts", ["\\Drafts"]),
    entry("Mine", ["\\Archive"]),
    entry("Archive"),
  ];
  const f = discoverFolders(list, { sent: "Custom Sent", archive: "Archive" });
  assertEquals(f.sent, "Custom Sent");
  assertEquals(f.archive, "Archive");
});

Deno.test("folders: an override naming a non-existent folder is a FolderError", () => {
  assertThrows(
    () => discoverFolders(baseList(), { sent: "Nope" }),
    FolderError,
    'configured folder "Nope" does not exist',
  );
  assertThrows(
    () => discoverFolders(baseList(), { archive: "Nope" }),
    FolderError,
    'configured folder "Nope" does not exist',
  );
});

Deno.test("folders: an override naming an unselectable folder is a FolderError", () => {
  const list = [...baseList(), entry("Locked", ["\\Noselect"])];
  assertThrows(
    () => discoverFolders(list, { drafts: "Locked" }),
    FolderError,
    'configured folder "Locked" does not exist',
  );
});

Deno.test("folders: attribute matching is case-insensitive", () => {
  const list = [
    entry("INBOX"),
    entry("Out", ["\\sent"]),
    entry("Dr", ["\\DRAFTS"]),
    entry("Arc", ["\\aRcHiVe"]),
  ];
  const f = discoverFolders(list);
  assertEquals(f.sent, "Out");
  assertEquals(f.drafts, "Dr");
  assertEquals(f.archive, "Arc");
});

Deno.test("folders: raw server names are returned unchanged (modified UTF-7 kept)", () => {
  const raw = "&AOk-nvoy&AOk-s";
  const list = [entry("INBOX"), entry(raw, ["\\Sent"]), entry("Drafts", ["\\Drafts"])];
  assertEquals(discoverFolders(list).sent, raw);
});
