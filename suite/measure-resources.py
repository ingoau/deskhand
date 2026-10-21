#!/usr/bin/env python3
"""Measure desktop resource use (docs/sizing.md): idle, then Chromium on busy pages.

  DESKHAND_URL=... DESKHAND_TOKEN=... python3 -I suite/measure-resources.py [--desktops 2]

Runs on the Docker host (stdlib Python + docker CLI). Starts desktops through the manager API, drives
Chromium with `docker exec` (no model calls), samples `docker stats` (memory excludes page cache, like
the manager's own numbers), prints a table and writes suite/results/sizing-<timestamp>.json. Removes its
desktops at the end.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

PAGES = [
    "https://en.wikipedia.org/wiki/Main_Page",
    "https://news.ycombinator.com/",
    "https://www.bbc.com/news",
    "https://github.com/microsoft/playwright",
]


def api(url: str, token: str, method: str, path: str, body: object | None = None) -> object:
    req = urllib.request.Request(url + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"authorization": f"Bearer {token}", **({"content-type": "application/json"} if body is not None else {})})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
        return json.loads(data) if data else None


def stats(names: list[str]) -> dict[str, tuple[float, float]]:
    """{container: (cpu % of one core, memory MiB)} from one `docker stats` sample."""
    out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}", *names], capture_output=True, text=True).stdout
    res = {}
    units = {"KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "TiB": 1024**2, "B": 1 / 1024**2}
    for line in out.splitlines():
        name, cpu, mem = line.split("\t")
        used = mem.split(" / ")[0].strip()  # e.g. "312.4MiB"
        unit = next(u for u in units if used.endswith(u))
        res[name] = (float(cpu.rstrip("%") or 0), float(used[: -len(unit)]) * units[unit])
    return res


def sample(names: list[str], seconds: float) -> dict[str, dict[str, float]]:
    """Samples for `seconds` (docker stats takes ~2 s per sample); per container mean/max CPU and memory."""
    acc: dict[str, list[tuple[float, float]]] = {n: [] for n in names}
    end = time.time() + seconds
    while time.time() < end:
        for n, v in stats(names).items():
            acc[n].append(v)
    return {n: {"cpu_mean": round(statistics.mean(c for c, _ in v), 1), "cpu_max": round(max(c for c, _ in v), 1),
                "mem_mean": round(statistics.mean(m for _, m in v)), "mem_max": round(max(m for _, m in v))} for n, v in acc.items() if v}


def in_desktop(container: str, cmd: str) -> None:
    subprocess.run(["docker", "exec", "-u", "agent", container, "/usr/local/lib/deskhand/session", "bash", "-c", cmd], capture_output=True, timeout=60)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("DESKHAND_URL", "http://127.0.0.1:7480"))
    ap.add_argument("--token", default=os.environ.get("DESKHAND_TOKEN", ""))
    ap.add_argument("--desktops", type=int, default=1)
    ap.add_argument("--settle", type=float, default=20, help="seconds to wait after each step before sampling")
    ap.add_argument("--window", type=float, default=20, help="seconds of sampling per step")
    a = ap.parse_args()
    url = a.url.rstrip("/")
    ids: list[str] = []
    results: dict[str, object] = {"pages": PAGES, "steps": {}}
    try:
        for i in range(a.desktops):
            ids.append(api(url, a.token, "POST", "/api/desktops", {"name": f"sizing-{i + 1}"})["id"])  # type: ignore[index]
        names = []
        for did in ids:
            for _ in range(120):
                d = api(url, a.token, "GET", f"/api/desktops/{did}")
                if d["status"] == "running":  # type: ignore[index]
                    names.append(d["name"])  # type: ignore[index]
                    break
                time.sleep(1)
        info = json.loads(subprocess.run(["docker", "inspect", names[0]], capture_output=True, text=True).stdout)[0]["HostConfig"]
        results["limits"] = {"memory_mib": info["Memory"] / 2**20, "cpus": info["NanoCpus"] / 1e9}

        def step(label: str, action, settle: float = a.settle, window: float = a.window, during: bool = False) -> None:
            with ThreadPoolExecutor(len(names)) as ex:
                list(ex.map(action, names))
            if during:  # sample while the action's effect is running (page loads, scrolling)
                r = sample(names, window)
            else:
                time.sleep(settle)
                r = sample(names, window)
            results["steps"][label] = r  # type: ignore[index]
            agg = {k: round(statistics.mean(v[k] for v in r.values()), 1) for k in ("cpu_mean", "cpu_max", "mem_mean", "mem_max")}
            print(f"{label:<42} cpu mean {agg['cpu_mean']:>6}%  max {agg['cpu_max']:>6}%   mem mean {agg['mem_mean']:>6} MiB  max {agg['mem_max']:>6} MiB", flush=True)

        step("idle desktop (X, WM, panel, VNC, daemon)", lambda n: None, settle=30)
        step(f"chromium loading {PAGES[0].split('/')[2]}", lambda n: in_desktop(n, f"nohup deskhand-chromium '{PAGES[0]}' >/dev/null 2>&1 &"), window=15, during=True)
        step("chromium, 1 busy tab, idle", lambda n: None, settle=10)
        for p in PAGES[1:]:
            step(f"+ tab {p.split('/')[2]} (loading)", lambda n, p=p: in_desktop(n, f"deskhand-chromium '{p}' >/dev/null 2>&1"), window=12, during=True)
        step(f"chromium, {len(PAGES)} busy tabs, idle", lambda n: None, settle=10)
        step("scrolling the active tab (PageDown x40)", lambda n: in_desktop(n, "nohup bash -c 'for i in $(seq 40); do xdotool key Next; sleep 0.4; done' >/dev/null 2>&1 &"), window=14, during=True)
    finally:
        for did in ids:
            try:
                api(url, a.token, "DELETE", f"/api/desktops/{did}")
            except Exception:
                pass
    out = Path(__file__).resolve().parent / "results" / f"sizing-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(results, indent=1))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
