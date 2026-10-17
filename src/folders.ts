// Folder discovery: SPECIAL-USE attributes first, then common names, with optional
// build-time overrides taking precedence. Raw server names are kept exactly as listed
// (modified UTF-7 included) so they can be passed back to the server unchanged.

import type { ListEntry } from "./imap/client.ts";
import type { FolderOverrides } from "./config.ts";

export class FolderError extends Error {}

export interface Folders {
  inbox: string;
  sent: string;
  drafts: string;
  /** \Archive, else \All (Gmail "All Mail"), else a common name. May be absent. */
  archive: string | null;
}

const FALLBACKS = {
  sent: ["sent", "sent items", "sent mail", "sent messages"],
  drafts: ["drafts", "draft", "draft messages"],
  archive: ["archive", "archives", "all mail"],
};

function selectable(e: ListEntry): boolean {
  const a = e.attrs.map((x) => x.toLowerCase());
  return !a.includes("\\noselect") && !a.includes("\\nonexistent");
}

function hasAttr(e: ListEntry, attr: string): boolean {
  return e.attrs.some((a) => a.toLowerCase() === attr.toLowerCase());
}

function lastSegment(e: ListEntry): string {
  const d = e.delimiter;
  const parts = d ? e.name.split(d) : [e.name];
  return parts[parts.length - 1].toLowerCase();
}

function pick(
  entries: ListEntry[],
  override: string | undefined,
  attrs: string[],
  names: string[],
): string | null {
  if (override !== undefined) {
    const hit = entries.find((e) => e.name === override);
    if (!hit) throw new FolderError(`configured folder "${override}" does not exist on the server`);
    return hit.name;
  }
  for (const attr of attrs) {
    const hit = entries.find((e) => hasAttr(e, attr));
    if (hit) return hit.name;
  }
  for (const n of names) {
    const hit = entries.find((e) => lastSegment(e) === n);
    if (hit) return hit.name;
  }
  return null;
}

export function discoverFolders(all: ListEntry[], overrides: FolderOverrides = {}): Folders {
  const entries = all.filter(selectable);
  const inbox = entries.find((e) => e.name.toUpperCase() === "INBOX");
  if (!inbox) throw new FolderError("INBOX not found on the server");

  const sent = pick(entries, overrides.sent, ["\\Sent"], FALLBACKS.sent);
  if (!sent) {
    throw new FolderError(
      "Sent folder not found: no \\Sent attribute and no common name; set a Sent override at build time",
    );
  }
  const drafts = pick(entries, overrides.drafts, ["\\Drafts"], FALLBACKS.drafts);
  if (!drafts) {
    throw new FolderError(
      "Drafts folder not found: no \\Drafts attribute and no common name; set a Drafts override at build time",
    );
  }
  const archive = pick(entries, overrides.archive, ["\\Archive", "\\All"], FALLBACKS.archive);
  return { inbox: inbox.name, sent, drafts, archive };
}
