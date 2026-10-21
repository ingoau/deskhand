import http from "node:http";

/** Removes every desktop and e2e template the run left behind, then (docker) the run's network. */
export default async function globalTeardown() {
  const url = process.env.E2E_URL!;
  const headers = { authorization: `Bearer ${process.env.E2E_ADMIN_TOKEN}` };
  try {
    const { desktops } = (await (await fetch(`${url}/api/desktops`, { headers })).json()) as { desktops: Array<{ id: string }> };
    await Promise.all(desktops.map((d) => fetch(`${url}/api/desktops/${d.id}`, { method: "DELETE", headers }).catch(() => undefined)));
    const { templates } = (await (await fetch(`${url}/api/templates`, { headers })).json()) as { templates: Array<{ name: string }> };
    for (const t of templates.filter((t) => t.name.startsWith("e2e-"))) await fetch(`${url}/api/templates/${t.name}`, { method: "DELETE", headers }).catch(() => undefined);
  } catch (e) {
    console.warn("teardown: could not clean up through the manager:", (e as Error).message);
  }
  if (process.env.E2E_RUNTIME === "docker" && process.env.E2E_NETWORK) {
    // Containers may still be detaching; retry for a while (403/409 = active endpoints).
    let status = 0;
    for (let i = 0; i < 30; i++) {
      status = await dockerRequest("DELETE", `/networks/${process.env.E2E_NETWORK}`).catch(() => -1);
      if (status === 204 || status === 404) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (status !== 204 && status !== 404) console.warn(`teardown: could not remove network ${process.env.E2E_NETWORK} (${status})`);
  }
}

function dockerRequest(method: string, p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: "/var/run/docker.sock", method, path: p }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}
