// Secret lookup behind a small interface so other stores (libsecret, ...) can be added
// without touching anything else. The secret is returned to the caller in memory only: it is
// never placed in an argument, environment variable, file or log line.

export interface SecretStore {
  getPassword(account: string): Promise<string>;
}

export class SecretError extends Error {}

export interface RunResult {
  code: number;
  stdout: string;
}
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

const defaultRunner: Runner = async (cmd, args) => {
  const out = await new Deno.Command(cmd, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "null", // never surface tool diagnostics
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin" },
  }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
};

export class KeychainStore implements SecretStore {
  constructor(
    private service = "slipmail",
    private securityBin = "/usr/bin/security",
    private run: Runner = defaultRunner,
  ) {}

  async getPassword(account: string): Promise<string> {
    // Arguments are passed as an argv array (no shell). Refuse values that could be read as options.
    // deno-lint-ignore no-control-regex
    if (!account || account.startsWith("-") || /[\u0000\r\n]/.test(account)) {
      throw new SecretError("invalid mailbox address for keychain lookup");
    }
    let res: RunResult;
    try {
      res = await this.run(this.securityBin, [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        account,
        "-w",
      ]);
    } catch {
      throw new SecretError("could not run the macOS security tool");
    }
    if (res.code !== 0) {
      throw new SecretError(
        `keychain item not found or access denied (service "${this.service}", account "${account}")`,
      );
    }
    const pw = res.stdout.replace(/\r?\n$/, "");
    if (!pw) throw new SecretError("keychain item is empty");
    return pw;
  }
}
