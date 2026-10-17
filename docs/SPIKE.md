# Spike: IMAP library under Deno with baked permissions

Question: can `npm:imapflow` run in a `deno compile` binary that carries only `--allow-net=HOST:PORT`,
`--allow-run=security` and read/write on one scratch directory?

Tested with Deno 2.9.7, imapflow 1.0.198, against a local fake IMAP-over-TLS server
(`tests/support/fake_imap.ts`).

## Result: no, not with the permissions as specified

1. Importing imapflow (even with `logger: false`) loads `pino` and `thread-stream`, which read
   `process.env.NODE_V8_COVERAGE` at import time -> `NotCapable: Requires env access`.
2. Allowing that one variable is not enough: `pino` then calls `os.hostname()` ->
   `NotCapable: Requires sys access to "hostname"`.
3. It only gets past import with the blanket `--allow-env --allow-sys`, which the brief forbids ("no other
   permissions").
4. Its dependency list contains `nodemailer` (used for address/MIME helpers; it also ships SMTP and sendmail
   transports) plus about 25 other packages including `socks`. That makes a meaningful "no SMTP/sendmail code"
   check awkward and enlarges the audit surface.

## Decision: minimal in-house IMAP client

`src/imap/` is a small client over `Deno.connectTls` that needs only the net permission. It has a single send
choke point with a command allow-list
(`CAPABILITY ID LOGIN LIST SELECT EXAMINE
UID FETCH UID SEARCH APPEND LOGOUT`) so
STORE/EXPUNGE/COPY/MOVE/DELETE cannot be issued even by a bug elsewhere. MIME parsing uses `npm:postal-mime`
(pure JS; verified to need no permissions).
