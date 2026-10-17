import type { BrokerConfig } from "./config.ts";
import { discoverFolders, type Folders } from "./folders.ts";
import { ImapClient } from "./imap/client.ts";
import type { SecretStore } from "./secrets.ts";

export interface Session {
  client: ImapClient;
  folders: Folders;
  config: BrokerConfig;
}

export class OpError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function openSession(config: BrokerConfig, secrets: SecretStore): Promise<Session> {
  const password = await secrets.getPassword(config.mailbox);
  const client = await ImapClient.connect({ host: config.host, port: config.port, ca: config.ca });
  try {
    await client.login(config.mailbox, password);
    const folders = discoverFolders(await client.list(), config.folderOverrides);
    return { client, folders, config };
  } catch (e) {
    await client.logout();
    throw e;
  }
}

export function parseUid(s: string | undefined): number {
  if (!s || !/^[1-9]\d{0,9}$/.test(s) || Number(s) > 0xffffffff) {
    throw new OpError("usage", "UID must be a positive integer");
  }
  return Number(s);
}
