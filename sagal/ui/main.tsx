import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, setUnauthorizedHandler } from "./api";
import { AppCtx, RouterCtx, useRouterState, useViewport, type Ctx } from "./lib";
import { AuthScreen } from "./screens/Auth";
import { Shell } from "./screens/Shell";

function App() {
  const router = useRouterState();
  const vw = useViewport();
  const [auth, setAuth] = useState<{ ownerExists: boolean; signedIn: boolean; ownerEmailHint: string | null } | null>(null);
  const [overview, setOverview] = useState<Ctx["overview"]>(null);
  const [pending, setPending] = useState<Ctx["pending"]>(null);
  const [toastMsg, setToast] = useState<{ msg: string; err: boolean } | null>(null);

  const checkAuth = useCallback(() => api.get<typeof auth>("/api/auth/status").then(setAuth).catch(() => setAuth({ ownerExists: true, signedIn: false, ownerEmailHint: null })), []);
  useEffect(() => {
    void checkAuth();
    setUnauthorizedHandler(() => setAuth((a) => (a ? { ...a, signedIn: false } : a)));
  }, [checkAuth]);

  const refreshOverview = useCallback(() => {
    api.get<NonNullable<Ctx["overview"]>>("/api/overview").then(setOverview).catch(() => {});
  }, []);
  useEffect(() => {
    if (!auth?.signedIn) return;
    refreshOverview();
    const t = setInterval(refreshOverview, 60000);
    return () => clearInterval(t);
  }, [auth?.signedIn, refreshOverview]);

  const toast = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), 4200);
  }, []);

  const ctx: Ctx = {
    discuss: (c) => {
      setPending(c);
      router.go("/talk");
    },
    pending,
    clearPending: () => setPending(null),
    overview,
    refreshOverview,
    toast,
    vw,
  };

  if (!auth) return null;
  return (
    <RouterCtx.Provider value={router}>
      <AppCtx.Provider value={ctx}>
        {auth.signedIn ? <Shell /> : <AuthScreen ownerExists={auth.ownerExists} emailHint={auth.ownerEmailHint} onSignedIn={() => void checkAuth()} />}
        {toastMsg && (
          <div className={`toast${toastMsg.err ? " err" : ""}`} role="status" aria-live="polite">
            {toastMsg.msg}
          </div>
        )}
      </AppCtx.Provider>
    </RouterCtx.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
