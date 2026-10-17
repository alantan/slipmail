import { type BrokerConfig, DEFAULT_LIMITS } from "../../src/config.ts";
import type { SecretStore } from "../../src/secrets.ts";
import { openSession, type Session } from "../../src/session.ts";
import { type Harness, PASSWORD, USER } from "./harness.ts";

export class FakeSecrets implements SecretStore {
  calls: string[] = [];
  constructor(private password: string | null = PASSWORD) {}
  getPassword(account: string): Promise<string> {
    this.calls.push(account);
    if (this.password === null) return Promise.reject(new Error("no secret"));
    return Promise.resolve(this.password);
  }
}

export interface TestCtx {
  config: BrokerConfig;
  scratch: string;
  secrets: FakeSecrets;
  open(): Promise<Session>;
  cleanup(): Promise<void>;
}

/** Config pointing at the fake server, with a fresh temp scratch dir. Limits can be overridden. */
export async function makeCtx(h: Harness, limits: Partial<BrokerConfig["limits"]> = {}): Promise<TestCtx> {
  const scratch = await Deno.makeTempDir({ prefix: "slipmail-scratch-" });
  const config: BrokerConfig = {
    host: "127.0.0.1",
    port: h.server.port,
    mailbox: USER,
    scratchDir: scratch,
    limits: { ...DEFAULT_LIMITS, ...limits },
    ca: h.ca,
  };
  const secrets = new FakeSecrets();
  return {
    config,
    scratch,
    secrets,
    open: () => openSession(config, secrets),
    cleanup: () => Deno.remove(scratch, { recursive: true }),
  };
}
