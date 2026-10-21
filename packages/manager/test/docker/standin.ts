/** Builds the stand-in desktop image: node:24-alpine running the fake daemon on port 7000. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type Docker from "dockerode";
import tar from "tar-stream";

export const STANDIN_IMAGE = "deskhand-test-desktop:dev";
const BASE = "node:24-alpine";

const DOCKERFILE = `FROM ${BASE}
LABEL owner=deskhand-dev
RUN adduser -D -u 1000 agent 2>/dev/null || true; mkdir -p /home/agent/Downloads && chown -R 1000:1000 /home/agent
COPY fake-daemon.ts /opt/fake-daemon.ts
ENV FAKE_DAEMON_PORT=7000 FAKE_LOCK_WAIT_MS=2000
EXPOSE 7000
CMD ["node", "/opt/fake-daemon.ts"]
`;

export async function imageExists(docker: Docker, name: string): Promise<boolean> {
  try {
    await docker.getImage(name).inspect();
    return true;
  } catch {
    return false;
  }
}

/** Returns the base images that were pulled for the build (for cleanup). */
export async function buildStandin(docker: Docker): Promise<string[]> {
  const pulled: string[] = [];
  if (!(await imageExists(docker, BASE))) pulled.push(BASE);
  const src = fs.readFileSync(fileURLToPath(new URL("../../src/fake-daemon/fake-daemon.ts", import.meta.url)));
  const pack = tar.pack();
  pack.entry({ name: "Dockerfile" }, DOCKERFILE);
  pack.entry({ name: "fake-daemon.ts" }, src);
  pack.finalize();
  const stream = await docker.buildImage(pack as unknown as NodeJS.ReadableStream, { t: STANDIN_IMAGE, labels: { owner: "deskhand-dev" }, rm: true, forcerm: true });
  await new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(stream, (err: Error | null, out: Array<{ error?: string }>) => {
      const failed = out?.find((o) => o.error);
      if (err || failed) reject(err ?? new Error(failed!.error));
      else resolve();
    }),
  );
  return pulled;
}
