#!/usr/bin/env python3
"""deskhand ui-tree helper: prints the AT-SPI accessibility tree as JSON (UiNode, see
packages/shared/src/daemon.ts). Run by the daemon as the agent user with the session D-Bus.

  uitree.py [--window SUBSTRING] [--max-nodes N] [--max-window-nodes N] [--max-depth N]

Output: {"role":"desktop","name":"","children":[<window>...]} where each window is a top-level
frame/dialog/window of an application, ordered topmost first (X stacking order), with `app`, and
`z` (0 = topmost). Only the window that really has the focus carries the "active" state (AT-SPI's own
flag goes stale when windows are raised without focus changes); minimised windows carry "minimized"
and no children. Boxes are [x, y, w, h] in screen pixels. Editable text, sliders and the like carry
`value`; unnamed elements carry `description` when the app sets one (e.g. a tooltip). Nodes that are
not showing, have no usable box, and have no named descendants are pruned.
"""
import argparse
import json
import re
import signal
import subprocess
import sys

KEEP_STATES = {
    "active", "checked", "collapsed", "editable", "expanded", "focused", "indeterminate",
    "modal", "multi-line", "pressed", "selected", "iconified",
}
# Roles whose subtree we never descend into (huge and rarely useful).
SKIP_CHILDREN_ROLES = {"terminal"}
# Roles whose current value is worth reporting (Text / Value interfaces).
VALUE_ROLES = {
    "text", "entry", "password text", "spin button", "slider", "scroll bar", "progress bar",
    "combo box", "editbar", "paragraph", "terminal", "level bar", "dial",
}
TOP_ROLES = {"frame", "dialog", "window", "alert", "file chooser", "color chooser", "font chooser"}
INVALID = -(2 ** 31)
MAX_VALUE = 300


def x_windows():
    """X top-level windows from the window manager: [{id, pid, title}] bottom-to-top, and the active id."""
    def run(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
        except Exception:
            return ""
    listing = {}
    for line in run(["wmctrl", "-lp"]).splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        try:
            wid = int(parts[0], 16)
            pid = int(parts[2])
        except ValueError:
            continue
        title = parts[4] if len(parts) > 4 else ""
        # wmctrl prints the client machine before the title.
        title = title.split(None, 1)[1] if " " in title else ""
        listing[wid] = {"id": wid, "pid": pid, "title": title}
    props = run(["xprop", "-root", "_NET_CLIENT_LIST_STACKING", "_NET_ACTIVE_WINDOW"])
    stacking, active = [], None
    for line in props.splitlines():
        ids = [int(h, 16) for h in re.findall(r"0x[0-9a-fA-F]+", line)]
        if line.startswith("_NET_CLIENT_LIST_STACKING"):
            stacking = ids
        elif line.startswith("_NET_ACTIVE_WINDOW") and ids:
            active = ids[0]
    ordered = [listing[w] for w in stacking if w in listing]
    ordered += [w for wid, w in listing.items() if wid not in stacking]
    return ordered, active


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", default=None)
    ap.add_argument("--max-nodes", type=int, default=4000)
    ap.add_argument("--max-window-nodes", type=int, default=2500)
    ap.add_argument("--max-depth", type=int, default=40)
    ap.add_argument("--timeout", type=int, default=12)
    args = ap.parse_args()

    def on_alarm(_s, _f):
        print(json.dumps({"error": "timeout", "message": "The accessibility tree took too long to read; an app may be unresponsive. Try again or pass `window`."}))
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

    def value_of(acc, role):
        if role not in VALUE_ROLES:
            return None
        try:
            t = acc.queryText()
            n = t.characterCount
            if n >= 0:
                s = t.getText(0, min(n, MAX_VALUE + 1))
                if role == "paragraph" and not s:
                    return None
                s = s.replace("\ufffc", "")
                if role == "combo box":
                    s = s.strip()
                    if not s:
                        return None
                return s[:MAX_VALUE] + ("…" if n > MAX_VALUE else "")
        except Exception:
            pass
        try:
            v = acc.queryValue().currentValue
            return ("%g" % v)
        except Exception:
            return None

    def walk(acc, depth, wbudget):
        if budget[0] <= 0 or wbudget[0] <= 0:
            truncated[0] = True
            return None
        budget[0] -= 1
        wbudget[0] -= 1
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
        if depth < args.max_depth and role not in SKIP_CHILDREN_ROLES and "iconified" not in states:
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
                k = walk(c, depth + 1, wbudget)
                if k is not None:
                    children.append(k)
        # A paragraph's text is already in its children (static text, links).
        value = value_of(acc, role) if depth > 0 and not (role == "paragraph" and children) else None
        desc = ""
        if not name:
            try:
                desc = (acc.description or "").strip()
            except Exception:
                desc = ""
        # Text that only repeats its parent's name (link "Home" > static "Home") is noise.
        children = [c for c in children if not (c["role"] in ("static", "label", "text") and not c.get("children") and c["name"] and c["name"] == name)]
        if not name and not desc and not children and value is None and (box is None or role in ("filler", "panel", "section", "unknown", "static", "label")):
            return None
        # Collapse unnamed, stateless wrappers with a single child.
        if not name and not desc and not states and len(children) == 1 and role in ("filler", "panel", "section", "unknown", "grouping", "static"):
            return children[0]
        node = {"role": role, "name": name[:500]}
        if desc:
            node["description"] = desc[:200]
        if value is not None:
            node["value"] = value
        if states:
            node["states"] = states
        if box is not None:
            node["box"] = box
        if children:
            node["children"] = children
        return node

    xwins, active_id = x_windows()
    desktop = pyatspi.Registry.getDesktop(0)
    want = args.window.lower() if args.window else None
    candidates = []  # (atspi window, app name, pid, title)
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
        try:
            pid = app.get_process_id()
        except Exception:
            pid = None
        for j in range(count):
            try:
                win = app.getChildAtIndex(j)
                title = (win.name or "").strip()
            except Exception:
                continue
            if win is None:
                continue
            candidates.append((win, app_name, pid, title))

    # Match AT-SPI windows to X windows (pid + title, then title, then pid) for stacking order and focus.
    used = set()

    def match(pid, title):
        for rule in (lambda w: w["pid"] == pid and w["title"] == title, lambda w: w["title"] == title and title, lambda w: w["pid"] == pid):
            for idx, w in enumerate(xwins):
                if idx not in used and rule(w):
                    used.add(idx)
                    return idx
        return None

    placed = []
    for win, app_name, pid, title in candidates:
        idx = match(pid, title)
        placed.append((idx, win, app_name, title))
    # Topmost first; windows unknown to the window manager (popups, menus) go first among equals since
    # they are override-redirect windows drawn above everything else.
    top = len(xwins)
    placed.sort(key=lambda p: -(p[0] if p[0] is not None else top))

    windows = []
    stack = []  # every window, topmost first: what may cover the windows we return
    for idx, win, app_name, title in placed:
        matched = not want or want in title.lower() or want in app_name.lower()
        if matched:
            node = walk(win, 0, [args.max_window_nodes if not want else args.max_nodes])
            if node is None:
                continue
        else:
            # Not asked for: only its frame (it may cover the windows that were asked for).
            try:
                kids = win.childCount
                role = win.getRoleName() or "window"
            except Exception:
                continue
            st, _ = state_names(win)
            node = {"role": role, "name": title[:500], "states": st}
            b = box_of(win)
            if b is not None:
                node["box"] = b
            if kids:
                node["children"] = []
        # Unnamed, empty top-level windows are leftovers (e.g. Chromium's hidden omnibox popups).
        if not node.get("name") and not node.get("children"):
            continue
        states = [s for s in node.get("states", []) if s != "active"]
        if idx is not None and xwins[idx]["id"] == active_id:
            states.append("active")
        if "iconified" in states:
            states = [s for s in states if s != "iconified"] + ["minimized"]
            node.pop("children", None)
        if idx is None and xwins and node.get("role") not in ("frame", "dialog", "file chooser"):
            states.append("popup")
        if states:
            node["states"] = sorted(set(states))
        else:
            node.pop("states", None)
        node["app"] = app_name
        node["z"] = len(stack)
        entry = {"name": node.get("name", ""), "app": app_name, "z": node["z"]}
        for k in ("box", "states"):
            if k in node:
                entry[k] = node[k]
        stack.append(entry)
        if matched:
            windows.append(node)
    out = {"role": "desktop", "name": "", "children": windows, "stack": stack}
    if truncated[0]:
        out["truncated"] = True
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
