// CI gate. Fails if the compiled binary, its dependency graph or the source references mail-sending
// code, or if the permissions baked into the binary are anything other than the intended set.
//
// Run after `deno task build`. Reads dist/build-manifest.json and the binary it names.

const BANNED_PACKAGE = /(nodemailer|smtp|sendmail|mailer|lettre|emailjs)/i;
const ALLOWED_NPM = new Set(["postal-mime"]);
// Byte patterns that only appear in code that speaks SMTP or shells out to sendmail.
const BINARY_MARKERS = [
  /RCPT TO/i,
  /MAIL FROM:/i,
  /smtp-connection/i,
  /nodemailer/i,
  /sendmail/i,
  /\bEHLO\b/,
];
const SOURCE_BANNED = /\b(smtp|sendmail|nodemailer)\b/i;

export interface Manifest {
  out: string;
  host: string;
  port: number;
  scratchDir: string;
}

export function extractMetadata(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder("latin1").decode(bytes);
  const start = text.indexOf('{"argv":');
  if (start < 0) throw new Error("embedded runtime metadata not found in binary");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("embedded runtime metadata is truncated");
}

/** Returns a list of violations; empty means the baked permissions are exactly the intended set. */
export function checkPermissions(meta: Record<string, unknown>, m: Manifest): string[] {
  const perms = (meta.permissions ?? {}) as Record<string, unknown>;
  const errs: string[] = [];
  const same = (k: string, want: string[]) => {
    if (JSON.stringify(perms[k]) !== JSON.stringify(want)) {
      errs.push(`permission ${k} is ${JSON.stringify(perms[k])}, expected ${JSON.stringify(want)}`);
    }
  };
  const endpoint = `${m.host}:${m.port}`;
  same("allow_net", [endpoint]);
  same("allow_import", [endpoint]);
  same("allow_run", ["/usr/bin/security"]);
  same("allow_read", [m.scratchDir]);
  same("allow_write", [m.scratchDir]);
  for (const k of ["allow_env", "allow_ffi", "allow_sys"]) {
    if (perms[k] !== null) errs.push(`permission ${k} must be unset`);
  }
  for (const k of Object.keys(perms)) {
    if (k.startsWith("deny_") || k.startsWith("ignore_")) continue;
    if (
      ![
        "allow_net",
        "allow_import",
        "allow_run",
        "allow_read",
        "allow_write",
        "allow_env",
        "allow_ffi",
        "allow_sys",
        "prompt",
      ].includes(k)
    ) {
      errs.push(`unexpected permission field ${k}`);
    }
  }
  if (perms.prompt !== false) errs.push("permission prompting must be disabled");
  if (meta.unsafely_ignore_certificate_errors != null) errs.push("certificate errors must not be ignored");
  if (meta.ca_data != null || meta.ca_stores != null) {
    errs.push("custom CA configuration must not be baked in");
  }
  return errs;
}

export function checkGraph(
  info: { modules?: Array<{ specifier: string }>; npmPackages?: Record<string, unknown> },
): string[] {
  const errs: string[] = [];
  for (const mod of info.modules ?? []) {
    if (BANNED_PACKAGE.test(mod.specifier)) errs.push(`banned module in graph: ${mod.specifier}`);
    if (/^https?:/.test(mod.specifier) && !/^https:\/\/jsr\.io\/@std\//.test(mod.specifier)) {
      errs.push(`unexpected remote module: ${mod.specifier}`);
    }
  }
  for (const id of Object.keys(info.npmPackages ?? {})) {
    const name = id.replace(/@[^@/]+$/, "");
    if (BANNED_PACKAGE.test(name)) errs.push(`banned npm package: ${id}`);
    if (!ALLOWED_NPM.has(name)) errs.push(`npm package not on the allow-list: ${id}`);
  }
  return errs;
}

export function checkBinaryStrings(bytes: Uint8Array): string[] {
  const text = new TextDecoder("latin1").decode(bytes);
  return BINARY_MARKERS.filter((re) => re.test(text)).map((re) =>
    `binary contains mail-sending marker ${re}`
  );
}

// Which source files may use which sensitive primitive.
const PRIMITIVES: Array<[RegExp, string, string[]]> = [
  [/Deno\.(connect|connectTls|listen|listenTls|startTls)\b/, "raw sockets", ["src/imap/client.ts"]],
  [/Deno\.Command\b|Deno\.run\b/, "subprocess", ["src/secrets.ts"]],
  [/\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/, "HTTP/WebSocket", []],
  [/\bimport\s*\(/, "dynamic import", []],
  [/\beval\s*\(|new Function\s*\(/, "eval", []],
];

export async function checkSources(root: string): Promise<string[]> {
  const errs: string[] = [];
  const files: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  await walk(`${root}/src`);
  files.push(`${root}/dist/entry.ts`);
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    const text = await Deno.readTextFile(f);
    if (SOURCE_BANNED.test(text)) errs.push(`${rel}: mentions mail-sending code`);
    for (const [re, label, allowed] of PRIMITIVES) {
      if (re.test(text) && !allowed.includes(rel)) {
        errs.push(`${rel}: uses ${label}, which is not allowed here`);
      }
    }
  }
  return errs;
}

if (import.meta.main) {
  const manifest: Manifest = JSON.parse(await Deno.readTextFile("dist/build-manifest.json"));
  const bytes = await Deno.readFile(manifest.out);
  const info = JSON.parse(
    new TextDecoder().decode(
      (await new Deno.Command("deno", {
        args: ["info", "--json", "--config", "deno.json", "dist/entry.ts"],
        stdout: "piped",
        stderr: "null",
      }).output()).stdout,
    ),
  );
  const errs = [
    ...checkPermissions(extractMetadata(bytes), manifest),
    ...checkGraph(info),
    ...checkBinaryStrings(bytes),
    ...await checkSources("."),
  ];
  if (errs.length) {
    console.error("SECURITY CHECK FAILED:\n - " + errs.join("\n - "));
    Deno.exit(1);
  }
  console.log(`security check passed for ${manifest.out} (${manifest.host}:${manifest.port})`);
}
