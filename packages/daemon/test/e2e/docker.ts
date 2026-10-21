/** Minimal Docker Engine API client over the unix socket (enough for the e2e tests). */
import http from "node:http";

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

export async function docker<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: SOCKET,
        method,
        path: `/v1.43${path}`,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: unknown = text;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            /* raw text (logs) */
          }
          resolve({ status: res.statusCode ?? 0, data: data as T });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function mustDocker<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await docker<T>(method, path, body);
  if (r.status >= 300) throw new Error(`docker ${method} ${path} -> ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
}

/** Container logs (stdout+stderr), demultiplexed. */
export async function containerLogs(id: string, tail = 200): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method: "GET", path: `/v1.43/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}` }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let out = "";
        let i = 0;
        while (i + 8 <= buf.length) {
          const len = buf.readUInt32BE(i + 4);
          out += buf.subarray(i + 8, i + 8 + len).toString("utf8");
          i += 8 + len;
        }
        resolve(out || buf.toString("utf8"));
      });
    });
    req.on("error", reject);
    req.end();
  });
}
