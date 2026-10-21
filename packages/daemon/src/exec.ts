/**
 * Run a shell command as the agent user. Never hangs: stdin is closed, output is captured through
 * pipes that are closed shortly after the command itself exits (so detached children such as
 * `xclip` holding the pipe cannot keep the call open), and on timeout the whole process group is
 * killed.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { DeskhandError, type ExecResponse } from "@deskhand/shared";
import { agentUser, sessionEnv } from "./session.js";

export interface ExecOptions {
  command: string;
  timeoutMs?: number;
  cwd?: string;
  /** Max bytes kept per stream (default 1 MiB). */
  maxOutputBytes?: number;
  /** After the main process exits, how long to wait for its pipes to close (default 200 ms). */
  drainMs?: number;
  /** Grace between SIGTERM and SIGKILL on timeout (default 1 s). */
  killGraceMs?: number;
  /** Run as this uid/gid instead of the agent (tests). */
  uid?: number;
  gid?: number;
  env?: Record<string, string>;
}

class Capped {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(b: Buffer): void {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.size;
    if (b.length > room) {
      this.chunks.push(b.subarray(0, room));
      this.size = this.max;
      this.truncated = true;
    } else {
      this.chunks.push(b);
      this.size += b.length;
    }
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export function runExec(o: ExecOptions): Promise<ExecResponse> {
  const user = agentUser();
  const timeoutMs = o.timeoutMs ?? 60_000;
  const cwd = o.cwd ?? user.home;
  if (!cwd.startsWith("/")) throw new DeskhandError("invalid_argument", `cwd must be an absolute path; got "${cwd}".`);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new DeskhandError("invalid_argument", `cwd "${cwd}" is not a directory.`);
  const max = o.maxOutputBytes ?? 1024 * 1024;
  const drainMs = o.drainMs ?? 200;
  const killGraceMs = o.killGraceMs ?? 1000;
  const isRoot = process.getuid?.() === 0;

  return new Promise<ExecResponse>((resolve) => {
    const child = spawn("/bin/bash", ["-c", o.command], {
      cwd,
      env: o.env ?? sessionEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so we can kill all of it
      ...(isRoot ? { uid: o.uid ?? user.uid, gid: o.gid ?? user.gid } : {}),
    });
    const out = new Capped(max);
    const err = new Capped(max);
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.stdout!.on("error", () => undefined);
    child.stderr!.on("error", () => undefined);

    let timedOut = false;
    let finished = false;
    let exitCode: number | null = null;
    let signal: string | null = null;

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* group already gone */
      }
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      child.stdout!.destroy();
      child.stderr!.destroy();
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: out.toString(),
        stderr: err.toString(),
        truncated: out.truncated || err.truncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), killGraceMs).unref();
    }, timeoutMs);
    // Absolute backstop: resolve even if the child never reports exit.
    const hardStop = setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
      finish();
    }, timeoutMs + killGraceMs + 2000);

    child.on("error", (e) => {
      err.push(Buffer.from(String(e.message)));
      exitCode = null;
      finish();
    });
    child.on("exit", (code, sig) => {
      exitCode = code;
      signal = sig;
      if (timedOut) killGroup("SIGKILL");
      // Give the pipes a moment to deliver the last output, then close them even if a detached
      // child still holds them open.
      let closed = 0;
      const onClose = () => {
        if (++closed === 2) finish();
      };
      child.stdout!.once("close", onClose);
      child.stderr!.once("close", onClose);
      if (child.stdout!.closed) onClose();
      if (child.stderr!.closed) onClose();
      setTimeout(finish, drainMs).unref();
    });
  });
}
