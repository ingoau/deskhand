#!/usr/bin/env python3
"""deskhand reliability suite: real Claude Code sessions against a running deskhand manager.

Runs on the host where `claude` is installed (stdlib Python only, no Node). Each task starts one or more
headless `claude -p` sessions with the deskhand MCP server, watches the manager's API while they run,
then checks the effects (desktops, mounts, files on the host, action log, removal at session end).
Use suite/run.sh; results go to suite/results/<timestamp>/ (transcripts, monitor snapshots, verdicts).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent

# Pages with stable titles, one per desktop, so "browsed independently" is checkable.
PAGES = {
    "example": ("https://example.com", "Example Domain"),
    "iana": ("https://www.iana.org/", "Internet Assigned Numbers Authority"),
}


def iso_ms(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


@dataclass
class Ctx:
    url: str
    token: str
    model: str
    claude: str
    budget: str
    out: Path
    grace_s: int
    verbose: bool
    checks: list[dict[str, Any]] = field(default_factory=list)

    # ---------------------------------------------------------------- manager API
    def api(self, method: str, path: str) -> Any:
        req = urllib.request.Request(self.url + path, method=method, headers={"authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read()
            return json.loads(body) if body else None

    def log_entries(self, desktop: str) -> list[dict[str, Any]]:
        return self.api("GET", f"/api/desktops/{desktop}/log?limit=500")["entries"]

    # ---------------------------------------------------------------- checks
    def check(self, task: str, name: str, ok: bool, detail: Any = None) -> bool:
        self.checks.append({"task": task, "check": name, "ok": bool(ok), "detail": detail})
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name}" + (f" — {detail}" if detail is not None and (self.verbose or not ok) else ""), flush=True)
        return bool(ok)

    def mcp_config(self) -> str:
        p = self.out / "mcp.json"
        if not p.exists():
            p.write_text(json.dumps({"mcpServers": {"deskhand": {"type": "http", "url": f"{self.url}/mcp", "headers": {"Authorization": f"Bearer {self.token}"}}}}))
            p.chmod(0o600)
        return str(p)


class Monitor(threading.Thread):
    """Polls GET /api/desktops once a second; remembers every desktop seen and its container settings."""

    def __init__(self, ctx: Ctx):
        super().__init__(daemon=True)
        self.ctx = ctx
        self.seen: dict[str, dict[str, Any]] = {}
        self.stop_flag = threading.Event()
        self.docker = shutil.which("docker") is not None
        self.lock = threading.Lock()

    def run(self) -> None:
        while not self.stop_flag.is_set():
            try:
                now = time.time()
                live = {d["id"]: d for d in self.ctx.api("GET", "/api/desktops")["desktops"]}
                with self.lock:
                    for did, d in live.items():
                        rec = self.seen.setdefault(did, {"first_seen": now, "summary": d, "container": None, "max_memory": 0, "max_cpu": 0.0})
                        rec["last_seen"] = now
                        rec["summary"] = d
                        rec["max_memory"] = max(rec["max_memory"], d.get("memoryBytes") or 0)
                        rec["max_cpu"] = max(rec["max_cpu"], d.get("cpuPercent") or 0.0)
                        if rec["container"] is None and self.docker and d.get("status") == "running":
                            rec["container"] = self.inspect(d["name"])
                    for did, rec in self.seen.items():
                        if did not in live and "gone_at" not in rec:
                            rec["gone_at"] = now
            except Exception as e:  # keep polling through manager hiccups
                if self.ctx.verbose:
                    print(f"  monitor: {e}", file=sys.stderr)
            self.stop_flag.wait(1.0)

    @staticmethod
    def inspect(name: str) -> dict[str, Any] | None:
        try:
            out = subprocess.run(["docker", "inspect", name], capture_output=True, text=True, timeout=15).stdout
            c = json.loads(out)[0]
            sec = c["HostConfig"].get("SecurityOpt") or []
            return {
                "binds": c["HostConfig"].get("Binds") or [],
                "seccomp_profile": any(o.startswith("seccomp={") for o in sec),
                "apparmor_unconfined": "apparmor=unconfined" in sec,
                "memory": c["HostConfig"].get("Memory"),
                "nano_cpus": c["HostConfig"].get("NanoCpus"),
            }
        except Exception:
            return None

    def get(self, did: str) -> dict[str, Any] | None:
        with self.lock:
            return self.seen.get(did)

    def wait_gone(self, ids: list[str], timeout: float) -> dict[str, float | None]:
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                if all("gone_at" in self.seen.get(i, {}) for i in ids):
                    break
            time.sleep(1)
        with self.lock:
            return {i: self.seen.get(i, {}).get("gone_at") for i in ids}


@dataclass
class Run:
    name: str
    proc: subprocess.Popen[str]
    transcript: Path
    cwd: Path
    started: float
    ended: float | None = None
    result: dict[str, Any] | None = None
    final_text: str = ""
    messages: list[dict[str, Any]] = field(default_factory=list)


def start_claude(ctx: Ctx, name: str, prompt: str, tools: str, allowed: str) -> Run:
    cwd = Path(tempfile.mkdtemp(prefix=f"deskhand-suite-{name}-"))
    transcript = ctx.out / f"{name}.jsonl"
    cmd = [
        ctx.claude, "-p", prompt,
        "--mcp-config", ctx.mcp_config(), "--strict-mcp-config",
        "--tools", tools,
        "--allowedTools", allowed,
        "--model", ctx.model,
        "--max-budget-usd", ctx.budget,
        "--no-session-persistence",
        "--output-format", "stream-json", "--verbose",
    ]
    (ctx.out / f"{name}.prompt.txt").write_text(prompt)
    f = transcript.open("w")
    proc = subprocess.Popen(cmd, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, text=True)
    print(f"  started {name} (pid {proc.pid})", flush=True)
    return Run(name=name, proc=proc, transcript=transcript, cwd=cwd, started=time.time())


def finish(run: Run, timeout: float) -> Run:
    try:
        run.proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        run.proc.kill()
        run.proc.wait()
    run.ended = time.time()
    for line in run.transcript.read_text().splitlines():
        try:
            run.messages.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    res = next((m for m in reversed(run.messages) if m.get("type") == "result"), None)
    run.final_text = (res or {}).get("result") or ""
    m = re.findall(r"RESULT\s*(\{.*\})", run.final_text)
    if m:
        try:
            run.result = json.loads(m[-1])
        except json.JSONDecodeError:
            run.result = None
    shutil.rmtree(run.cwd, ignore_errors=True)
    print(f"  {run.name} exited {run.proc.returncode} after {run.ended - run.started:.0f}s; session {(res or {}).get('session_id')}; cost ${(res or {}).get('total_cost_usd', 0):.2f}", flush=True)
    return run


def tool_uses(run: Run) -> list[dict[str, Any]]:
    """Every tool_use block in the transcript, with the subagent it came from (parent_tool_use_id)."""
    out = []
    for m in run.messages:
        if m.get("type") != "assistant":
            continue
        for b in m.get("message", {}).get("content", []):
            if b.get("type") == "tool_use":
                out.append({"name": b.get("name"), "input": b.get("input"), "id": b.get("id"), "parent": m.get("parent_tool_use_id"), "msg": m.get("message", {}).get("id")})
    return out


INPUT_TOOLS = {"left_click", "double_click", "triple_click", "right_click", "middle_click", "key", "type", "scroll", "mouse_move", "left_click_drag"}


def input_span(entries: list[dict[str, Any]]) -> tuple[float, float, int] | None:
    acts = [e for e in entries if e["tool"] in INPUT_TOOLS]
    if not acts:
        return None
    starts = [iso_ms(e["at"]) - (e.get("durationMs") or 0) / 1000 for e in acts]
    ends = [iso_ms(e["at"]) for e in acts]
    return min(starts), max(ends), len(acts)


def browse_steps(page: str) -> str:
    url, _ = PAGES[page]
    return (
        f"Open Chromium using the screen only: take a screenshot, click the Chromium launcher in the bottom panel, wait for the window, "
        f"press ctrl+l, type {url} and press Enter, then take a screenshot and read the page title (window title or tab). "
        "Do not use desktop_exec to open the browser or the page."
    )


# ---------------------------------------------------------------- tasks

def task_two_sessions(ctx: Ctx, mon: Monitor) -> None:
    """Phase 2: two sessions, separate desktops with their own mounts (one ro, one rw), independent browsing, removal at session end."""
    T = "two_sessions"
    root = Path(tempfile.mkdtemp(prefix="deskhand-e2e-", dir="/tmp"))
    a_dir, b_dir = root / "a-readonly", root / "b-writable"
    a_dir.mkdir()
    b_dir.mkdir()
    (a_dir / "readme.txt").write_text("host file, mounted read-only\n")
    os.chmod(root, 0o755)
    try:
        prompt_a = (
            "You have deskhand MCP tools that control your own isolated Linux desktop. Do exactly this:\n"
            f'1. Call desktop_start with mounts=[{{"path": "{a_dir}"}}] (read-only: do not pass write).\n'
            f"2. {browse_steps('example')}\n"
            f"3. Call desktop_exec with command `touch {a_dir}/agent-was-here` and note whether it failed and the error text.\n"
            "4. Do not call desktop_stop.\n"
            'Finish with one line: RESULT {"desktop": "<desktop id>", "page_title": "<exact title>", "write_failed": <true|false>, "error": "<error text or empty>"}'
        )
        prompt_b = (
            "You have deskhand MCP tools that control your own isolated Linux desktop. Do exactly this:\n"
            f'1. Call desktop_start with mounts=[{{"path": "{b_dir}", "write": true}}].\n'
            f"2. {browse_steps('iana')}\n"
            f"3. Call desktop_exec to write the exact page title into {b_dir}/title.txt (e.g. printf '%s\\n' '<title>' > {b_dir}/title.txt), then ls -ln that file.\n"
            "4. Do not call desktop_stop.\n"
            'Finish with one line: RESULT {"desktop": "<desktop id>", "page_title": "<exact title>", "file": "<path written>"}'
        )
        tools, allowed = "", "mcp__deskhand__*"
        ra = start_claude(ctx, "session-a", prompt_a, tools, allowed)
        rb = start_claude(ctx, "session-b", prompt_b, tools, allowed)
        finish(ra, 900)
        finish(rb, 900)

        ok_a = ctx.check(T, "session A finished with a RESULT", ra.proc.returncode == 0 and ra.result is not None, ra.final_text[-300:])
        ok_b = ctx.check(T, "session B finished with a RESULT", rb.proc.returncode == 0 and rb.result is not None, rb.final_text[-300:])
        if not (ok_a and ok_b):
            return
        da, db = ra.result["desktop"], rb.result["desktop"]
        ma, mb = mon.get(da), mon.get(db)
        ctx.check(T, "separate desktops", da != db and ma is not None and mb is not None, {"a": da, "b": db})
        if not (ma and mb):
            return
        sa, sb = ma["summary"], mb["summary"]
        ctx.check(T, "separate MCP sessions", sa.get("session") and sa.get("session") != sb.get("session"), {"a": sa.get("session"), "b": sb.get("session")})
        norm = lambda ms: [{"path": m["path"], "write": bool(m.get("write"))} for m in ms]  # the API omits write: false
        ctx.check(T, "A has only its read-only mount", norm(sa["mounts"]) == [{"path": str(a_dir), "write": False}], sa["mounts"])
        ctx.check(T, "B has only its writable mount", norm(sb["mounts"]) == [{"path": str(b_dir), "write": True}], sb["mounts"])
        if ma["container"] and mb["container"]:
            ctx.check(T, "container binds match", ma["container"]["binds"] == [f"{a_dir}:{a_dir}:ro"] and mb["container"]["binds"] == [f"{b_dir}:{b_dir}:rw"], [ma["container"]["binds"], mb["container"]["binds"]])
            ctx.check(T, "Chrome seccomp profile + apparmor=unconfined", all(c["container"]["seccomp_profile"] and c["container"]["apparmor_unconfined"] for c in (ma, mb)))
        ctx.check(T, "read-only enforced (agent saw the write fail, nothing on the host)", ra.result.get("write_failed") is True and not (a_dir / "agent-was-here").exists(), ra.result.get("error"))
        f = b_dir / "title.txt"
        st = f.stat() if f.exists() else None
        ctx.check(T, "writable mount got the agent's file, owned by the host user", st is not None and st.st_uid == os.getuid() and st.st_gid == os.getgid(), {"exists": st is not None, "uid": st and st.st_uid, "content": f.read_text().strip() if st else None})
        ctx.check(T, f"A browsed to example.com ({PAGES['example'][1]})", PAGES["example"][1] in ra.result.get("page_title", ""), ra.result.get("page_title"))
        ctx.check(T, f"B browsed to iana.org ({PAGES['iana'][1]})", PAGES["iana"][1] in rb.result.get("page_title", ""), rb.result.get("page_title"))
        if st:
            ctx.check(T, "B's file holds its page title", PAGES["iana"][1] in f.read_text(), f.read_text().strip())
        for label, d in (("A", da), ("B", db)):
            entries = ctx.log_entries(d)
            tools_used = [e["tool"] for e in entries]
            opened_by_exec = [e["summary"] for e in entries if e["tool"] == "desktop_exec" and re.search(r"chrom|xdg-open|example\.com|iana", e["summary"])]
            ctx.check(T, f"{label} browsed with pixels/keyboard (clicks and keys in its log, no exec launch)", any(t in ("left_click", "double_click") for t in tools_used) and any(t in ("key", "type") for t in tools_used) and not opened_by_exec, {"actions": len(entries), "exec_launch": opened_by_exec})
            sessions = {e["session"] for e in entries if e.get("session")}
            ctx.check(T, f"{label}'s log has only its own session", len(sessions) == 1, sessions)
        gone = mon.wait_gone([da, db], ctx.grace_s + 60)
        last_exit = max(ra.ended or 0, rb.ended or 0)
        ctx.check(T, "both desktops removed after the sessions ended", all(gone.values()), {k: (round(v - last_exit) if v else None) for k, v in gone.items()})
    finally:
        shutil.rmtree(root, ignore_errors=True)


def task_subagents(ctx: Ctx, mon: Monitor) -> None:
    """Phase 2: one agent runs two subagents on separate desktops at once."""
    T = "subagents"
    prompt = (
        "You coordinate two subagents, each working on its own deskhand desktop.\n"
        '1. Call desktop_start twice: name "sub-1", then name "sub-2". Note both desktop ids.\n'
        "2. In ONE message, launch two subagents with the Task tool so they run at the same time. Give each one its desktop id and these "
        "instructions: pass desktop=\"<id>\" on every deskhand tool call; " + browse_steps("example").replace("https://example.com", "<URL>") + " Report the exact page title.\n"
        f"   Subagent 1 uses desktop sub-1 with URL {PAGES['example'][0]}. Subagent 2 uses desktop sub-2 with URL {PAGES['iana'][0]}.\n"
        "3. Do not call desktop_stop.\n"
        'When both are done, finish with one line: RESULT {"desktops": ["<sub-1 id>", "<sub-2 id>"], "titles": ["<sub-1 title>", "<sub-2 title>"]}'
    )
    run = start_claude(ctx, "subagents", prompt, "Task", "mcp__deskhand__* Task Agent")
    finish(run, 1200)
    if not ctx.check(T, "parent finished with a RESULT", run.proc.returncode == 0 and run.result is not None, run.final_text[-300:]):
        return
    ids = run.result.get("desktops", [])
    titles = run.result.get("titles", [])
    ctx.check(T, "two separate desktops", len(ids) == 2 and ids[0] != ids[1] and all(mon.get(i) for i in ids), ids)
    if len(ids) != 2:
        return
    sessions = {mon.get(i)["summary"].get("session") for i in ids if mon.get(i)}
    ctx.check(T, "both desktops belong to the parent's one MCP session", len(sessions) == 1, sessions)
    uses = tool_uses(run)
    tasks = [u for u in uses if u["name"] in ("Task", "Agent")]
    by_msg: dict[str, int] = {}
    for u in tasks:
        by_msg[u["msg"]] = by_msg.get(u["msg"], 0) + 1
    ctx.check(T, "two subagents launched in one message", len(tasks) >= 2 and max(by_msg.values(), default=0) >= 2, {"task_calls": len(tasks)})
    sub_calls = [u for u in uses if u["parent"] and u["name"].startswith("mcp__deskhand__")]
    per_desktop = {i: sum(1 for u in sub_calls if (u["input"] or {}).get("desktop") == i) for i in ids}
    ctx.check(T, "subagents' deskhand calls name their desktop", all(n > 0 for n in per_desktop.values()), per_desktop)
    ctx.check(T, "titles match each desktop's page", len(titles) == 2 and PAGES["example"][1] in titles[0] and PAGES["iana"][1] in titles[1], titles)
    spans = {i: input_span(ctx.log_entries(i)) for i in ids}
    ctx.check(T, "input actions landed on both desktops", all(s and s[2] >= 3 for s in spans.values()), {i: s and s[2] for i, s in spans.items()})
    if all(spans.values()):
        (s1, e1, _), (s2, e2, _) = spans[ids[0]], spans[ids[1]]
        overlap = min(e1, e2) - max(s1, s2)
        ctx.check(T, "the two desktops were driven concurrently (action intervals overlap)", overlap > 0, {"overlap_s": round(overlap, 1), "spans_s": [round(e1 - s1, 1), round(e2 - s2, 1)]})
    gone = mon.wait_gone(ids, ctx.grace_s + 60)
    ctx.check(T, "both desktops removed after the session ended", all(gone.values()), {k: (round(v - (run.ended or 0)) if v else None) for k, v in gone.items()})


def task_contract(ctx: Ctx, mon: Monitor) -> None:
    """The agent sees the computer_toolset_20260801 names (cheap; uses the init message's tool list)."""
    T = "contract"
    run = start_claude(ctx, "contract", "Reply with the single word OK.", "", "mcp__deskhand__*")
    finish(run, 300)
    init = next((m for m in run.messages if m.get("type") == "system" and m.get("subtype") == "init"), {})
    names = {t.removeprefix("mcp__deskhand__") for t in init.get("tools", []) if t.startswith("mcp__deskhand__")}
    want = {"screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "left_mouse_down", "left_mouse_up", "mouse_move", "cursor_position", "scroll", "type", "key", "hold_key", "wait"}
    ctx.check(T, "Claude Code lists every computer_toolset_20260801 tool", want <= names, sorted(want - names))


TASKS: dict[str, Callable[[Ctx, Monitor], None]] = {"contract": task_contract, "two_sessions": task_two_sessions, "subagents": task_subagents}
SETS = {"phase2": ["contract", "two_sessions", "subagents"]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tasks", nargs="*", default=["phase2"], help=f"task names or sets: {', '.join([*SETS, *TASKS])}")
    ap.add_argument("--url", default=os.environ.get("DESKHAND_URL", "http://127.0.0.1:7480"))
    ap.add_argument("--token", default=os.environ.get("DESKHAND_TOKEN", ""))
    ap.add_argument("--model", default=os.environ.get("DESKHAND_SUITE_MODEL", "claude-sonnet-5-5"))
    ap.add_argument("--claude", default=os.environ.get("CLAUDE_BIN") or shutil.which("claude") or str(Path.home() / ".local/bin/claude"))
    ap.add_argument("--budget", default=os.environ.get("DESKHAND_SUITE_BUDGET_USD", "3"), help="max USD per claude session")
    ap.add_argument("--grace", type=int, default=int(os.environ.get("DESKHAND_SUITE_GRACE", "90")), help="seconds the manager may take to notice a session ended")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    if not args.token:
        print("set DESKHAND_TOKEN (an API token: `deskhand token create suite`)", file=sys.stderr)
        return 2
    names: list[str] = []
    for t in args.tasks:
        names += SETS.get(t, [t])
    unknown = [n for n in names if n not in TASKS]
    if unknown:
        print(f"unknown task(s): {unknown}", file=sys.stderr)
        return 2
    out = HERE / "results" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True)
    ctx = Ctx(url=args.url.rstrip("/"), token=args.token, model=args.model, claude=args.claude, budget=args.budget, out=out, grace_s=args.grace, verbose=args.verbose)
    try:
        health = json.loads(urllib.request.urlopen(f"{ctx.url}/healthz", timeout=10).read())
        ctx.api("GET", "/api/desktops")
    except (urllib.error.URLError, OSError) as e:
        print(f"manager not reachable at {ctx.url}: {e}", file=sys.stderr)
        return 2
    print(f"deskhand {health.get('version')} at {ctx.url}; model {ctx.model}; results in {out}")
    mon = Monitor(ctx)
    mon.start()
    t0 = time.time()
    for n in names:
        print(f"\n== {n}: {TASKS[n].__doc__}", flush=True)
        try:
            TASKS[n](ctx, mon)
        except Exception as e:  # a crashed task is a failed task, not a crashed suite
            ctx.check(n, "task ran", False, repr(e))
    mon.stop_flag.set()
    mon.join(timeout=5)
    (out / "mcp.json").unlink(missing_ok=True)  # holds the token
    (out / "monitor.json").write_text(json.dumps(mon.seen, indent=1, default=str))
    failed = [c for c in ctx.checks if not c["ok"]]
    (out / "summary.json").write_text(json.dumps({"url": ctx.url, "model": ctx.model, "seconds": round(time.time() - t0), "checks": ctx.checks, "failed": len(failed)}, indent=1, default=str))
    print(f"\n{len(ctx.checks) - len(failed)}/{len(ctx.checks)} checks passed in {time.time() - t0:.0f}s; details in {out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
