/** Minimal /proc scanning (no ps dependency). */
import { readdirSync, readFileSync } from "node:fs";

export interface Proc {
  pid: number;
  comm: string;
  uid: number;
  cmdline: string;
}

export function listProcs(): Proc[] {
  const out: Proc[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const p of pids) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const comm = readFileSync(`/proc/${p}/comm`, "utf8").trim();
      const status = readFileSync(`/proc/${p}/status`, "utf8");
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
      const cmdline = readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      out.push({ pid: Number(p), comm, uid, cmdline });
    } catch {
      /* exited meanwhile */
    }
  }
  return out;
}

export function isRunning(comm: string): boolean {
  return listProcs().some((p) => p.comm === comm);
}
