/**
 * Runtime base path. The manager serves the dashboard under DESKHAND_BASE_PATH and rewrites
 * `<base href="/">` in index.html (it may also set `window.__DESKHAND_BASE__`). Everything — assets,
 * API calls, websockets, router — is relative to this. Always ends with "/".
 */
declare global {
  interface Window {
    __DESKHAND_BASE__?: string;
    /** Set by the mock dev server only. */
    __DESKHAND_MOCK__?: boolean;
  }
}

export function normalizeBase(raw: string | null | undefined): string {
  let b = (raw ?? "/").trim();
  if (!b) b = "/";
  // Accept absolute URLs (document.baseURI) and bare paths.
  if (/^[a-z]+:\/\//i.test(b)) {
    try {
      b = new URL(b).pathname;
    } catch {
      b = "/";
    }
  }
  if (!b.startsWith("/")) b = "/" + b;
  if (!b.endsWith("/")) b += "/";
  return b.replace(/\/{2,}/g, "/");
}

export function detectBase(win: Pick<Window, "__DESKHAND_BASE__"> & { document?: { baseURI?: string } } = window): string {
  if (win.__DESKHAND_BASE__) return normalizeBase(win.__DESKHAND_BASE__);
  const baseURI = win.document?.baseURI;
  if (baseURI) {
    // Only trust baseURI if a <base> element is present; otherwise it's just the page URL.
    const hasBase = typeof document !== "undefined" && !!document.querySelector("base[href]");
    if (hasBase) return normalizeBase(baseURI);
  }
  return "/";
}

export const BASE = typeof window === "undefined" ? "/" : detectBase();

/** Router basename: base without the trailing slash ("" for root). */
export const ROUTER_BASENAME = BASE === "/" ? "/" : BASE.slice(0, -1);

/** `apiUrl("api/desktops")` -> "/deskhand/api/desktops". Leading slashes in `path` are ignored. */
export function url(path: string, base: string = BASE): string {
  return base + path.replace(/^\/+/, "");
}

/** Absolute ws(s):// URL for a path under the base. */
export function wsUrl(path: string, loc: Pick<Location, "protocol" | "host"> = window.location, base: string = BASE): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}${url(path, base)}`;
}

/** Absolute http(s) URL of a dashboard page, e.g. for "copy session link". */
export function pageUrl(path: string, loc: Pick<Location, "origin"> = window.location, base: string = BASE): string {
  return `${loc.origin}${url(path, base)}`;
}

export const IS_MOCK = typeof window !== "undefined" && window.__DESKHAND_MOCK__ === true;
