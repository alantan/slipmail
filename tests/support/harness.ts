import {
  type FakeFolder,
  FakeImapServer,
  type FakeServerOptions,
  makeFolder,
  makeTestCerts,
} from "./fake_imap.ts";
import { ImapClient } from "../../src/imap/client.ts";

export const USER = "me@example.test";
export const PASSWORD = "test-password-not-real";

export interface Harness {
  server: FakeImapServer;
  ca: string;
  connect(): Promise<ImapClient>;
  close(): Promise<void>;
}

/** Standard folder set: INBOX, Sent Items (\Sent), Drafts (\Drafts), Archive (\Archive). */
export function standardFolders(
  inbox: Array<{ uid?: number; flags?: string[]; raw: string }> = [],
): FakeFolder[] {
  return [
    makeFolder("INBOX", undefined, inbox),
    makeFolder("Sent Items", "\\Sent"),
    makeFolder("Drafts", "\\Drafts"),
    makeFolder("Archive", "\\Archive"),
  ];
}

export async function startHarness(
  folders: FakeFolder[] = standardFolders(),
  extra: Partial<FakeServerOptions> = {},
): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "slipmail-test-" });
  const { cert, key, ca } = await makeTestCerts(dir);
  const server = new FakeImapServer({ user: USER, password: PASSWORD, cert, key, folders, ...extra });
  return {
    server,
    ca,
    connect: () => ImapClient.connect({ host: "127.0.0.1", port: server.port, ca, timeoutMs: 5000 }),
    async close() {
      await server.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

/** Build a CRLF RFC 822 message from headers and a body. All addresses use example.com/.test. */
export function rfc822(headers: Record<string, string>, body: string): string {
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  return `${head}\r\n\r\n${body.replace(/\r?\n/g, "\r\n")}`;
}

/** Decoded bodies of a multipart/alternative draft, keyed by content type (e.g. "text/html"). */
export function draftParts(raw: string): Record<string, string> {
  const boundary = /Content-Type: multipart\/alternative; boundary="([^"]+)"/.exec(raw)?.[1];
  if (!boundary) throw new Error("draft is not multipart/alternative");
  const out: Record<string, string> = {};
  for (const chunk of raw.split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = chunk.split("\r\n\r\n");
    const type = /Content-Type: ([^;\r\n]+); charset=utf-8/.exec(head)?.[1];
    if (!type || !/Content-Transfer-Encoding: base64/.test(head)) throw new Error("bad part headers");
    const b64 = rest.join("\r\n\r\n").replace(/\s+/g, "");
    out[type] = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  }
  return out;
}
