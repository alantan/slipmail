// Low-level IMAP response reading and parsing (RFC 3501 subset).
//
// Server bytes are treated as hostile: every literal is size-capped, nesting depth is
// bounded, and nothing is ever evaluated or interpolated into a shell or a path.

export type Node = null | string | Uint8Array | Node[];

export class ProtocolError extends Error {}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: false });

/** Line bytes are decoded byte-for-byte; convert back to a real UTF-8 string for values. */
export function fromWire(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return utf8.decode(bytes);
}

export function nodeStr(n: Node | undefined): string | null {
  if (n === null || n === undefined) return null;
  if (typeof n === "string") return n;
  if (n instanceof Uint8Array) return utf8.decode(n);
  return null;
}

export function nodeList(n: Node | undefined): Node[] {
  return Array.isArray(n) ? n : [];
}

/** Buffered byte reader over a Deno connection. */
export class WireReader {
  private buf = new Uint8Array(0);

  constructor(
    private conn: { read(p: Uint8Array): Promise<number | null> },
    private timeoutMs: number,
  ) {}

  private async fill(): Promise<void> {
    const chunk = new Uint8Array(65536);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new ProtocolError("timed out waiting for server")), this.timeoutMs);
    });
    let n: number | null;
    try {
      n = await Promise.race([this.conn.read(chunk), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (n === null) throw new ProtocolError("connection closed by server");
    const merged = new Uint8Array(this.buf.length + n);
    merged.set(this.buf);
    merged.set(chunk.subarray(0, n), this.buf.length);
    this.buf = merged;
  }

  /** Reads one CRLF-terminated line (without the CRLF), capped at maxLine bytes. */
  async readLine(maxLine = 1 << 20): Promise<string> {
    let scanned = 0;
    for (;;) {
      for (let i = scanned; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = latin1.decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 2);
          return line;
        }
      }
      scanned = Math.max(0, this.buf.length - 1);
      if (this.buf.length > maxLine) throw new ProtocolError("server line too long");
      await this.fill();
    }
  }

  async readExact(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

/**
 * Parses one untagged response body (everything after "* ") into nodes. Literals ({n} at end
 * of line) are pulled from the reader as they are encountered.
 */
export class ResponseParser {
  private line: string;
  private pos = 0;

  constructor(
    firstLine: string,
    private reader: WireReader,
    private maxLiteral: number,
  ) {
    this.line = firstLine;
  }

  atEnd(): boolean {
    return this.pos >= this.line.length;
  }

  rest(): string {
    return fromWire(this.line.slice(this.pos));
  }

  skipSpaces() {
    while (this.line[this.pos] === " ") this.pos++;
  }

  peek(): string | undefined {
    return this.line[this.pos];
  }

  /** Reads a bare word up to a space / paren / end. */
  atomRaw(): string {
    this.skipSpaces();
    let v = "";
    let depth = 0;
    while (this.pos < this.line.length) {
      const ch = this.line[this.pos];
      if (ch === "[") depth++;
      if (ch === "]") depth--;
      if (depth <= 0 && (ch === " " || ch === "(" || ch === ")")) break;
      v += ch;
      this.pos++;
    }
    return v;
  }

  async value(depth = 0): Promise<Node> {
    if (depth > 16) throw new ProtocolError("response nesting too deep");
    this.skipSpaces();
    const c = this.line[this.pos];
    if (c === undefined) throw new ProtocolError("unexpected end of response");
    if (c === "(") {
      this.pos++;
      const items: Node[] = [];
      for (;;) {
        this.skipSpaces();
        if (this.line[this.pos] === ")") {
          this.pos++;
          return items;
        }
        if (this.atEnd()) throw new ProtocolError("unterminated list in response");
        items.push(await this.value(depth + 1));
      }
    }
    if (c === '"') {
      this.pos++;
      let v = "";
      while (this.pos < this.line.length && this.line[this.pos] !== '"') {
        if (this.line[this.pos] === "\\") this.pos++;
        v += this.line[this.pos++];
      }
      if (this.line[this.pos] !== '"') throw new ProtocolError("unterminated quoted string");
      this.pos++;
      return fromWire(v);
    }
    if (c === "{") {
      const m = this.line.slice(this.pos).match(/^\{(\d+)\+?\}$/);
      if (!m) throw new ProtocolError("malformed literal marker");
      const size = Number(m[1]);
      if (size > this.maxLiteral) throw new ProtocolError(`literal of ${size} bytes exceeds cap`);
      const data = await this.reader.readExact(size);
      this.line = await this.reader.readLine();
      this.pos = 0;
      return data;
    }
    const a = this.atomRaw();
    if (a === "") throw new ProtocolError("unexpected character in response");
    return a.toUpperCase() === "NIL" ? null : fromWire(a);
  }
}

/** Quote a value for use as an IMAP quoted string. Rejects anything that is not safe. */
export function quoteString(s: string): string {
  // deno-lint-ignore no-control-regex
  if (/[\u0000\r\n]/.test(s)) throw new ProtocolError("control character in IMAP argument");
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 126) throw new ProtocolError("non-ASCII IMAP argument must use a literal");
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
