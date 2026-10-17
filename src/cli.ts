// Command-line front end. Contract: exactly one JSON document on stdout, nothing on stderr.
// Success is {"ok":true,...}; failure is {"ok":false,"error":{code,message}} with a non-zero exit code.

import type { BrokerConfig } from "./config.ts";
import { ImapCommandError, ProtocolError } from "./imap/client.ts";
import { fetchMessage } from "./ops/fetch.ts";
import { handledCheck } from "./ops/handled_check.ts";
import { listNew } from "./ops/list_new.ts";
import { saveDraft } from "./ops/save_draft.ts";
import { FolderError } from "./folders.ts";
import { SecretError, type SecretStore } from "./secrets.ts";
import { openSession, OpError, parseUid } from "./session.ts";

export interface CliDeps {
  secrets: SecretStore;
  readStdin: (maxBytes: number) => Promise<Uint8Array>;
  write: (json: string) => void;
}

const USAGE = "usage: slipmail list-new --after-uid N | fetch UID | " +
  "handled-check UID [--message-id ID] [--uidvalidity N] | save-draft --reply-to UID (body on stdin)";

/** Strict flag parser: only the named flags, each taking exactly one value. */
function parseArgs(args: string[], flags: string[]): { pos: string[]; flags: Map<string, string> } {
  const pos: string[] = [];
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (!flags.includes(a) || out.has(a)) {
        throw new OpError("usage", `unknown or repeated flag ${a.slice(0, 40)}`);
      }
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new OpError("usage", `${a} needs a value`);
      out.set(a, v);
    } else pos.push(a);
  }
  return { pos, flags: out };
}

export async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of stream) {
    total += c.length;
    if (total > maxBytes) throw new OpError("too_large", `stdin exceeds ${maxBytes} bytes`);
    chunks.push(c);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function run(argv: string[], config: BrokerConfig, deps: CliDeps): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    let result: unknown;
    switch (cmd) {
      case "list-new": {
        const p = parseArgs(rest, ["--after-uid"]);
        const v = p.flags.get("--after-uid");
        if (p.pos.length || v === undefined || !/^\d{1,10}$/.test(v) || Number(v) > 0xffffffff) {
          throw new OpError("usage", "list-new requires --after-uid N (0 or greater)");
        }
        const s = await openSession(config, deps.secrets);
        try {
          result = await listNew(s, Number(v));
        } finally {
          await s.client.logout();
        }
        break;
      }
      case "fetch": {
        const p = parseArgs(rest, []);
        if (p.pos.length !== 1) throw new OpError("usage", "fetch requires exactly one UID");
        const uid = parseUid(p.pos[0]);
        const s = await openSession(config, deps.secrets);
        try {
          result = await fetchMessage(s, uid);
        } finally {
          await s.client.logout();
        }
        break;
      }
      case "handled-check": {
        const p = parseArgs(rest, ["--message-id", "--uidvalidity"]);
        if (p.pos.length !== 1) throw new OpError("usage", "handled-check requires exactly one UID");
        const uid = parseUid(p.pos[0]);
        const uv = p.flags.get("--uidvalidity");
        if (uv !== undefined && !/^\d{1,10}$/.test(uv)) throw new OpError("usage", "invalid --uidvalidity");
        const s = await openSession(config, deps.secrets);
        try {
          result = await handledCheck(s, uid, {
            messageId: p.flags.get("--message-id"),
            uidValidity: uv === undefined ? undefined : Number(uv),
          });
        } finally {
          await s.client.logout();
        }
        break;
      }
      case "save-draft": {
        const p = parseArgs(rest, ["--reply-to"]);
        if (p.pos.length) throw new OpError("usage", "save-draft takes only --reply-to UID");
        const uid = parseUid(p.flags.get("--reply-to"));
        const bytes = await deps.readStdin(config.limits.maxDraftBytes);
        let body: string;
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new OpError("usage", "draft body must be valid UTF-8");
        }
        const s = await openSession(config, deps.secrets);
        try {
          result = await saveDraft(s, uid, body);
        } finally {
          await s.client.logout();
        }
        break;
      }
      default:
        throw new OpError("usage", USAGE);
    }
    deps.write(JSON.stringify({ ok: true, ...(result as object) }));
    return 0;
  } catch (e) {
    const { code, message, exit } = describe(e);
    deps.write(JSON.stringify({ ok: false, error: { code, message } }));
    return exit;
  }
}

function describe(e: unknown): { code: string; message: string; exit: number } {
  if (e instanceof OpError) return { code: e.code, message: e.message, exit: e.code === "usage" ? 2 : 1 };
  if (e instanceof SecretError) return { code: "credentials", message: e.message, exit: 1 };
  if (e instanceof FolderError) return { code: "folders", message: e.message, exit: 1 };
  if (e instanceof ImapCommandError) return { code: "imap", message: e.message, exit: 1 };
  if (e instanceof ProtocolError) return { code: "protocol", message: e.message, exit: 1 };
  // Unknown errors: do not echo arbitrary text (could carry untrusted content).
  return { code: "internal", message: e instanceof Error ? e.name : "unexpected failure", exit: 1 };
}
