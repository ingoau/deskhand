/**
 * Shell helpers for desktop_exec / exec_wait and the change detection behind `wait until:"change"`.
 *
 * Everything here runs on top of the daemon's existing /exec and /screenshot endpoints, so it also works
 * on desktops started from templates whose image carries an older daemon.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * Prepended to every desktop_exec command: loads the agent's login profile the way a bash login shell
 * would (first readable of ~/.bash_profile, ~/.bash_login, ~/.profile), so PATH and variables a template
 * set there (Android SDK, JDK, ~/bin) are there without `. ~/.profile` in every command. Its output and
 * errors are discarded so they never mix with the command's own.
 */
export const PROFILE_PRELUDE =
  'for __dh_p in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do if [ -r "$__dh_p" ]; then . "$__dh_p" >/dev/null 2>&1 </dev/null; break; fi; done; unset __dh_p';

export function withProfile(command: string): string {
  return `${PROFILE_PRELUDE}\n${command}`;
}

/** Where background jobs keep <id>.cmd, .log, .pid and .exit inside the desktop. */
export const JOB_DIR = "/tmp/deskhand-jobs";
export const JOB_ID_RE = /^j[0-9a-f]{8}$/;

export function newJobId(): string {
  return `j${randomBytes(4).toString("hex")}`;
}

/**
 * Starts `command` detached (own session, survives the /exec call) with stdout+stderr in <id>.log; the
 * exit code lands in <id>.exit when it finishes. POSIX sh so it also runs where `sh` is dash.
 */
export function jobStartScript(id: string, command: string): string {
  if (!JOB_ID_RE.test(id)) throw new Error(`bad job id ${id}`);
  const b64 = Buffer.from(withProfile(command), "utf8").toString("base64");
  const f = `${JOB_DIR}/${id}`;
  return [
    `mkdir -p ${JOB_DIR} && cd "$HOME" || exit 1`,
    `printf '%s' '${b64}' | base64 -d > ${f}.cmd || exit 1`,
    // $$ of the setsid'd sh is its process group id, so cancel can signal the whole group. The wrapper
    // survives SIGTERM (a trap, which children don't inherit) so it can still record the exit code.
    `setsid sh -c 'trap : TERM; echo $$ > "$1.pid"; bash "$1.cmd" > "$1.log" 2>&1 < /dev/null; echo $? > "$1.exit.tmp"; mv "$1.exit.tmp" "$1.exit"' sh ${f} > /dev/null 2>&1 < /dev/null &`,
    `echo started`,
  ].join("\n");
}

/**
 * Waits up to `timeoutSec` for the job to finish (or cancels it first), then prints a status header and
 * the tail of its log:
 *   STATE <running|exited <code>|missing>
 *   SIZE <log bytes>
 *   ---
 *   <last tailBytes bytes of the log>
 */
export function jobWaitScript(id: string, timeoutSec: number, tailBytes: number, cancel: boolean): string {
  if (!JOB_ID_RE.test(id)) throw new Error(`bad job id ${id}`);
  const f = `${JOB_DIR}/${id}`;
  const ticks = Math.max(0, Math.round(timeoutSec * 5));
  return [
    `f=${f}`,
    `if [ ! -e "$f.cmd" ]; then echo "STATE missing"; exit 0; fi`,
    ...(cancel
      ? [
          `if [ ! -e "$f.exit" ] && [ -s "$f.pid" ]; then kill -TERM "-$(cat "$f.pid")" 2>/dev/null; i=0; while [ ! -e "$f.exit" ] && [ $i -lt 25 ]; do sleep 0.2; i=$((i+1)); done; if [ ! -e "$f.exit" ]; then kill -KILL "-$(cat "$f.pid")" 2>/dev/null; sleep 0.2; [ -e "$f.exit" ] || echo 137 > "$f.exit"; fi; fi`,
        ]
      : []),
    `i=0; while [ ! -e "$f.exit" ] && [ $i -lt ${ticks} ]; do sleep 0.2; i=$((i+1)); done`,
    `if [ -e "$f.exit" ]; then echo "STATE exited $(cat "$f.exit")"; else echo "STATE running"; fi`,
    `echo "SIZE $(wc -c < "$f.log" 2>/dev/null || echo 0)"`,
    `echo ---`,
    `tail -c ${tailBytes} "$f.log" 2>/dev/null`,
  ].join("\n");
}

export interface JobStatus {
  state: "running" | "exited" | "missing";
  exitCode: number | null;
  logBytes: number;
  tail: string;
}

export function parseJobStatus(stdout: string): JobStatus {
  const sep = stdout.indexOf("\n---\n");
  const head = sep >= 0 ? stdout.slice(0, sep) : stdout;
  const tail = sep >= 0 ? stdout.slice(sep + 5) : "";
  const st = /^STATE (running|exited|missing)(?: (-?\d+))?/m.exec(head);
  const size = /^SIZE (\d+)/m.exec(head);
  const state = (st?.[1] as JobStatus["state"]) ?? "missing";
  return { state, exitCode: st?.[2] !== undefined ? Number(st[2]) : null, logBytes: size ? Number(size[1]) : 0, tail };
}

// ---------------------------------------------------------------- wait until the screen changes

export interface ChangeOptions {
  /** Grab the (possibly cropped) screen as encoded bytes. */
  grab: () => Promise<Buffer>;
  timeoutMs: number;
  /**
   * Frames seen during this initial window count as "unchanged", so a blinking caret, a pulsing cursor or
   * a short spinner loop does not end the wait.
   */
  baselineMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface ChangeResult {
  changed: boolean;
  waitedMs: number;
}

const digest = (b: Buffer) => createHash("sha1").update(b).digest("hex");

/** Polls until a frame appears that was not seen during the baseline window, or the timeout passes. */
export async function waitForChange(o: ChangeOptions): Promise<ChangeResult> {
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = o.intervalMs ?? 250;
  const baselineMs = Math.min(o.baselineMs ?? 1200, o.timeoutMs);
  const start = now();
  const seen = new Set<string>([digest(await o.grab())]);
  for (;;) {
    if (o.signal?.aborted) throw o.signal.reason ?? new Error("aborted");
    const t = now() - start;
    if (t >= o.timeoutMs) return { changed: false, waitedMs: t };
    await sleep(Math.min(interval, Math.max(0, o.timeoutMs - t)));
    const h = digest(await o.grab());
    const el = now() - start;
    if (el < baselineMs) seen.add(h);
    else if (!seen.has(h)) return { changed: true, waitedMs: el };
  }
}
