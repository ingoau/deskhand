import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jobStartScript, jobWaitScript, newJobId, parseJobStatus, waitForChange, withProfile } from "../src/exec.js";

const bash = (script: string, env: NodeJS.ProcessEnv = process.env) => execFileSync("/bin/bash", ["-c", script], { env, encoding: "utf8" });

describe("withProfile", () => {
  it("loads the first login profile quietly before the command", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dh-home-"));
    try {
      fs.writeFileSync(path.join(home, ".profile"), "export DH_FROM=profile\necho noise\n");
      expect(bash(withProfile('echo "[$DH_FROM]"'), { PATH: process.env.PATH, HOME: home })).toBe("[profile]\n");
      // bash's order: .bash_profile wins over .profile.
      fs.writeFileSync(path.join(home, ".bash_profile"), "export DH_FROM=bash_profile\n");
      expect(bash(withProfile('echo "[$DH_FROM]"'), { PATH: process.env.PATH, HOME: home })).toBe("[bash_profile]\n");
      // A broken profile doesn't stop the command.
      fs.writeFileSync(path.join(home, ".bash_profile"), "nonexistent-command-xyz\n");
      expect(bash(withProfile("echo still"), { PATH: process.env.PATH, HOME: home })).toBe("still\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("works without any profile", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dh-home-"));
    try {
      expect(bash(withProfile("echo hi"), { PATH: process.env.PATH, HOME: home })).toBe("hi\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("background job scripts", () => {
  it("start, wait and read a job, keeping quotes and odd characters intact", () => {
    const id = newJobId();
    expect(bash(jobStartScript(id, `printf '%s\\n' "it's \\$HOME-free"; echo "a'b\\"c"; exit 4`))).toContain("started");
    const st = parseJobStatus(bash(jobWaitScript(id, 5, 1000, false)));
    expect(st).toMatchObject({ state: "exited", exitCode: 4 });
    expect(st.tail).toBe(`it's $HOME-free\na'b"c\n`);
    expect(st.logBytes).toBe(Buffer.byteLength(st.tail));
  });

  it("cancel stops the whole process group", () => {
    const id = newJobId();
    bash(jobStartScript(id, "sleep 60 & sleep 60; echo never"));
    bash("sleep 0.3");
    const st = parseJobStatus(bash(jobWaitScript(id, 0, 1000, true)));
    expect(st.state).toBe("exited");
    expect([143, 137]).toContain(st.exitCode);
    const pgid = fs.readFileSync(`/tmp/deskhand-jobs/${id}.pid`, "utf8").trim();
    expect(bash(`pgrep -g ${pgid} || true`).trim()).toBe("");
  });

  it("reports missing jobs and refuses bad ids", () => {
    expect(parseJobStatus(bash(jobWaitScript("j00000000", 0, 10, false))).state).toBe("missing");
    expect(() => jobWaitScript("x; rm -rf /", 0, 10, false)).toThrow();
  });
});

describe("parseJobStatus", () => {
  it("parses running and exited output", () => {
    expect(parseJobStatus("STATE running\nSIZE 0\n---\n")).toEqual({ state: "running", exitCode: null, logBytes: 0, tail: "" });
    expect(parseJobStatus("STATE exited 0\nSIZE 5\n---\nhey\n\n")).toEqual({ state: "exited", exitCode: 0, logBytes: 5, tail: "hey\n\n" });
  });
});

describe("waitForChange", () => {
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("ignores frames seen during the baseline (a blinking caret) and fires on a new one", async () => {
    const c = clock();
    const frames = ["a", "b", "a", "b", "a", "b", "a", "b", "a", "c"];
    let i = 0;
    const r = await waitForChange({ grab: async () => Buffer.from(frames[Math.min(i++, frames.length - 1)]!), timeoutMs: 10_000, baselineMs: 1000, intervalMs: 250, ...c });
    expect(r.changed).toBe(true);
    expect(r.waitedMs).toBe(9 * 250);
  });

  it("times out when nothing new appears", async () => {
    const c = clock();
    const r = await waitForChange({ grab: async () => Buffer.from("same"), timeoutMs: 2000, intervalMs: 250, ...c });
    expect(r).toEqual({ changed: false, waitedMs: 2000 });
  });

  it("a change within the baseline window is part of the baseline", async () => {
    const c = clock();
    let i = 0;
    // Changes once at 250 ms (inside the baseline), then stays: no "change" reported.
    const r = await waitForChange({ grab: async () => Buffer.from(i++ === 0 ? "x" : "y"), timeoutMs: 3000, baselineMs: 1200, ...c });
    expect(r.changed).toBe(false);
  });
});
