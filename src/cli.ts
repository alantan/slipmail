// Command-line front end. Contract: exactly one JSON document on stdout, nothing on stderr.
// Success is {"ok":true,...}; failure is {"ok":false,"error":{code,message}} with a non-zero exit code.

import type { BrokerConfig } from "./config.ts";
import { ImapCommandError, ProtocolError } from "./imap/client.ts";
import { fetchMessage } from "./ops/fetch.ts";
import { handledCheck } from "./ops/handled_check.ts";
import { listNew } from "./ops/list_new.ts";
import {
  parseBatch,
  saveDraft,
  saveNewDraft,
  saveNewDrafts,
  validateDraftBody,
  validateNewDraft,
} from "./ops/save_draft.ts";
import { FolderError } from "./folders.ts";
import { validMessageId } from "./headers.ts";
import { SecretError, type SecretStore } from "./secrets.ts";
import { openSession, OpError, parseUid } from "./session.ts";

export interface CliDeps {
  secrets: SecretStore;
  readStdin: (maxBytes: number) => Promise<Uint8Array>;
  /** Reads a --batch file; the binary can only read under its scratch directory. */
  readFile: (path: string, maxBytes: number) => Promise<Uint8Array>;
  write: (json: string) => void;
}

const USAGE = "usage: slipmail list-new --after-uid N | fetch UID | " +
  "handled-check UID [--message-id ID] [--uidvalidity N] | save-draft --reply-to UID (body on stdin) | " +
  "save-draft --to ADDRESS --subject TEXT (body on stdin) | save-draft --batch FILE";

const MAX_BATCH_FILE_BYTES = 4 * 1024 * 1024;

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OpError("usage", `${what} must be valid UTF-8`);
  }
}

/** Batch files must sit inside the scratch directory (nested subpaths are allowed), the only place the binary may read. */
function checkBatchPath(path: string, scratchDir: string): void {
  const base = scratchDir.replace(/\/+$/, "");
  const rel = path.startsWith(base + "/") ? path.slice(base.length + 1) : null;
  if (rel === null || rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new OpError("usage", `--batch FILE must be an absolute path inside ${scratchDir}`);
  }
}

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

export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  what = "stdin",
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of stream) {
    total += c.length;
    if (total > maxBytes) throw new OpError("too_large", `${what} exceeds ${maxBytes} bytes`);
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
        if (uv !== undefined && (!/^[1-9]\d{0,9}$/.test(uv) || Number(uv) > 0xffffffff)) {
          throw new OpError("usage", "invalid --uidvalidity");
        }
        const mid = p.flags.get("--message-id");
        if (mid !== undefined && !validMessageId(mid)) throw new OpError("usage", "invalid --message-id");
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
        const p = parseArgs(rest, ["--reply-to", "--to", "--subject", "--batch"]);
        const f = p.flags;
        if (p.pos.length) throw new OpError("usage", "save-draft takes no positional arguments");
        const replyTo = f.get("--reply-to");
        const batch = f.get("--batch");
        if (batch !== undefined) {
          if (f.size !== 1) throw new OpError("usage", "--batch cannot be combined with other flags");
          checkBatchPath(batch, config.scratchDir);
          let bytes: Uint8Array;
          try {
            bytes = await deps.readFile(batch, MAX_BATCH_FILE_BYTES);
          } catch (e) {
            // Missing or unreadable file is a usage error; OpErrors (e.g. too_large) keep their code.
            if (e instanceof OpError) throw e;
            throw new OpError("usage", "cannot read batch file");
          }
          const specs = parseBatch(decodeUtf8(bytes, "batch file"), config.limits.maxDraftBytes);
          const s = await openSession(config, deps.secrets);
          try {
            result = await saveNewDrafts(s, specs);
          } finally {
            await s.client.logout();
          }
        } else if (replyTo !== undefined) {
          if (f.size !== 1) throw new OpError("usage", "--reply-to cannot be combined with other flags");
          const uid = parseUid(replyTo);
          const body = decodeUtf8(await deps.readStdin(config.limits.maxDraftBytes), "draft body");
          validateDraftBody(body);
          const s = await openSession(config, deps.secrets);
          try {
            result = await saveDraft(s, uid, body);
          } finally {
            await s.client.logout();
          }
        } else {
          const to = f.get("--to");
          const subject = f.get("--subject");
          if (to === undefined || subject === undefined || f.size !== 2) {
            throw new OpError(
              "usage",
              "save-draft requires --reply-to UID, --to ADDRESS --subject TEXT, or --batch FILE",
            );
          }
          const body = decodeUtf8(await deps.readStdin(config.limits.maxDraftBytes), "draft body");
          validateNewDraft(to, subject, body);
          const s = await openSession(config, deps.secrets);
          try {
            result = { saved: true, folder: "drafts", ...await saveNewDraft(s, to, subject, body) };
          } finally {
            await s.client.logout();
          }
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
