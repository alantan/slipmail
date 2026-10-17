# slipmail

A small, security-first **IMAP-only** mail broker for LLM agents.

`slipmail` is a local executable that is the only thing allowed to touch a mailbox. An agent launches it and
calls four operations. The agent never sees the password and the program contains no way to send mail.

- IMAP over implicit TLS only. No SMTP, no sendmail, no STARTTLS downgrade path.
- Written in TypeScript for Deno and compiled with `deno compile`; the **permission flags are baked into the
  binary** and each build is locked to one mail server.
- Four operations, JSON on stdout, nothing else: `list-new`, `fetch`, `handled-check`, `save-draft`.
- There is no delete, move, flag, send or arbitrary-folder operation.

## Operations

All output is a single JSON document on stdout. Success is `{"ok":true,...}`; failure is
`{"ok":false,"error":{"code","message"}}` with exit code 2 (usage) or 1 (anything else). Nothing is written to
stderr.

| Command                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slipmail list-new --after-uid N`                                | Headers (`uid`, `messageId`, `from`, `subject`, `date`) of Inbox messages with UID > N, ascending, plus the Inbox `uidValidity`. Capped at 200 per call. When `truncated` is true, call again with `--after-uid` set to the returned `nextAfterUid` (it always moves forward, even across large gaps in UID numbering).                                                                       |
| `slipmail fetch UID`                                             | Plain-text body (HTML is stripped only if there is no plain part) and allow-listed attachments saved under the scratch directory. Output carries `"untrusted": true`.                                                                                                                                                                                                                         |
| `slipmail handled-check UID [--message-id ID] [--uidvalidity N]` | Is the message answered (`\Answered`), does Sent contain a message whose `In-Reply-To` or `References` matches, or has it left the Inbox? Once a UID has left the Inbox, pass the Message-ID you recorded from `list-new` so Sent and Archive can still be searched.                                                                                                                          |
| `slipmail save-draft --reply-to UID`                             | Reads the reply body from stdin (UTF-8, max 256 KiB). The recipient is computed from the original's `Reply-To`, else `From`; it can never be supplied by the caller. Sets `In-Reply-To` / `References` (refusing, with `headers_too_large`, if the original's headers are too large to read completely, rather than risk a wrong recipient), then `APPEND`s to Drafts with the `\Draft` flag. |

Folders are found through IMAP SPECIAL-USE attributes (`\Sent`, `\Drafts`, `\Archive`, `\All`), then common
names (`Sent`, `Sent Items`, `Drafts`, `Archive`, `All Mail`, ...), then optional build-time overrides
(`FOLDER_SENT`, `FOLDER_DRAFTS`, `FOLDER_ARCHIVE`, which take precedence). Missing Sent or Drafts is a hard
error. A message is "archived" when it is no longer in the Inbox, which covers Gmail-style label removal as
well as moves.

Note: IMAP `N:*` always returns the highest message even when its UID is below `N`, so `list-new` filters by
UID itself.

### Limits

Message size 25 MiB (checked via `RFC822.SIZE` before download), 10 attachments, 10 MiB per attachment, body
truncated at 200,000 characters. Attachments are saved only if the extension is one of
`pdf jpg jpeg png docx xlsx txt csv` **and** the leading bytes match that type; filenames are sanitised to a
safe leaf name, written with `createNew` (never overwriting or following a symlink) into
`SCRATCH_DIR/<uidvalidity>-<uid>/`. Attachments are never executed or opened.

## Threat model

**What slipmail prevents**

- _The password leaking through slipmail._ It is read from the macOS Keychain inside the process, passed only
  to the TLS connection, and never placed in an argument, environment variable, file or log. The `security`
  child process receives no secret on its command line. (This does not stop the agent from querying the
  Keychain itself; see below.)
- _The agent sending mail._ There is no SMTP code in the program or its dependency graph (CI fails if any
  appears), and the binary's network permission is a single `host:port`.
- _Destructive mailbox operations._ The IMAP client has a closed command allow-list
  (`CAPABILITY
  AUTHENTICATE LOGIN LIST EXAMINE UID FETCH UID SEARCH APPEND LOGOUT`). Folders are opened with
  `EXAMINE` (read-only) and fetches use `BODY.PEEK`, so reading does not even mark mail as seen. `STORE`,
  `EXPUNGE`, `COPY`, `MOVE`, `DELETE`, `CREATE`, `RENAME` cannot be sent.
- _Widening the sandbox at runtime._ Permissions are compiled in. No flag, argument or environment variable of
  this program changes them; the arguments it accepts are parsed strictly.
- _Hostile email content_ escaping into the filesystem or a shell. Nothing from a message is interpolated into
  a shell command, a path or an IMAP command without validation (IMAP arguments are restricted to a safe
  character set; header values written into drafts are validated or RFC 2047-encoded); filenames are
  sanitised; sizes and counts are capped.
- _Caller-chosen recipients._ Drafts go only to the original sender's Reply-To/From address.
- _Silent permission creep._ `deno task security-check` reads the permission set embedded in the compiled
  binary and fails unless it is exactly the intended one.

**What it does not prevent**

- _Same OS user._ The agent runs as you. If the binary is writable by you it can be replaced, and anything
  running as you can ask the Keychain for the item through `/usr/bin/security` (see [Install](#install)). A
  root-owned binary stops tampering with slipmail, not the agent reading the Keychain item directly; that
  needs a separate OS account.
- _The password may work elsewhere._ An IMAP password is often also an SMTP password or an account password.
  Anyone who obtains it by other means can send mail with it. Prefer an app-specific password where the
  provider supports one.
- _Prompt injection._ Email is hostile input. slipmail labels fetched content `untrusted` and caps it; it
  cannot stop an agent from being manipulated by what it reads. A draft is saved, never sent, but its
  recipient is derived from attacker-controlled `Reply-To`, so **a human must review drafts before sending**.
- _A compromised provider or TLS trust._ The certificate chain is verified against the system trust store.
  Deno's runtime honours its own TLS-related environment variables (for example `DENO_CERT`); baking more
  permissions in does not remove them, so treat the launching environment as trusted.
- _Data the agent is allowed to read._ Everything in the Inbox is readable by the agent through `fetch`;
  attachments land on disk in the scratch directory as you.
- _OAuth2._ Out of scope. Providers that require it must accept an app password.

## Build

Requires [Deno](https://deno.com) 2.x. The provider is chosen **at build time**:

```sh
IMAP_HOST=imap.example.test \
IMAP_PORT=993 \
MAILBOX_ADDRESS=me@example.test \
SCRATCH_DIR=/var/tmp/slipmail \
deno task build            # -> dist/slipmail
deno task security-check   # verifies the baked permissions and dependency graph
```

Baked permissions: `--allow-net=$IMAP_HOST:$IMAP_PORT`, `--allow-run=/usr/bin/security` (an absolute path so a
modified `PATH` cannot substitute another program), `--allow-read` and `--allow-write` on `$SCRATCH_DIR` only,
`--allow-import` pinned to the same endpoint, and prompts disabled. `SCRATCH_DIR` must be an absolute path
made of `[A-Za-z0-9._/+@-]` and must exist before first use.

## Credentials

Store the password yourself, in a Keychain item with service `slipmail` and account equal to
`MAILBOX_ADDRESS`. For example, from an interactive terminal (this prompts, so the password is never in your
shell history):

```sh
security add-generic-password -s slipmail -a me@example.test -w
```

The lookup lives behind the small `SecretStore` interface in `src/secrets.ts`; other stores can be added
without touching the rest.

## Setup for a generic provider

You need: the IMAP host, port (usually 993, implicit TLS), the full mailbox address, and a password or app
password. Build with those values, store the Keychain item, then run `slipmail list-new
--after-uid 0`. If
Sent or Drafts cannot be found you will get a `folders` error naming what is missing; set `FOLDER_SENT` /
`FOLDER_DRAFTS` at build time to the exact server-side folder names.

Provider examples (values only; confirm them against your provider's current documentation, and check what
kind of password it requires):

|                   | Provider A                           | Provider B                           |
| ----------------- | ------------------------------------ | ------------------------------------ |
| `IMAP_HOST`       | `imap.gmail.com`                     | `imap.fastmail.com`                  |
| `IMAP_PORT`       | `993`                                | `993`                                |
| `MAILBOX_ADDRESS` | your full address                    | your full address                    |
| Password          | an app password in the Keychain item | an app password in the Keychain item |

## Install

Build, then install the binary somewhere your own user cannot modify. A root-owned file is **not** enough on
its own: anyone who can write to a parent directory can unlink the file and put another one in its place. So
install under a root-owned directory tree and check every ancestor:

```sh
dest=/usr/local/libexec/slipmail
sudo install -d -o root -g wheel -m 0755 "$(dirname "$dest")"
sudo install -o root -g wheel -m 0755 dist/slipmail "$dest"

# Every component from the file up to / must be owned by root and not group- or world-writable.
p=$dest; while :; do stat -f '%Su %Sp %N' "$p"; [ "$p" = / ] && break; p=$(dirname "$p"); done
```

Each line must start with `root` and show no `w` in the group or other positions (for example
`root -rwxr-xr-x ...` or `root drwxr-xr-x ...`). If `/usr/local` or any other ancestor fails the check (some
Homebrew setups make `/usr/local` user-owned), choose a location whose ancestors all pass instead of relaxing
the check.

Keychain access list: the program reads the item by running `/usr/bin/security`, so macOS sees `security` (not
slipmail) as the requesting application. An item you create with `security add-generic-password` already
trusts `security`, and the access list cannot tell _which program asked `security`_. Be clear about what that
means: the root-owned binary protects against **tampering with slipmail**, but any process running as your
user can run `/usr/bin/security find-generic-password -s slipmail -a ADDRESS -w` itself and may be allowed to
read the item. If you need the agent to be unable to read the password, run the broker under a separate OS
account (or add a store that does not go through a user-invocable tool); this repository does not claim to
provide that boundary today.

## Development

```sh
deno task lint
deno task check
deno task test            # uses an in-process fake IMAP-over-TLS server; no network, no real mailbox
```

Tests use only `example.com` / `example.test`. See [docs/SPIKE.md](docs/SPIKE.md) for why this uses a small
in-house IMAP client instead of `imapflow`.

## Licence

MIT
