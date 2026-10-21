import fs from "node:fs";
import path from "node:path";

/** Reads the manager's admin credential and creates the API token the test "agent" uses. */
export default async function globalSetup() {
  const dataDir = process.env.E2E_DATA_DIR!;
  const file = path.join(dataDir, "admin.json");
  const end = Date.now() + 30_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`manager did not write ${file}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const admin = JSON.parse(fs.readFileSync(file, "utf8")) as { url: string; token: string };
  process.env.E2E_ADMIN_TOKEN = admin.token;
  const res = await fetch(`${process.env.E2E_URL}/api/tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "e2e-agent" }),
  });
  if (res.status !== 201) throw new Error(`could not create the agent token: ${res.status} ${await res.text()}`);
  process.env.E2E_AGENT_TOKEN = ((await res.json()) as { secret: string }).secret;
}
