import React, { useState } from "react";
import { api } from "../api";
import { Kicker, MarkS } from "../lib";

type Step = { kind: "form" } | { kind: "code"; challengeId: string; note: string | null; purpose: "verify" | "login" | "reset" };

/** Email + password, then the 6-digit code from the email. No passkeys, no Face ID. */
export function AuthScreen({ ownerExists, emailHint, onSignedIn }: { ownerExists: boolean; emailHint: string | null; onSignedIn: () => void }) {
  const [mode, setMode] = useState<"signin" | "setup" | "forgot">(ownerExists ? "signin" : "setup");
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if ((mode === "setup" || (mode === "forgot" && step.kind === "code")) && password !== password2) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      if (step.kind === "form") {
        const url = mode === "setup" ? "/api/auth/register" : mode === "signin" ? "/api/auth/login" : "/api/auth/forgot";
        const r = await api.post<{ challengeId: string; note: string | null }>(url, mode === "forgot" ? { email } : { email, password });
        setPassword2(mode === "forgot" ? "" : password2);
        if (mode === "forgot") setPassword("");
        setStep({ kind: "code", challengeId: r.challengeId, note: r.note, purpose: mode === "setup" ? "verify" : mode === "signin" ? "login" : "reset" });
      } else {
        await api.post("/api/auth/verify", { challengeId: step.challengeId, code, ...(step.purpose === "reset" ? { newPassword: password } : {}) });
        onSignedIn();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restart = (m: typeof mode) => {
    setMode(m);
    setStep({ kind: "form" });
    setCode("");
    setError(null);
  };

  const title =
    step.kind === "code" ? "Check your email." : mode === "setup" ? "Set up Sagal." : mode === "forgot" ? "Reset your password." : "Welcome back, Sabah.";

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="row g10">
          <MarkS size={40} />
          <div className="wordmark">Soma</div>
        </div>
        <div className="stack g8">
          <Kicker>{step.kind === "code" ? "Step 2 of 2 · email code" : mode === "setup" ? "First time · owner account" : "Sign in"}</Kicker>
          <h1 className="title-l">{title}</h1>
          {step.kind === "code" ? (
            <p className="lede" style={{ fontSize: 15 }}>
              We sent a 6-digit code to your email. It works for 10 minutes.
            </p>
          ) : mode === "setup" ? (
            <p className="lede" style={{ fontSize: 15 }}>
              This app has one owner: you. Choose a password, then confirm your email with the code we send.{emailHint ? ` Use ${emailHint}.` : ""}
            </p>
          ) : null}
        </div>

        {step.kind === "form" && (
          <label className="field">
            Email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
        )}
        {step.kind === "form" && mode !== "forgot" && (
          <label className="field">
            Password
            <input type="password" autoComplete={mode === "setup" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
            {mode === "setup" && <span className="xs muted" style={{ fontWeight: 400 }}>At least 10 characters. A short sentence works well.</span>}
          </label>
        )}
        {step.kind === "form" && mode === "setup" && (
          <label className="field">
            Password again
            <input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} required />
          </label>
        )}

        {step.kind === "code" && (
          <>
            {step.note && <div className="note warn small">{step.note}</div>}
            <label className="field">
              Code
              <input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ""))} autoFocus />
            </label>
            {step.purpose === "reset" && (
              <>
                <label className="field">
                  New password
                  <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
                <label className="field">
                  New password again
                  <input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
                </label>
              </>
            )}
          </>
        )}

        {error && (
          <div className="note err small" role="alert">
            {error}
          </div>
        )}
        <button className="btn ink" type="submit" disabled={busy} style={{ minHeight: 48 }}>
          {busy ? "One moment…" : step.kind === "code" ? (step.purpose === "reset" ? "Save new password" : "Confirm") : mode === "forgot" ? "Email me a code" : "Continue"}
        </button>
        <div className="row g12 wrap small">
          {step.kind === "code" && (
            <button type="button" className="btn link" onClick={() => restart(mode)}>
              Send a new code
            </button>
          )}
          {ownerExists && mode === "signin" && step.kind === "form" && (
            <button type="button" className="btn link" onClick={() => restart("forgot")}>
              Forgot your password?
            </button>
          )}
          {ownerExists && mode !== "signin" && (
            <button type="button" className="btn link" onClick={() => restart("signin")}>
              Back to sign in
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
