// Minimal IMAP client. The command allow-list below is the structural guarantee that this
// program can read mail and append drafts, and nothing else: there is no code path that can
// put STORE, EXPUNGE, COPY, MOVE, DELETE, CREATE, RENAME or SUBSCRIBE on the wire.

import {
  fromWire,
  type Node,
  nodeList,
  nodeStr,
  ProtocolError,
  quoteString,
  ResponseParser,
  WireReader,
} from "./protocol.ts";

export { ProtocolError };

/** Every verb this client may send. `run()` refuses anything else. */
export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "CAPABILITY",
  "AUTHENTICATE",
  "LOGIN",
  "LIST",
  "EXAMINE", // read-only open; SELECT is deliberately absent
  "UID FETCH",
  "UID SEARCH",
  "APPEND",
  "LOGOUT",
]);

export class ImapCommandError extends Error {
  constructor(public status: string, message: string) {
    super(message);
  }
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  /** PEM CA certificate to trust, for tests with a throw-away server only. Never set by main.ts. */
  ca?: string;
  timeoutMs?: number;
  maxLiteralBytes?: number;
}

export interface ListEntry {
  name: string;
  attrs: string[];
  delimiter: string | null;
}

export interface MailboxInfo {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface FetchResult {
  seq: number;
  uid: number;
  flags: string[];
  size?: number;
  internalDate?: string;
  /** Full RFC 822 source, when `source` was requested. */
  source?: Uint8Array;
  /** Requested header block, when `headerFields` was requested. */
  header?: Uint8Array;
}

export interface FetchWhat {
  flags?: boolean;
  size?: boolean;
  internalDate?: boolean;
  source?: boolean;
  headerFields?: string[];
}

export type SearchCriterion =
  | { kind: "header"; name: string; value: string }
  | { kind: "uid"; set: string }
  | { kind: "or"; a: SearchCriterion; b: SearchCriterion }
  | { kind: "all" };

const UID_SET = /^\d+(:(\d+|\*))?(,\d+(:(\d+|\*))?)*$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const PRINTABLE_ASCII = /^[\x21\x23-\x5b\x5d-\x7e]+$/; // printable, no space, quote or backslash

interface RunOpts {
  onUntagged?: (kind: string, num: number | undefined, p: ResponseParser) => Promise<void>;
  onStatus?: (text: string) => void;
  continuation?: () => string | Uint8Array;
}

export class ImapClient {
  capabilities = new Set<string>();
  private tag = 0;
  private broken = false;
  private reader: WireReader;
  private maxLiteral: number;

  private constructor(private conn: Deno.TlsConn, opts: ImapConnectOptions) {
    this.maxLiteral = opts.maxLiteralBytes ?? 64 * 1024 * 1024;
    this.reader = new WireReader(conn, opts.timeoutMs ?? 30_000);
  }

  static async connect(opts: ImapConnectOptions): Promise<ImapClient> {
    const conn = await Deno.connectTls({
      hostname: opts.host,
      port: opts.port,
      ...(opts.ca ? { caCerts: [opts.ca] } : {}),
    });
    const client = new ImapClient(conn, opts);
    try {
      const greeting = await client.reader.readLine();
      if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) throw new ProtocolError("unexpected server greeting");
      client.noteCapabilityCode(greeting);
      if (client.capabilities.size === 0) await client.refreshCapabilities();
    } catch (e) {
      conn.close();
      throw e;
    }
    return client;
  }

  private noteCapabilityCode(text: string) {
    const m = text.match(/\[CAPABILITY ([^\]]+)\]/i);
    if (m) this.capabilities = new Set(m[1].toUpperCase().split(/\s+/));
  }

  async refreshCapabilities() {
    await this.run("CAPABILITY", "", {
      onUntagged: async (kind, _n, p) => {
        if (kind === "CAPABILITY") this.capabilities = new Set(p.rest().trim().toUpperCase().split(/\s+/));
        else await drain(p);
      },
    });
  }

  async login(user: string, password: string): Promise<void> {
    if (this.capabilities.has("AUTH=PLAIN")) {
      const blob = btoa(String.fromCharCode(...new TextEncoder().encode(`\u0000${user}\u0000${password}`)));
      await this.run("AUTHENTICATE", "PLAIN", { continuation: () => blob + "\r\n" });
    } else if (this.capabilities.has("LOGINDISABLED")) {
      throw new ImapCommandError("NO", "server offers no usable login mechanism");
    } else {
      // quoteString cannot carry non-ASCII, and LOGIN literals are not implemented.
      if (/[^\x20-\x7e]/.test(user + password)) {
        throw new ImapCommandError(
          "NO",
          "server lacks AUTH=PLAIN; non-ASCII credentials are not supported over LOGIN",
        );
      }
      await this.run("LOGIN", `${quoteString(user)} ${quoteString(password)}`);
    }
    await this.refreshCapabilities();
  }

  async list(): Promise<ListEntry[]> {
    const out: ListEntry[] = [];
    const args = this.capabilities.has("SPECIAL-USE") ? `"" "*" RETURN (SPECIAL-USE)` : `"" "*"`;
    await this.run("LIST", args, {
      onUntagged: async (kind, _n, p) => {
        if (kind !== "LIST") return await drain(p);
        const attrs = nodeList(await p.value()).map((a) => String(nodeStr(a)));
        const delim = nodeStr(await p.value());
        const name = nodeStr(await p.value());
        if (name !== null) out.push({ name, attrs, delimiter: delim });
      },
    });
    return out;
  }

  /** Opens a mailbox read-only (EXAMINE). */
  async examine(name: string): Promise<MailboxInfo> {
    const info: MailboxInfo = { uidValidity: 0, uidNext: 0, exists: 0 };
    await this.run("EXAMINE", quoteString(name), {
      onStatus: (t) => {
        const v = t.match(/\[UIDVALIDITY (\d+)\]/i);
        const nx = t.match(/\[UIDNEXT (\d+)\]/i);
        if (v) info.uidValidity = Number(v[1]);
        if (nx) info.uidNext = Number(nx[1]);
      },
      onUntagged: async (kind, n, p) => {
        if (kind === "EXISTS" && n !== undefined) info.exists = n;
        else await drain(p);
      },
    });
    if (!info.uidValidity) throw new ProtocolError("server did not report UIDVALIDITY");
    return info;
  }

  async uidFetch(set: string, what: FetchWhat): Promise<FetchResult[]> {
    if (!UID_SET.test(set)) throw new ProtocolError("invalid UID set");
    const items = ["UID"];
    if (what.flags) items.push("FLAGS");
    if (what.size) items.push("RFC822.SIZE");
    if (what.internalDate) items.push("INTERNALDATE");
    if (what.source) items.push("BODY.PEEK[]"); // PEEK: never sets \Seen
    if (what.headerFields?.length) {
      for (const h of what.headerFields) {
        if (!HEADER_NAME.test(h)) throw new ProtocolError("invalid header name");
      }
      items.push(`BODY.PEEK[HEADER.FIELDS (${what.headerFields.join(" ")})]`);
    }
    const byUid = new Map<number, FetchResult>();
    await this.run("UID FETCH", `${set} (${items.join(" ")})`, {
      onUntagged: async (kind, n, p) => {
        if (kind !== "FETCH" || n === undefined) return await drain(p);
        const list = nodeList(await p.value());
        const r: Partial<FetchResult> & { seq: number; uid: number } = { seq: n, uid: 0 };
        for (let i = 0; i + 1 < list.length; i += 2) {
          const key = String(nodeStr(list[i])).toUpperCase().replace(/<[\d.]+>$/, "");
          const val: Node = list[i + 1];
          if (key === "UID") r.uid = Number(nodeStr(val));
          else if (key === "FLAGS") r.flags = nodeList(val).map((f) => String(nodeStr(f)));
          else if (key === "RFC822.SIZE") r.size = Number(nodeStr(val));
          else if (key === "INTERNALDATE") r.internalDate = nodeStr(val) ?? undefined;
          else if (key === "BODY[]") r.source = toBytes(val);
          else if (key.startsWith("BODY[HEADER")) r.header = toBytes(val);
        }
        // Servers may interleave unsolicited updates (e.g. flags for other messages) and split
        // one message across several responses: merge by UID and keep only requested UIDs.
        if (!r.uid || !inUidSet(r.uid, set)) return;
        const prev = byUid.get(r.uid);
        byUid.set(r.uid, prev ? { ...prev, ...r } : { flags: [], ...r });
      },
    });
    return [...byUid.values()];
  }

  async uidSearch(criterion: SearchCriterion): Promise<number[]> {
    const hits: number[] = [];
    await this.run("UID SEARCH", renderCriterion(criterion), {
      onUntagged: async (kind, _n, p) => {
        if (kind !== "SEARCH") return await drain(p);
        for (const t of p.rest().trim().split(/\s+/)) if (/^\d+$/.test(t)) hits.push(Number(t));
      },
    });
    return hits;
  }

  /** The only write: APPEND to a folder. Flags are limited to \Draft. */
  async appendDraft(folder: string, message: Uint8Array): Promise<void> {
    const lit = message;
    await this.run("APPEND", `${quoteString(folder)} (\\Draft) {${lit.length}}`, {
      continuation: () => {
        const tail = new Uint8Array(lit.length + 2);
        tail.set(lit);
        tail.set([13, 10], lit.length);
        return tail;
      },
    });
  }

  async logout(): Promise<void> {
    try {
      // After a transport/protocol failure the stream state is unknown: just close, don't wait again.
      if (!this.broken) await this.run("LOGOUT", "");
    } catch { /* server may close first */ }
    try {
      this.conn.close();
    } catch { /* already closed */ }
  }

  private async run(verb: string, args: string, opts: RunOpts = {}): Promise<void> {
    try {
      await this.runInner(verb, args, opts);
    } catch (e) {
      // A server NO/BAD leaves the stream usable; anything else (timeout, EOF, bad framing) does not.
      if (!(e instanceof ImapCommandError)) {
        this.broken = true;
      }
      throw e;
    }
  }

  private async runInner(verb: string, args: string, opts: RunOpts): Promise<void> {
    if (!ALLOWED_COMMANDS.has(verb)) throw new ProtocolError(`command not permitted: ${verb}`);
    const tag = `s${++this.tag}`;
    await writeAll(this.conn, new TextEncoder().encode(`${tag} ${verb}${args ? " " + args : ""}\r\n`));
    for (;;) {
      const line = await this.reader.readLine();
      if (line.startsWith("+")) {
        if (!opts.continuation) throw new ProtocolError("unexpected continuation request");
        const payload = opts.continuation();
        await writeAll(this.conn, typeof payload === "string" ? new TextEncoder().encode(payload) : payload);
        continue;
      }
      if (line.startsWith("* ")) {
        const p = new ResponseParser(line.slice(2), this.reader, this.maxLiteral);
        let first = p.atomRaw();
        let num: number | undefined;
        if (/^\d+$/.test(first)) {
          num = Number(first);
          first = p.atomRaw();
        }
        const kind = first.toUpperCase();
        if (kind === "BYE") throw new ProtocolError("server closed the session");
        if (kind === "OK" || kind === "NO" || kind === "PREAUTH") {
          const text = p.rest();
          this.noteCapabilityCode(text);
          if (kind === "OK") opts.onStatus?.(text);
          continue;
        }
        if (kind === "CAPABILITY" && !opts.onUntagged) {
          this.capabilities = new Set(p.rest().trim().toUpperCase().split(/\s+/));
          continue;
        }
        if (opts.onUntagged) await opts.onUntagged(kind, num, p);
        else await drain(p);
        continue;
      }
      const m = line.match(/^(\S+) (OK|NO|BAD)\s*(.*)$/i);
      if (m && m[1] === tag) {
        const status = m[2].toUpperCase();
        if (status !== "OK") {
          throw new ImapCommandError(status, `${verb} failed: ${fromWire(m[3]).slice(0, 200)}`);
        }
        this.noteCapabilityCode(m[3]);
        opts.onStatus?.(m[3]);
        return;
      }
      // Anything else is a protocol violation.
      throw new ProtocolError("unexpected server response");
    }
  }
}

/** Socket writes may be short; keep going until the whole buffer is out. */
export async function writeAll(
  w: { write(p: Uint8Array): Promise<number> },
  data: Uint8Array,
): Promise<void> {
  let off = 0;
  while (off < data.length) off += await w.write(data.subarray(off));
}

function inUidSet(uid: number, set: string): boolean {
  return set.split(",").some((part) => {
    const [a, b] = part.split(":");
    const lo = Number(a);
    if (b === undefined) return uid === lo;
    const hi = b === "*" ? Infinity : Number(b);
    return uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi);
  });
}

async function drain(p: ResponseParser): Promise<void> {
  while (!p.atEnd()) {
    p.skipSpaces();
    if (p.atEnd()) break;
    await p.value();
  }
}

function toBytes(n: Node): Uint8Array {
  if (n instanceof Uint8Array) return n;
  return new TextEncoder().encode(nodeStr(n) ?? "");
}

function renderCriterion(c: SearchCriterion): string {
  switch (c.kind) {
    case "all":
      return "ALL";
    case "uid":
      if (!UID_SET.test(c.set)) throw new ProtocolError("invalid UID set");
      return `UID ${c.set}`;
    case "header":
      if (!HEADER_NAME.test(c.name)) throw new ProtocolError("invalid header name");
      if (!PRINTABLE_ASCII.test(c.value)) throw new ProtocolError("invalid search value");
      return `HEADER ${c.name} ${quoteString(c.value)}`;
    case "or":
      return `OR ${renderCriterion(c.a)} ${renderCriterion(c.b)}`;
  }
}
