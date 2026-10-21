import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Outlet, RouterProvider, useLocation, useSearchParams } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { BottomTabs, TopNav } from "./components/Nav";
import { ToastProvider, useToast } from "./components/ui/toast";
import { ApiError, setUnauthorizedHandler } from "./lib/api";
import { ROUTER_BASENAME } from "./lib/base";
import { NowProvider } from "./lib/now";
import { useSystem } from "./lib/queries";
import { DesktopPage } from "./routes/Desktop";
import { Grid } from "./routes/Grid";
import { Login } from "./routes/Login";
import { LogPage } from "./routes/Log";
import { Settings } from "./routes/Settings";
import { TemplatePage } from "./routes/Template";
import { Templates } from "./routes/Templates";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

/** Signed in already but arrived from a dead login link (`?login=expired`): say so once and tidy the URL. */
function LoginLinkNotice() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const reason = params.get("login");
  // Only once a request succeeded: when not signed in, the 401 handler carries the reason to the login page.
  const signedIn = useSystem().isSuccess;
  useEffect(() => {
    if (!reason || !signedIn) return;
    toast(reason === "expired" ? "That login link had expired or was already used; you're still signed in." : "That login link was incomplete; you're still signed in.", "info");
    const next = new URLSearchParams(params);
    next.delete("login");
    setParams(next, { replace: true });
  }, [reason, signedIn, params, setParams, toast]);
  return null;
}

function Shell() {
  const { pathname } = useLocation();
  // Bottom tabs on the phone list pages only; the desktop page has its own pinned action bar.
  const tabs = !pathname.startsWith("/desktops/");
  return (
    <div className="min-h-dvh">
      <LoginLinkNotice />
      <TopNav />
      <Outlet />
      {tabs ? <BottomTabs /> : null}
    </div>
  );
}

function NotFound() {
  return (
    <div className="px-4 py-6 sm:px-[18px]">
      <p className="text-muted">nothing here.</p>
      <Link to="/" className="mt-2 inline-block text-amber">
        ‹ desktops
      </Link>
    </div>
  );
}

const router = createBrowserRouter(
  [
    { path: "/login", element: <Login /> },
    {
      element: <Shell />,
      children: [
        { index: true, element: <Grid /> },
        { path: "desktops/:id", element: <DesktopPage /> },
        { path: "desktops/:id/log", element: <LogPage /> },
        { path: "templates", element: <Templates /> },
        { path: "templates/:name", element: <TemplatePage /> },
        { path: "settings", element: <Settings /> },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: ROUTER_BASENAME },
);

setUnauthorizedHandler(() => {
  const { pathname: full, search } = router.state.location;
  const pathname = ROUTER_BASENAME !== "/" && full.startsWith(ROUTER_BASENAME) ? full.slice(ROUTER_BASENAME.length) || "/" : full;
  if (pathname === "/login") return;
  void queryClient.cancelQueries();
  // A failed login link lands on `${base}/?login=expired|missing`: carry the reason to the login page, not into `next`.
  const params = new URLSearchParams(search);
  const reason = params.get("login");
  params.delete("login");
  const rest = params.toString();
  const q = new URLSearchParams({ next: pathname + (rest ? `?${rest}` : "") });
  if (reason) q.set("reason", reason);
  void router.navigate(`/login?${q}`, { replace: true });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <NowProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </NowProvider>
    </QueryClientProvider>
  </StrictMode>,
);
