// HEALTHCHECK: GET <listen>/<base>/healthz must answer 200 with ok: true.
const listen = process.env.DESKHAND_LISTEN || process.env.DESKHAND_BIND || "0.0.0.0:7480";
const port = /(\d+)$/.exec(listen)?.[1] ?? "7480";
let base = (process.env.DESKHAND_BASE_PATH || "").trim().replace(/\/+$/, "");
if (base && !base.startsWith("/")) base = `/${base}`;
try {
  const res = await fetch(`http://127.0.0.1:${port}${base}/healthz`, { signal: AbortSignal.timeout(4000) });
  const body = await res.json();
  process.exit(res.ok && body.ok ? 0 : 1);
} catch {
  process.exit(1);
}
