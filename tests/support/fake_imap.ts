// Minimal in-process IMAP-over-TLS server for tests. Supports only what slipmail
// needs. Every command received is recorded in `commandLog` so tests can assert
// that the broker never issues anything outside its allow-list.

export interface FakeMessage {
  uid: number;
  flags: string[];
  raw: string; // full RFC 822 source, CRLF line endings
  internalDate?: string;
}

export interface FakeFolder {
  name: string;
  specialUse?: string; // e.g. "\\Sent"
  uidValidity: number;
  messages: FakeMessage[];
  nextUid: number;
}

export interface FakeServerOptions {
  user: string;
  password: string;
  cert: string;
  key: string;
  folders: FakeFolder[];
  capabilities?: string[];
  /** How EXAMINE/SELECT reports UIDVALIDITY/UIDNEXT. Default "untagged". */
  /** Emit unsolicited FETCH updates and split each response into fragments. */
  interleaveFetch?: boolean;
  /** Greet with PREAUTH (already authenticated) and reject any LOGIN/AUTHENTICATE. */
  preauth?: boolean;
  /** Send a second, unsolicited continuation request after the first one for a literal. */
  extraContinuation?: boolean;
  examineStyle?: "untagged" | "tagged-only" | "no-uidnext";
}

type Tok = string | Tok[];

const enc = new TextEncoder();
const dec = new TextDecoder();

export function makeFolder(
  name: string,
  specialUse?: string,
  messages: Array<Partial<FakeMessage> & { raw: string }> = [],
): FakeFolder {
  const folder: FakeFolder = { name, specialUse, uidValidity: 1001, messages: [], nextUid: 1 };
  for (const m of messages) {
    folder.messages.push({
      uid: m.uid ?? folder.nextUid,
      flags: m.flags ?? [],
      raw: m.raw,
      internalDate: m.internalDate,
    });
    folder.nextUid = Math.max(folder.nextUid, (m.uid ?? folder.nextUid) + 1);
  }
  return folder;
}

export class FakeImapServer {
  readonly commandLog: string[] = [];
  readonly folders: FakeFolder[];
  private listener: Deno.TlsListener;
  private done: Promise<void>;
  private closed = false;
  private conns = new Set<Deno.Conn>();

  constructor(private opts: FakeServerOptions) {
    this.folders = opts.folders;
    this.listener = Deno.listenTls({
      hostname: "127.0.0.1",
      port: 0,
      cert: opts.cert,
      key: opts.key,
    });
    this.done = this.acceptLoop();
  }

  get port(): number {
    return (this.listener.addr as Deno.NetAddr).port;
  }

  folder(name: string): FakeFolder {
    const f = this.folders.find((x) => x.name === name);
    if (!f) throw new Error(`no such fake folder ${name}`);
    return f;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listener.close();
    for (const c of this.conns) {
      try {
        c.close();
      } catch { /* already closed */ }
    }
    await this.done.catch(() => {});
  }

  private async acceptLoop() {
    while (!this.closed) {
      let conn: Deno.Conn;
      try {
        conn = await this.listener.accept();
      } catch {
        return;
      }
      this.conns.add(conn);
      this.session(conn).catch(() => {}).finally(() => {
        try {
          conn.close(); // release the server-side TLS resource before forgetting it
        } catch { /* already closed */ }
        this.conns.delete(conn);
      });
    }
  }

  private async session(conn: Deno.Conn) {
    const caps = this.opts.capabilities ?? ["IMAP4rev1", "SPECIAL-USE", "UIDPLUS", "ID", "AUTH=PLAIN"];
    let buf = new Uint8Array(0);
    // conn.write may accept only a prefix of the buffer, so loop until everything is written.
    const send = async (s: string | Uint8Array) => {
      const data = typeof s === "string" ? enc.encode(s) : s;
      let off = 0;
      while (off < data.length) off += await conn.write(data.subarray(off));
      return off;
    };
    const readMore = async (): Promise<boolean> => {
      const chunk = new Uint8Array(65536);
      const n = await conn.read(chunk);
      if (n === null) return false;
      const merged = new Uint8Array(buf.length + n);
      merged.set(buf);
      merged.set(chunk.subarray(0, n), buf.length);
      buf = merged;
      return true;
    };
    const readLine = async (): Promise<string | null> => {
      for (;;) {
        for (let i = 0; i + 1 < buf.length; i++) {
          if (buf[i] === 13 && buf[i + 1] === 10) {
            const line = dec.decode(buf.subarray(0, i));
            buf = buf.subarray(i + 2);
            return line;
          }
        }
        if (!(await readMore())) return null;
      }
    };
    const readBytes = async (n: number): Promise<string | null> => {
      while (buf.length < n) if (!(await readMore())) return null;
      const out = dec.decode(buf.subarray(0, n));
      buf = buf.subarray(n);
      return out;
    };

    let authed = false;
    let selected: FakeFolder | null = null;
    if (this.opts.preauth) {
      authed = true;
      await send(`* PREAUTH [CAPABILITY ${caps.join(" ")}] fake ready\r\n`);
    } else await send(`* OK [CAPABILITY ${caps.join(" ")}] fake ready\r\n`);

    for (;;) {
      // Assemble a full command line, resolving synchronising literals.
      let line = await readLine();
      if (line === null) return;
      const literals: string[] = [];
      for (;;) {
        const m: RegExpMatchArray | null = line.match(/\{(\d+)\}$/);
        if (!m) break;
        await send("+ go ahead\r\n");
        if (this.opts.extraContinuation) await send("+ again\r\n");
        const lit = await readBytes(Number(m[1]));
        if (lit === null) return;
        literals.push(lit);
        const rest = await readLine();
        if (rest === null) return;
        line = line.slice(0, line.length - m[0].length) + `\u0000LIT${literals.length - 1}\u0000` + rest;
      }
      const sp = line.indexOf(" ");
      const tag = sp < 0 ? line : line.slice(0, sp);
      const rest = sp < 0 ? "" : line.slice(sp + 1);
      const toks = tokenize(rest, literals);
      const cmd = String(toks[0] ?? "").toUpperCase();
      const isUid = cmd === "UID";
      const effective = isUid ? String(toks[1] ?? "").toUpperCase() : cmd;
      this.commandLog.push(isUid ? `UID ${effective}` : cmd);
      const args = toks.slice(isUid ? 2 : 1);

      const ok = (text = "completed") => send(`${tag} OK ${text}\r\n`);
      const no = (text: string) => send(`${tag} NO ${text}\r\n`);
      const bad = (text: string) => send(`${tag} BAD ${text}\r\n`);

      switch (effective) {
        case "CAPABILITY":
          await send(`* CAPABILITY ${caps.join(" ")}\r\n`);
          await ok();
          break;
        case "ID":
          await send(`* ID NIL\r\n`);
          await ok();
          break;
        case "NOOP":
          await ok();
          break;
        case "LOGOUT":
          await send("* BYE bye\r\n");
          await ok();
          conn.close();
          return;
        case "LOGIN": {
          if (authed) {
            await bad("already authenticated");
            break;
          }
          if (args[0] === this.opts.user && args[1] === this.opts.password) {
            authed = true;
            await ok("LOGIN completed");
          } else await no("[AUTHENTICATIONFAILED] bad credentials");
          break;
        }
        case "AUTHENTICATE": {
          if (authed) {
            await bad("already authenticated");
            break;
          }
          let ir = args[1] as string | undefined;
          if (!ir) {
            await send("+ \r\n");
            ir = (await readLine()) ?? "";
          }
          // atob yields a binary string; the client sends UTF-8 bytes, so decode bytes as UTF-8.
          const bytes = Uint8Array.from(atob(ir), (c) => c.charCodeAt(0));
          const [, u, p] = dec.decode(bytes).split("\u0000");
          if (u === this.opts.user && p === this.opts.password) {
            authed = true;
            await ok("AUTHENTICATE completed");
          } else await no("[AUTHENTICATIONFAILED] bad credentials");
          break;
        }
        default: {
          if (!authed) {
            await bad("not authenticated");
            break;
          }
          switch (effective) {
            case "NAMESPACE":
              await send(`* NAMESPACE (("" "/")) NIL NIL\r\n`);
              await ok();
              break;
            case "ENABLE":
              await ok();
              break;
            case "LIST": {
              for (const f of this.folders) {
                const attrs = ["\\HasNoChildren", ...(f.specialUse ? [f.specialUse] : [])];
                await send(`* LIST (${attrs.join(" ")}) "/" ${quote(f.name)}\r\n`);
              }
              await ok("LIST completed");
              break;
            }
            case "STATUS": {
              const f = this.findFolder(args[0]);
              if (!f) {
                await no("no such folder");
                break;
              }
              await send(
                `* STATUS ${
                  quote(f.name)
                } (MESSAGES ${f.messages.length} UIDNEXT ${f.nextUid} UIDVALIDITY ${f.uidValidity} UNSEEN 0)\r\n`,
              );
              await ok();
              break;
            }
            case "SELECT":
            case "EXAMINE": {
              const f = this.findFolder(args[0]);
              if (!f) {
                await no("no such folder");
                break;
              }
              selected = f;
              await send(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n`);
              await send(`* ${f.messages.length} EXISTS\r\n* 0 RECENT\r\n`);
              const style = this.opts.examineStyle ?? "untagged";
              if (style === "untagged") {
                await send(`* OK [UIDVALIDITY ${f.uidValidity}] ok\r\n* OK [UIDNEXT ${f.nextUid}] ok\r\n`);
              } else if (style === "no-uidnext") {
                await send(`* OK [UIDVALIDITY ${f.uidValidity}] ok\r\n`);
              }
              // "tagged-only": UIDVALIDITY/UIDNEXT appear solely as codes on the tagged OK.
              const codes = style === "tagged-only"
                ? `[UIDVALIDITY ${f.uidValidity}] [UIDNEXT ${f.nextUid}] `
                : "";
              await send(
                effective === "SELECT"
                  ? `${tag} OK [READ-WRITE] ${codes}SELECT completed\r\n`
                  : `${tag} OK [READ-ONLY] ${codes}EXAMINE completed\r\n`,
              );
              break;
            }
            case "UNSELECT":
            case "CLOSE":
              selected = null;
              await ok();
              break;
            case "FETCH": {
              if (!selected) {
                await bad("no mailbox selected");
                break;
              }
              await this.doFetch(send, selected, args, isUid);
              await ok("FETCH completed");
              break;
            }
            case "SEARCH": {
              if (!selected) {
                await bad("no mailbox selected");
                break;
              }
              let crit = args;
              if (String(crit[0]).toUpperCase() === "CHARSET") crit = crit.slice(2);
              const hits = selected.messages
                .map((m, i) => ({ m, seq: i + 1 }))
                .filter(({ m, seq }) => matches(m, seq, selected!, crit.slice() as Tok[]))
                .map(({ m, seq }) => (isUid ? m.uid : seq));
              await send(`* SEARCH${hits.length ? " " + hits.join(" ") : ""}\r\n`);
              await ok("SEARCH completed");
              break;
            }
            case "APPEND": {
              const f = this.findFolder(args[0]);
              if (!f) {
                await no("[TRYCREATE] no such folder");
                break;
              }
              const flagsTok = args.find((a, i) => i > 0 && Array.isArray(a)) as string[] | undefined;
              const body = args[args.length - 1] as string;
              const uid = f.nextUid++;
              f.messages.push({ uid, flags: flagsTok ?? [], raw: body });
              await ok(`[APPENDUID ${f.uidValidity} ${uid}] APPEND completed`);
              break;
            }
            default:
              // STORE, EXPUNGE, COPY, MOVE, DELETE, CREATE, RENAME ... are not implemented on purpose.
              await bad(`command ${effective} not supported by fake server`);
          }
        }
      }
    }
  }

  private findFolder(t: Tok): FakeFolder | undefined {
    const name = String(t);
    return this.folders.find((f) =>
      f.name === name || (name.toUpperCase() === "INBOX" && f.name === "INBOX")
    );
  }

  private async doFetch(
    send: (s: string | Uint8Array) => Promise<number>,
    folder: FakeFolder,
    args: Tok[],
    isUid: boolean,
  ) {
    const set = String(args[0]);
    const itemsTok = args[1];
    const items = (Array.isArray(itemsTok) ? itemsTok : [itemsTok]).map((t) => String(t));
    // Items such as BODY.PEEK[HEADER.FIELDS (A B)] arrive tokenised oddly; re-join from the raw list.
    const joined = joinItems(Array.isArray(itemsTok) ? (itemsTok as Tok[]) : [itemsTok]);
    void items;
    const maxUid = folder.messages.reduce((a, m) => Math.max(a, m.uid), 0);
    const maxSeq = folder.messages.length;
    const wanted = parseSet(set, isUid ? maxUid : maxSeq);
    // RFC 3501 quirk: "n:*" with n above the highest value still returns the highest message.
    const picks: Array<{ m: FakeMessage; seq: number }> = [];
    folder.messages.forEach((m, i) => {
      const key = isUid ? m.uid : i + 1;
      if (wanted.some(([lo, hi]) => key >= lo && key <= hi)) picks.push({ m, seq: i + 1 });
    });
    if (picks.length === 0 && folder.messages.length > 0 && /:\*$/.test(set)) {
      const last = folder.messages[folder.messages.length - 1];
      picks.push({ m: last, seq: folder.messages.length });
    }
    for (const { m, seq } of picks) {
      const parts: Array<string | Uint8Array> = [];
      parts.push(`UID ${m.uid}`);
      for (const it of joined) {
        const u = it.toUpperCase();
        if (u === "UID") continue;
        else if (u === "FLAGS") parts.push(`FLAGS (${m.flags.join(" ")})`);
        else if (u === "RFC822.SIZE") parts.push(`RFC822.SIZE ${enc.encode(m.raw).length}`);
        else if (u === "INTERNALDATE") {
          parts.push(`INTERNALDATE "${m.internalDate ?? "17-Oct-2026 10:00:00 +0000"}"`);
        } else if (u === "ENVELOPE") parts.push(`ENVELOPE ${envelope(m.raw)}`);
        else if (u.startsWith("BODY.PEEK[") || u.startsWith("BODY[")) {
          const section = it.slice(it.indexOf("[") + 1, it.lastIndexOf("]"));
          const partial = it.slice(it.lastIndexOf("]") + 1).match(/^<0\.(\d+)>$/);
          const full = enc.encode(bodySection(m.raw, section));
          const bytes = partial ? full.subarray(0, Number(partial[1])) : full;
          const label = `BODY[${section}]${partial ? "<0>" : ""}`;
          parts.push(label + ` {${bytes.length}}\r\n`, bytes);
        }
      }
      if (this.opts.interleaveFetch) {
        // An unsolicited flags update for a different message, then a flags-only fragment for this one.
        const other = folder.messages.find((x) => x.uid !== m.uid);
        if (other) {
          await send(`* ${folder.messages.indexOf(other) + 1} FETCH (UID ${other.uid} FLAGS (\\Seen))\r\n`);
        }
        await send(`* ${seq} FETCH (UID ${m.uid} FLAGS (${m.flags.join(" ")}))\r\n`);
      }
      const out: Array<string | Uint8Array> = [`* ${seq} FETCH (`];
      parts.forEach((p, i) => {
        if (i > 0 && typeof p === "string" && !out[out.length - 1]?.toString().endsWith("}\r\n")) {
          out.push(" ");
        } else if (i > 0 && typeof p === "string" && out[out.length - 1] instanceof Uint8Array) out.push(" ");
        out.push(p);
      });
      out.push(")\r\n");
      for (const o of out) await send(o);
    }
  }
}

function joinItems(toks: Tok[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (typeof t === "string" && /\[$/.test(t)) {
      // Not produced by our tokenizer; kept for safety.
      out.push(t);
    } else if (typeof t === "string") {
      out.push(t);
    } else {
      out.push(`(${t.join(" ")})`);
    }
  }
  return out;
}

function tokenize(s: string, literals: string[]): Tok[] {
  let i = 0;
  const parseList = (): Tok[] => {
    const out: Tok[] = [];
    while (i < s.length) {
      const c = s[i];
      if (c === " ") i++;
      else if (c === ")") {
        i++;
        return out;
      } else out.push(parseOne());
    }
    return out;
  };
  const parseOne = (): Tok => {
    const c = s[i];
    if (c === "(") {
      i++;
      return parseList();
    }
    if (c === '"') {
      i++;
      let v = "";
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") i++;
        v += s[i++];
      }
      i++;
      return v;
    }
    if (c === "\u0000") {
      const end = s.indexOf("\u0000", i + 1);
      const idx = Number(s.slice(i + 4, end));
      i = end + 1;
      return literals[idx];
    }
    // atom; may contain [ ... ] sections with embedded spaces/parens
    let v = "";
    let depth = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "[") depth++;
      if (ch === "]") depth--;
      if (depth === 0 && (ch === " " || ch === ")" || ch === "(")) break;
      v += ch;
      i++;
    }
    return v;
  };
  const out: Tok[] = [];
  while (i < s.length) {
    if (s[i] === " ") i++;
    else out.push(parseOne());
  }
  return out;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseSet(set: string, max: number): Array<[number, number]> {
  return set.split(",").map((part) => {
    const [a, b] = part.split(":");
    const lo = a === "*" ? max : Number(a);
    const hi = b === undefined ? lo : b === "*" ? max : Number(b);
    return [Math.min(lo, hi), Math.max(lo, hi)] as [number, number];
  });
}

function splitHeaders(raw: string): { head: string; body: string } {
  const idx = raw.indexOf("\r\n\r\n");
  return idx < 0 ? { head: raw, body: "" } : { head: raw.slice(0, idx + 2), body: raw.slice(idx + 4) };
}

export function headerMap(raw: string): Map<string, string[]> {
  const { head } = splitHeaders(raw);
  const unfolded = head.replace(/\r\n[ \t]+/g, " ");
  const map = new Map<string, string[]>();
  for (const l of unfolded.split("\r\n")) {
    const i = l.indexOf(":");
    if (i <= 0) continue;
    const k = l.slice(0, i).toLowerCase();
    const v = l.slice(i + 1).trim();
    map.set(k, [...(map.get(k) ?? []), v]);
  }
  return map;
}

function bodySection(raw: string, section: string): string {
  const sec = section.toUpperCase();
  if (sec === "") return raw;
  const { head, body } = splitHeaders(raw);
  if (sec === "HEADER") return head + "\r\n";
  if (sec === "TEXT") return body;
  const m = sec.match(/^HEADER\.FIELDS \((.*)\)$/);
  if (m) {
    const names = m[1].split(/\s+/).map((x) => x.toLowerCase());
    const unfolded = head.split(/\r\n(?![ \t])/).filter((l) =>
      l && names.includes(l.split(":")[0].toLowerCase())
    );
    return unfolded.join("\r\n") + "\r\n\r\n";
  }
  return "";
}

function addrList(v: string | undefined): string {
  if (!v) return "NIL";
  const out: string[] = [];
  for (const piece of v.split(",")) {
    const m = piece.trim().match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/) ?? piece.trim().match(/^()([^\s<>]+)$/);
    if (!m) continue;
    const [mailbox, host] = m[2].split("@");
    const name = m[1]?.trim();
    out.push(`(${name ? quote(name) : "NIL"} NIL ${quote(mailbox)} ${quote(host ?? "")})`);
  }
  return out.length ? `(${out.join("")})` : "NIL";
}

function envelope(raw: string): string {
  const h = headerMap(raw);
  const g = (k: string) => h.get(k)?.[0];
  const s = (v: string | undefined) => (v === undefined ? "NIL" : quote(v));
  const from = addrList(g("from"));
  return `(${s(g("date"))} ${s(g("subject"))} ${from} ${from} ${addrList(g("reply-to") ?? g("from"))} ${
    addrList(g("to"))
  } ${addrList(g("cc"))} NIL ${s(g("in-reply-to"))} ${s(g("message-id"))})`;
}

const maxUidCache = new WeakMap<FakeFolder, { count: number; max: number }>();

/** Highest UID in a folder; memoized per message count so SEARCH over n messages stays O(n). */
function maxUidOf(folder: FakeFolder): number {
  const hit = maxUidCache.get(folder);
  if (hit && hit.count === folder.messages.length) return hit.max;
  const max = folder.messages.reduce((a, x) => Math.max(a, x.uid), 0);
  maxUidCache.set(folder, { count: folder.messages.length, max });
  return max;
}

function matches(m: FakeMessage, seq: number, folder: FakeFolder, toks: Tok[]): boolean {
  // Consumes tokens left to right; all top-level criteria are ANDed.
  const next = (): boolean => {
    const t = toks.shift();
    if (t === undefined) return true;
    if (Array.isArray(t)) return matches(m, seq, folder, t.slice());
    const u = t.toUpperCase();
    switch (u) {
      case "ALL":
        return true;
      case "OR": {
        const a = next();
        const b = next();
        return a || b;
      }
      case "NOT":
        return !next();
      case "ANSWERED":
        return m.flags.includes("\\Answered");
      case "UNANSWERED":
        return !m.flags.includes("\\Answered");
      case "UNSEEN":
        return !m.flags.includes("\\Seen");
      case "SEEN":
        return m.flags.includes("\\Seen");
      case "UID": {
        const set = String(toks.shift());
        const max = maxUidOf(folder);
        return parseSet(set, max).some(([lo, hi]) => m.uid >= lo && m.uid <= hi);
      }
      case "HEADER": {
        const name = String(toks.shift()).toLowerCase();
        const needle = String(toks.shift()).toLowerCase();
        return (headerMap(m.raw).get(name) ?? []).some((v) => v.toLowerCase().includes(needle));
      }
      default:
        if (/^[\d*:,]+$/.test(t)) {
          return parseSet(t, folder.messages.length).some(([lo, hi]) => seq >= lo && seq <= hi);
        }
        return true;
    }
  };
  let ok = true;
  while (toks.length) ok = next() && ok;
  return ok;
}

/** Generate a throw-away CA and a leaf certificate (127.0.0.1 / localhost) signed by it. */
export async function makeTestCerts(dir: string): Promise<{ cert: string; key: string; ca: string }> {
  const run = async (args: string[]) => {
    const out = await new Deno.Command("openssl", { args, stdout: "null", stderr: "piped", cwd: dir })
      .output();
    if (!out.success) throw new Error(`openssl failed: ${dec.decode(out.stderr)}`);
  };
  await Deno.writeTextFile(
    `${dir}/leaf.ext`,
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n",
  );
  await run([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=slipmail-test-ca",
  ]);
  await run([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "key.pem",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=localhost",
  ]);
  await run([
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "cert.pem",
    "-days",
    "1",
    "-extfile",
    "leaf.ext",
  ]);
  return {
    cert: await Deno.readTextFile(`${dir}/cert.pem`),
    key: await Deno.readTextFile(`${dir}/key.pem`),
    ca: await Deno.readTextFile(`${dir}/ca.pem`),
  };
}
