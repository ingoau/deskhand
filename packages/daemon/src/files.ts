/**
 * File transfer into and out of the desktop, performed as the agent user (so permissions are the
 * agent's, new files are owned by the agent, and root-only files such as the daemon key stay
 * unreadable).
 */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { DeskhandError } from "@deskhand/shared";
import { agentUser, sessionEnv } from "./session.js";

function checkPath(path: string | undefined | null): string {
  if (!path || !path.startsWith("/")) throw new DeskhandError("invalid_argument", `path must be an absolute path inside the desktop; got "${path ?? ""}".`);
  if (path.includes("\0")) throw new DeskhandError("invalid_argument", "path contains a NUL byte.");
  return path;
}

function asAgent() {
  const isRoot = process.getuid?.() === 0;
  const u = agentUser();
  return isRoot ? { uid: u.uid, gid: u.gid } : {};
}

function fileError(stderr: string, path: string): DeskhandError {
  const s = stderr.trim();
  if (/No such file|cannot stat/i.test(s)) return new DeskhandError("invalid_argument", `No such file in the desktop: ${path}`);
  if (/Is a directory/i.test(s)) return new DeskhandError("invalid_argument", `${path} is a directory, not a file.`);
  if (/Permission denied/i.test(s)) return new DeskhandError("forbidden", `The agent user may not access ${path}.`);
  if (/Read-only file system/i.test(s)) return new DeskhandError("forbidden", `${path} is on a read-only mount.`);
  if (/No space left/i.test(s)) return new DeskhandError("disk_full", `The desktop is out of disk space writing ${path}.`);
  return new DeskhandError("internal", `File operation on ${path} failed: ${s.slice(0, 300)}`);
}

/** Size of a regular file (as the agent), or a DeskhandError. */
export function statFile(path: string): Promise<number> {
  checkPath(path);
  return new Promise((resolve, reject) => {
    // Check readability too: the response headers go out before the bytes, so a file we can stat
    // but not read must fail here, not halfway through the response.
    const script = '[ -e "$1" ] || { echo "No such file" >&2; exit 1; }; [ -r "$1" ] || { echo "Permission denied" >&2; exit 1; }; exec stat -L -c "%F|%s" -- "$1"';
    const p = spawn("/bin/bash", ["-c", script, "deskhand-stat", path], { ...asAgent(), stdio: ["ignore", "pipe", "pipe"], env: sessionEnv() });
    let out = "";
    let err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", (e) => reject(new DeskhandError("internal", e.message)));
    p.on("close", (code) => {
      if (code !== 0) return reject(fileError(err, path));
      const [type, size] = out.trim().split("|");
      if (type !== "regular file" && type !== "regular empty file") return reject(new DeskhandError("invalid_argument", `${path} is a ${type}, not a regular file.`));
      resolve(Number(size));
    });
  });
}

/** Stream a file's bytes into `dest`. */
export async function readFileTo(path: string, dest: Writable): Promise<void> {
  checkPath(path);
  const p = spawn("/bin/cat", ["--", path], { ...asAgent(), stdio: ["ignore", "pipe", "pipe"], env: sessionEnv() });
  let err = "";
  p.stderr.on("data", (b) => (err += b));
  const exited = new Promise<number>((resolve) => p.on("close", (code) => resolve(code ?? 1)));
  // Plain pipe, not stream.pipeline: pipeline would destroy `dest` (the HTTP response) when done.
  p.stdout.pipe(dest, { end: false });
  const code = await exited;
  p.stdout.unpipe(dest);
  if (code !== 0) throw fileError(err, path);
}

/** Write `src` to `path` (creating parent directories), owned by the agent. Returns bytes written. */
export async function writeFileFrom(path: string, src: Readable): Promise<number> {
  checkPath(path);
  const script = 'set -e; d="$(dirname -- "$1")"; mkdir -p -- "$d"; cat > "$1"';
  const p = spawn("/bin/bash", ["-c", script, "deskhand-put", path], { ...asAgent(), stdio: ["pipe", "ignore", "pipe"], env: sessionEnv() });
  let err = "";
  let bytes = 0;
  p.stderr.on("data", (b) => (err += b));
  const exited = new Promise<number>((resolve) => p.on("close", (code) => resolve(code ?? 1)));
  src.on("data", (b: Buffer) => (bytes += b.length));
  p.stdin.on("error", () => undefined);
  // Plain pipe, not stream.pipeline: pipeline destroys `src` (the HTTP request, and with it the
  // socket the response must go out on) when it finishes.
  src.pipe(p.stdin);
  const code = await exited;
  if (code !== 0) {
    src.unpipe(p.stdin);
    src.resume(); // drain whatever the client still sends
    throw fileError(err, path);
  }
  return bytes;
}
