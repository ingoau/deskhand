import { describe, expect, it } from "vitest";
import { runExec } from "../../src/exec.js";
import { listProcs } from "../../src/procs.js";
import { sleep } from "../../src/util.js";

const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" };

describe("runExec", () => {
  it("captures stdout, stderr and the exit code with stdin closed", async () => {
    const r = await runExec({ command: "echo out; echo err >&2; cat; exit 3", cwd: "/tmp", env });
    expect(r).toMatchObject({ exitCode: 3, signal: null, timedOut: false, stdout: "out\n", stderr: "err\n", truncated: false });
  });

  it("returns promptly when a detached child keeps the pipes open", async () => {
    const t0 = Date.now();
    const marker = `deskhand-detached-${process.pid}-${Date.now()}`;
    const r = await runExec({ command: `(exec -a ${marker} sleep 5) & echo started`, cwd: "/tmp", env });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.stdout).toBe("started\n");
    expect(r.timedOut).toBe(false);
    // The child keeps running (like xclip serving the clipboard); clean it up.
    const child = listProcs().find((p) => p.cmdline.startsWith(marker));
    expect(child).toBeDefined();
    process.kill(child!.pid, "SIGKILL");
  });

  it("kills the whole process group on timeout, including background children", async () => {
    const marker = `deskhand-timeout-${process.pid}-${Date.now()}`;
    const t0 = Date.now();
    const r = await runExec({ command: `(exec -a ${marker} sleep 30) & (exec -a ${marker} sleep 30)`, cwd: "/tmp", env, timeoutMs: 300, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    await sleep(300);
    expect(listProcs().filter((p) => p.cmdline.startsWith(marker))).toHaveLength(0);
  });

  it("caps output and marks it truncated", async () => {
    const r = await runExec({ command: "head -c 300000 /dev/zero | tr '\\0' x", cwd: "/tmp", env, maxOutputBytes: 1000 });
    expect(r.stdout.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it("rejects a relative or missing cwd", async () => {
    expect(() => runExec({ command: "true", cwd: "relative", env })).toThrow(/absolute/);
    expect(() => runExec({ command: "true", cwd: "/does/not/exist", env })).toThrow(/not a directory/);
  });
});
