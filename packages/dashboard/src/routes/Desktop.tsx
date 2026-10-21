import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import type RFB from "@novnc/novnc";
import type { DesktopSummary } from "@deskhand/shared";
import { DownloadDialog, KillDialog, SaveTemplateDialog, UploadDialog } from "../components/DesktopDialogs";
import { LiveView } from "../components/LiveView";
import { StatusDot } from "../components/StatusDot";
import { Button } from "../components/ui/button";
import { Menu, MenuCheckbox, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../components/ui/dropdown";
import { useToast } from "../components/ui/toast";
import { api, ApiError, errorMessage } from "../lib/api";
import { IS_MOCK, pageUrl } from "../lib/base";
import { cn } from "../lib/cn";
import { displayState, displayTitle, lockIsLong, metaLine } from "../lib/desktop";
import { clock, formatBytes, formatUptime, screenLabel, since, toMs, until } from "../lib/format";
import { KEYSYM, textToKeysyms } from "../lib/keysym";
import { useMediaQuery, useNow } from "../lib/now";
import { keys, useDesktop, useDesktopMutation, useHandBack, useRecentActions, useTakeOver } from "../lib/queries";
import { useQueryClient } from "@tanstack/react-query";

export function DesktopPage() {
  const { id = "" } = useParams();
  const { data: d, error, isPending } = useDesktop(id);
  if (isPending && !d) return <PageFrame>loading…</PageFrame>;
  if (!d) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <PageFrame>
        <p className={notFound ? "text-muted" : "text-red"}>{notFound ? "This desktop no longer exists." : errorMessage(error)}</p>
        <Link to="/" className="mt-3 inline-block text-amber">
          ‹ desktops
        </Link>
      </PageFrame>
    );
  }
  return <DesktopDetail desktop={d} />;
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 sm:px-[18px]">{children}</div>;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Non-secure contexts (plain http over LAN) have no async clipboard; fall back to a selection copy.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function DesktopDetail({ desktop: d }: { desktop: DesktopSummary }) {
  const now = useNow();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const state = displayState(d);
  const control = !!d.lock;
  const takeOver = useTakeOver(d.id);
  const handBack = useHandBack(d.id);
  const stop = useDesktopMutation(d.id, () => api.stopDesktop(d.id));
  const start = useDesktopMutation(d.id, () => api.startDesktop(d.id));
  const persist = useDesktopMutation(d.id, (v: boolean) => api.setPersistent(d.id, v));
  const [note, setNote] = useState("");
  const [rfb, setRfb] = useState<RFB | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const qc = useQueryClient();
  const [remoteClip, setRemoteClip] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "save" | "download" | "kill">(null);
  const [upload, setUpload] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lg = useMediaQuery("(min-width: 1024px)");

  // "take over →" from the attention banner arrives with state.takeover.
  const autoTook = useRef(false);
  useEffect(() => {
    const st = location.state as { takeover?: boolean } | null;
    if (st?.takeover && !autoTook.current && d.status === "running" && !d.lock) {
      autoTook.current = true;
      takeOver.mutate(undefined, { onError: (e) => toast(errorMessage(e), "error") });
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, d.status, d.lock, navigate, takeOver, toast]);

  const doTakeOver = () => takeOver.mutate(undefined, { onError: (e) => toast(errorMessage(e), "error") });
  const doHandBack = () =>
    handBack.mutate(note.trim() || null, {
      onSuccess: () => {
        toast(note.trim() ? "handed back with note" : "handed back", "ok");
        setNote("");
      },
      onError: (e) => toast(errorMessage(e), "error"),
    });

  const lockSince = toMs(d.lock?.since);
  const frame = state === "control" ? "border-violet" : state === "attention" ? "border-amber" : "border-line";
  const screen = d.screen;

  const menu = (
    <DesktopMenu
      desktop={d}
      onStop={() => stop.mutate(undefined, { onError: (e) => toast(errorMessage(e), "error") })}
      onStart={() => start.mutate(undefined, { onError: (e) => toast(errorMessage(e), "error") })}
      onPersistent={(v) => persist.mutate(v, { onError: (e) => toast(errorMessage(e), "error") })}
      onSave={() => setDialog("save")}
      onUpload={() => fileInput.current?.click()}
      onDownload={() => setDialog("download")}
      onKill={() => setDialog("kill")}
      onCopyLink={async () => toast((await copyText(pageUrl(`desktops/${d.id}`))) ? "session link copied" : "couldn't copy", "info")}
    />
  );

  const primary = control ? (
    <Button variant="violet" size="lg" className="flex-1" onClick={doHandBack} disabled={handBack.isPending} data-testid="hand-back">
      {handBack.isPending ? "handing back…" : "hand back"}
    </Button>
  ) : d.status === "stopped" ? (
    <Button variant="default" size="lg" className="flex-1" onClick={() => start.mutate()} disabled={start.isPending}>
      {start.isPending ? "starting…" : "start"}
    </Button>
  ) : (
    <Button variant="primary" size="lg" className="flex-1" onClick={doTakeOver} disabled={d.status !== "running" || takeOver.isPending} data-testid="take-over">
      {takeOver.isPending ? "taking over…" : "take over"}
    </Button>
  );

  const noteInput = control ? (
    <input
      value={note}
      onChange={(e) => setNote(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && doHandBack()}
      placeholder="note for the agent (optional)"
      aria-label="hand-back note"
      data-testid="handback-note"
      className="h-10 w-full rounded-sm border border-line-strong bg-bg px-3 text-sm text-fg placeholder:text-faint focus:border-violet focus:outline-none"
    />
  ) : null;

  return (
    <div className="pb-40 lg:pb-10">
      {/* top bar */}
      <div className="flex h-[46px] items-center px-4 sm:px-[18px]">
        <Link to="/" className="text-muted hover:text-fg">
          ‹ desktops
        </Link>
        <div className="ml-auto flex items-center gap-5">
          <Link to={`/desktops/${d.id}/log`} className="text-muted hover:text-fg" data-testid="log-link">
            log
          </Link>
          {lg ? menu : null}
        </div>
      </div>

      <div className="px-4 sm:px-[18px] lg:flex lg:gap-7">
        <div className="min-w-0 lg:flex-1" style={lg ? { maxWidth: `calc((100dvh - 170px) * ${screen.width} / ${screen.height})` } : undefined}>
          <h1 className="flex items-center gap-[10px] text-[14px] font-bold text-fg sm:text-lg">
            <StatusDot state={state} className="h-[7px] w-[7px]" pulse={state === "control" && lockIsLong(d, now)} />
            <span className="truncate" data-testid="desktop-title">
              {displayTitle(d)}
            </span>
          </h1>
          <div className="mt-1 truncate pl-[17px] text-muted" data-testid="desktop-meta">
            {metaLine(d, now)}
            <span className="hidden sm:inline">
              {" "}
              · {d.name}
              {d.cpuPercent != null ? ` · cpu ${Math.round(d.cpuPercent)}%` : ""}
              {d.memoryBytes != null ? ` · ${formatBytes(d.memoryBytes)}` : ""}
              {d.persistent ? " · persistent" : ""}
            </span>
          </div>

          <div className="mt-3" style={{ maxWidth: `calc((100dvh - 170px) * ${screen.width} / ${screen.height})` }}>
            <div className={cn("overflow-hidden rounded-sm border", frame)} style={{ aspectRatio: `${screen.width} / ${screen.height}` }}>
              {d.status === "starting" ? (
                <div className="grid h-full w-full place-items-center bg-tile text-muted">starting…</div>
              ) : (
                <LiveView
                  desktop={d}
                  control={control}
                  generation={d.lock?.generation ?? d.generation}
                  actualSize={actualSize}
                  onRfb={setRfb}
                  onClipboard={setRemoteClip}
                  onDropped={() => void qc.invalidateQueries({ queryKey: keys.desktop(d.id) })}
                />
              )}
            </div>
            <div className="mt-2 flex items-center text-muted">
              <span data-testid="view-mode" className={cn(control && "text-violet")}>
                {control ? `you have control · ${formatUptime(now - (lockSince ?? now))}` : d.status === "running" ? "view only" : d.status}
              </span>
              {control && lockIsLong(d, now) ? (
                <span className="ml-2 truncate text-amber" data-testid="long-lock">
                  · agent waiting — hand back when done
                </span>
              ) : null}
              {d.status === "running" ? (
                <button
                  className="ml-auto mr-3 text-muted hover:text-fg"
                  onClick={() => setActualSize((v) => !v)}
                  data-testid="toggle-size"
                  title={actualSize ? "scale the desktop to fit" : "show the desktop at its real size; drag to pan"}
                >
                  {actualSize ? "fit" : "1:1"}
                </button>
              ) : null}
              <span className={cn("tabular-nums", d.status !== "running" && "ml-auto")}>{screenLabel(screen)}</span>
            </div>
          </div>
        </div>

        <aside className="mt-5 lg:mt-[52px] lg:w-[300px] lg:shrink-0">
          {d.attention ? <NeedsYou desktop={d} now={now} /> : null}
          {d.lastHandback && !control && !d.attention && now - (toMs(d.lastHandback.at) ?? 0) < 10 * 60_000 ? (
            <div className="mb-5 border-l-2 border-line-strong pl-3 text-muted">
              handed back · {since(d.lastHandback.at, now)}
              {d.lastHandback.note ? <div className="mt-0.5 text-dim">“{d.lastHandback.note}”</div> : null}
            </div>
          ) : null}

          {control ? <ControlTools rfb={rfb} remoteClip={remoteClip} /> : null}

          {/* desktop: actions in the side panel */}
          {lg ? (
            <div className="mb-6 flex flex-col gap-2">
              {noteInput}
              <div className="flex">{primary}</div>
            </div>
          ) : null}

          <RecentActions desktop={d} />
        </aside>
      </div>

      {/* phone/tablet: pinned action bar */}
      {!lg ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 px-4 pt-3 backdrop-blur" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
          {noteInput ? <div className="mb-2">{noteInput}</div> : null}
          <div className="flex gap-2">
            {menu}
            {primary}
          </div>
        </div>
      ) : null}

      <input
        ref={fileInput}
        type="file"
        className="hidden"
        data-testid="upload-input"
        onChange={(e) => {
          setUpload(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <SaveTemplateDialog desktop={d} open={dialog === "save"} onOpenChange={(v) => setDialog(v ? "save" : null)} />
      <DownloadDialog desktop={d} open={dialog === "download"} onOpenChange={(v) => setDialog(v ? "download" : null)} />
      <KillDialog desktop={d} open={dialog === "kill"} onOpenChange={(v) => setDialog(v ? "kill" : null)} onKilled={() => navigate("/")} />
      <UploadDialog desktop={d} file={upload} onClose={() => setUpload(null)} />
    </div>
  );
}

function DesktopMenu(p: {
  desktop: DesktopSummary;
  onStop: () => void;
  onStart: () => void;
  onPersistent: (v: boolean) => void;
  onSave: () => void;
  onUpload: () => void;
  onDownload: () => void;
  onKill: () => void;
  onCopyLink: () => void;
}) {
  const d = p.desktop;
  const running = d.status === "running";
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          className="grid h-12 w-12 shrink-0 place-items-center rounded-sm border border-line-strong text-fg hover:bg-raised lg:h-auto lg:w-auto lg:border-0 lg:text-muted lg:hover:bg-transparent lg:hover:text-fg"
          aria-label="more actions"
          data-testid="desktop-menu"
        >
          ···
        </button>
      </MenuTrigger>
      <MenuContent side="top">
        {running ? <MenuItem onSelect={p.onStop}>stop</MenuItem> : d.status === "stopped" ? <MenuItem onSelect={p.onStart}>start</MenuItem> : null}
        <MenuItem onSelect={p.onSave} disabled={!running}>
          save as template…
        </MenuItem>
        <MenuCheckbox checked={d.persistent} onChange={p.onPersistent}>
          persistent
        </MenuCheckbox>
        <MenuItem onSelect={p.onCopyLink}>copy session link</MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={p.onUpload} disabled={!running} hint="→ ~/Downloads">
          upload file…
        </MenuItem>
        <MenuItem onSelect={p.onDownload} disabled={d.status === "starting"}>
          download file…
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={p.onKill} danger>
          kill
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function NeedsYou({ desktop: d, now }: { desktop: DesktopSummary; now: number }) {
  const a = d.attention!;
  const left = until(a.timeoutAt, now);
  const toast = useToast();
  const dismiss = useDesktopMutation(d.id, () => api.dismissAttention(d.id, null));
  return (
    <div className="mb-5 border-l-2 border-amber pl-3" data-testid="needs-you">
      <div className="flex items-baseline text-amber">
        needs you · {since(a.since, now)}
        {!d.lock ? (
          <button
            className="ml-auto text-2xs text-faint hover:text-fg disabled:opacity-50"
            disabled={dismiss.isPending}
            onClick={() =>
              dismiss.mutate(undefined, {
                onSuccess: () => toast("dismissed · the agent was told you didn't take over", "info"),
                onError: (e) => toast(errorMessage(e), "error"),
              })
            }
            data-testid="dismiss-attention"
            title="Clear the flag without taking over; the agent's request_human returns 'dismissed'."
          >
            dismiss
          </button>
        ) : null}
      </div>
      <div className="mt-1 text-fg">“{a.reason}”</div>
      <div className="mt-1 text-muted">{left ? `agent blocked · times out in ${left}` : a.timeoutAt ? "agent stopped waiting" : "agent blocked"}</div>
    </div>
  );
}

function RecentActions({ desktop: d }: { desktop: DesktopSummary }) {
  const { data } = useRecentActions(d.id, 5);
  const rows = (data ?? []).slice().reverse();
  return (
    <div data-testid="recent-actions">
      <div className="mb-2 flex items-center text-muted">
        recent
        <Link to={`/desktops/${d.id}/log`} className="ml-auto text-2xs text-faint hover:text-fg">
          full log →
        </Link>
      </div>
      {rows.length ? (
        <ul className="space-y-[5px]">
          {rows.map((e) => (
            <li key={e.id} className="flex gap-[10px]">
              <span className="shrink-0 tabular-nums text-muted">{clock(e.at)}</span>
              <span className={cn("truncate", e.outcome === "error" ? "text-red" : e.outcome === "unknown" ? "text-amber" : "text-fg")} title={e.summary}>
                {e.summary}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-faint">no actions yet</p>
      )}
    </div>
  );
}

/** While in control: type into the desktop from a phone keyboard, send keys, and share the clipboard. */
function ControlTools({ rfb, remoteClip }: { rfb: RFB | null; remoteClip: string | null }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [clip, setClip] = useState("");
  const disabled = !rfb;
  const send = (keysyms: number[]) => keysyms.forEach((k) => rfb?.sendKey(k, null));
  const key = (label: string, sym: number) => (
    <button key={label} className="h-8 rounded-sm border border-line-strong px-2 text-xs text-dim hover:bg-raised disabled:opacity-40" disabled={disabled} onClick={() => send([sym])}>
      {label}
    </button>
  );
  return (
    <div className="mb-5 rounded-sm border border-violet/30 bg-violet-bg/60 p-3" data-testid="control-tools">
      <div className="mb-2 text-xs text-violet">
        you have control · agent input is paused
        {disabled ? <span className="text-faint">{IS_MOCK ? " · (mock: no live view)" : " · connecting…"}</span> : null}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          send(textToKeysyms(text));
          setText("");
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="type into desktop…"
          aria-label="type into desktop"
          autoCapitalize="off"
          autoCorrect="off"
          className="h-8 min-w-0 flex-1 rounded-sm border border-line-strong bg-bg px-2 text-sm text-fg placeholder:text-faint focus:border-violet focus:outline-none"
        />
        <Button size="sm" type="submit" disabled={disabled || !text} className="h-8">
          send
        </Button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <LiveKeys rfb={rfb} />
        {key("enter", KEYSYM.Return)}
        {key("tab", KEYSYM.Tab)}
        {key("esc", KEYSYM.Escape)}
        {key("⌫", KEYSYM.BackSpace)}
        {key("←", KEYSYM.Left)}
        {key("→", KEYSYM.Right)}
        <button className="h-8 rounded-sm border border-line-strong px-2 text-xs text-dim hover:bg-raised disabled:opacity-40" disabled={disabled} onClick={() => rfb?.sendCtrlAltDel()}>
          ctrl+alt+del
        </button>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted">clipboard</summary>
        <textarea
          value={clip}
          onChange={(e) => setClip(e.target.value)}
          rows={2}
          placeholder="text to put on the desktop's clipboard"
          className="mt-2 w-full rounded-sm border border-line-strong bg-bg px-2 py-1 text-sm text-fg placeholder:text-faint focus:border-violet focus:outline-none"
        />
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            disabled={disabled}
            onClick={async () => {
              try {
                setClip(await navigator.clipboard.readText());
              } catch {
                toast("browser clipboard not readable here; paste into the box", "error");
              }
            }}
          >
            paste mine
          </Button>
          <Button
            size="sm"
            disabled={disabled || !clip}
            onClick={() => {
              rfb?.clipboardPasteFrom(clip);
              toast("sent to desktop clipboard", "ok");
            }}
          >
            send to desktop
          </Button>
        </div>
        {remoteClip ? (
          <div className="mt-2 text-xs text-muted">
            desktop clipboard: <span className="break-all text-dim">{remoteClip.length > 200 ? remoteClip.slice(0, 199) + "…" : remoteClip}</span>{" "}
            <button className="text-amber" onClick={() => copyText(remoteClip).then((ok) => toast(ok ? "copied" : "couldn't copy"))}>
              copy
            </button>
          </div>
        ) : null}
      </details>
    </div>
  );
}

const SPECIAL_KEYS: Record<string, number> = {
  Enter: KEYSYM.Return,
  Tab: KEYSYM.Tab,
  Escape: KEYSYM.Escape,
  Backspace: KEYSYM.BackSpace,
  Delete: KEYSYM.Delete,
  ArrowLeft: KEYSYM.Left,
  ArrowRight: KEYSYM.Right,
  ArrowUp: KEYSYM.Up,
  ArrowDown: KEYSYM.Down,
};

/**
 * "keyboard": focuses an invisible text field so a phone's on-screen keyboard opens, and forwards every key
 * straight to the desktop (characters, backspace, enter) — typing into the live view without the send box.
 * The field keeps one sentinel character so a backspace shows up as a shorter value even on Android, where
 * keydown reports "Unidentified".
 */
function LiveKeys({ rfb }: { rfb: RFB | null }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState(false);
  const composing = useRef(false);
  const reset = (el: HTMLTextAreaElement) => {
    el.value = " ";
    el.setSelectionRange(1, 1);
  };
  const flush = (el: HTMLTextAreaElement) => {
    const v = el.value;
    if (v.length === 0) rfb?.sendKey(KEYSYM.BackSpace, null);
    else if (v.length > 1) textToKeysyms(v.slice(1)).forEach((k) => rfb?.sendKey(k, null));
    reset(el);
  };
  return (
    <>
      <button
        className={cn("h-8 rounded-sm border px-2 text-xs hover:bg-raised disabled:opacity-40", active ? "border-violet text-violet" : "border-line-strong text-dim")}
        disabled={!rfb}
        onClick={() => {
          const el = ref.current;
          if (!el) return;
          reset(el);
          el.focus({ preventScroll: true });
        }}
        data-testid="live-keys"
        title="open the keyboard and type straight into the desktop"
      >
        ⌨ keyboard
      </button>
      <textarea
        ref={ref}
        aria-label="keyboard input for the desktop"
        data-testid="live-keys-input"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="pointer-events-none fixed bottom-0 left-0 h-px w-px resize-none opacity-0"
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        onKeyDown={(e) => {
          const sym = SPECIAL_KEYS[e.key];
          if (sym != null && !e.nativeEvent.isComposing) {
            e.preventDefault();
            rfb?.sendKey(sym, null);
          }
        }}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={(e) => {
          composing.current = false;
          flush(e.currentTarget);
        }}
        onInput={(e) => {
          if (!composing.current) flush(e.currentTarget);
        }}
      />
    </>
  );
}
