#!/usr/bin/env python3
"""deskhand ui-tree helper: prints the AT-SPI accessibility tree as JSON (UiNode, see
packages/shared/src/daemon.ts). Run by the daemon as the agent user with the session D-Bus.

  uitree.py [--window SUBSTRING] [--max-nodes N] [--max-depth N]

Output: {"role":"desktop","name":"","children":[<window>...]} where each window is a top-level
frame/dialog/window of an application. Boxes are [x, y, w, h] in screen pixels. Nodes that are
not showing, have no usable box, and have no named descendants are pruned.
"""
import argparse
import json
import signal
import sys

KEEP_STATES = {
    "active", "checked", "collapsed", "editable", "expanded", "focused", "indeterminate",
    "modal", "multi-line", "pressed", "selected",
}
# Roles whose subtree we never descend into (huge and rarely useful).
SKIP_CHILDREN_ROLES = {"terminal"}
INVALID = -(2 ** 31)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", default=None)
    ap.add_argument("--max-nodes", type=int, default=2500)
    ap.add_argument("--max-depth", type=int, default=40)
    ap.add_argument("--timeout", type=int, default=12)
    args = ap.parse_args()

    def on_alarm(_s, _f):
        print(json.dumps({"error": "timeout", "message": "The accessibility tree took too long to read."}))
        sys.stdout.flush()
        sys.exit(3)

    signal.signal(signal.SIGALRM, on_alarm)
    signal.alarm(args.timeout)

    try:
        import pyatspi  # noqa: E402
    except Exception as e:  # pragma: no cover
        print(json.dumps({"error": "unavailable", "message": "pyatspi is not available: %s" % e}))
        return 2

    budget = [args.max_nodes]
    truncated = [False]

    def state_names(acc):
        try:
            ss = acc.getState()
            names = []
            for s in ss.getStates():
                n = pyatspi.stateToString(s).lower().replace("_", "-") if hasattr(pyatspi, "stateToString") else str(s).lower()
                n = n.replace("state-", "")
                if n in KEEP_STATES:
                    names.append(n)
            enabled = ss.contains(pyatspi.STATE_ENABLED) or ss.contains(pyatspi.STATE_SENSITIVE)
            if not enabled:
                names.append("disabled")
            showing = ss.contains(pyatspi.STATE_SHOWING)
            return sorted(set(names)), showing
        except Exception:
            return [], True

    def box_of(acc):
        try:
            e = acc.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        except Exception:
            return None
        if e.x <= INVALID + 1 or e.y <= INVALID + 1 or e.width <= 0 or e.height <= 0:
            return None
        if e.x < -10000 or e.y < -10000 or e.width > 20000 or e.height > 20000:
            return None
        return [int(e.x), int(e.y), int(e.width), int(e.height)]

    def walk(acc, depth):
        if budget[0] <= 0:
            truncated[0] = True
            return None
        budget[0] -= 1
        try:
            role = acc.getRoleName() or "unknown"
            name = (acc.name or "").strip()
        except Exception:
            return None
        states, showing = state_names(acc)
        box = box_of(acc)
        if not showing and depth > 0:
            return None
        children = []
        if depth < args.max_depth and role not in SKIP_CHILDREN_ROLES:
            try:
                n = min(acc.childCount, 1000)
            except Exception:
                n = 0
            for i in range(n):
                try:
                    c = acc.getChildAtIndex(i)
                except Exception:
                    continue
                if c is None:
                    continue
                k = walk(c, depth + 1)
                if k is not None:
                    children.append(k)
        if not name and not children and (box is None or role in ("filler", "panel", "section", "unknown")):
            return None
        # Collapse unnamed, stateless wrappers with a single child.
        if not name and not states and len(children) == 1 and role in ("filler", "panel", "section", "unknown", "grouping"):
            return children[0]
        node = {"role": role, "name": name[:500]}
        if states:
            node["states"] = states
        if box is not None:
            node["box"] = box
        if children:
            node["children"] = children
        return node

    desktop = pyatspi.Registry.getDesktop(0)
    windows = []
    want = args.window.lower() if args.window else None
    for i in range(desktop.childCount):
        try:
            app = desktop.getChildAtIndex(i)
        except Exception:
            continue
        if app is None:
            continue
        try:
            app_name = app.name or ""
            count = app.childCount
        except Exception:
            continue
        for j in range(count):
            try:
                win = app.getChildAtIndex(j)
                title = win.name or ""
            except Exception:
                continue
            if win is None:
                continue
            if want and want not in title.lower() and want not in app_name.lower():
                continue
            node = walk(win, 0)
            if node is not None:
                node["app"] = app_name
                windows.append(node)
    out = {"role": "desktop", "name": "", "children": windows}
    if truncated[0]:
        out["truncated"] = True
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
