import { assertEquals } from "@std/assert";
import { PASSWORD, rfc822, standardFolders, startHarness, USER } from "./support/harness.ts";

Deno.test("smoke: connect, login, list, examine, fetch", async () => {
  const msg = rfc822({
    From: "Alice <alice@example.com>",
    Subject: "Hello",
    "Message-ID": "<a1@example.com>",
  }, "Hi\n");
  const h = await startHarness(standardFolders([{ raw: msg }]));
  try {
    const c = await h.connect();
    await c.login(USER, PASSWORD);
    const boxes = await c.list();
    assertEquals(boxes.find((b) => b.name === "Sent Items")?.attrs.includes("\\Sent"), true);
    const info = await c.examine("INBOX");
    assertEquals(info.exists, 1);
    const r = await c.uidFetch("1:*", { flags: true, size: true, headerFields: ["From", "Subject"] });
    assertEquals(r.length, 1);
    assertEquals(new TextDecoder().decode(r[0].header).includes("Subject: Hello"), true);
    const s = await c.uidFetch("1", { source: true });
    assertEquals(new TextDecoder().decode(s[0].source), msg);
    await c.logout();
  } finally {
    await h.close();
  }
});
