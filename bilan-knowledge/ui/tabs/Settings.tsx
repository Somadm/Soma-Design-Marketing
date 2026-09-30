import { useEffect, useState } from "react";
import { api, type Settings } from "../api";
import { PName, PLATFORMS, useData } from "../lib";

interface SettingsResponse {
  settings: Settings;
  domains: { meta: string[]; tiktok: string[] };
}

export function SettingsTab() {
  const { data } = useData(() => api<SettingsResponse>("/api/settings"), []);
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);
  if (!data || !form) return <div className="card muted">Loading…</div>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setForm({ ...form, [k]: v });
    setSaved(false);
  };
  const save = async () => {
    setError(null);
    try {
      const r = await api<{ settings: Settings }>("/api/settings", {
        method: "PUT",
        body: {
          run_window_utc: form.run_window_utc,
          retries: Number(form.retries),
          budget_refresh_usd: Number(form.budget_refresh_usd),
          budget_initial_usd: Number(form.budget_initial_usd),
          budget_live_month_usd: Number(form.budget_live_month_usd),
          on_limit: form.on_limit,
          alert_email: form.alert_email ?? "",
          campaign_profile: form.campaign_profile,
        },
      });
      setForm(r.settings);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="settings">
      <div className="card">
        <h3>Schedule</h3>
        <div className="fields">
          <div className="field">
            <label>Refresh interval</label>
            <div className="fixed">{form.interval_days} days after last successful refresh</div>
          </div>
          <div className="field">
            <label htmlFor="win">Run window (UTC)</label>
            <input id="win" className="input" value={form.run_window_utc} onChange={(e) => set("run_window_utc", e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ret">Retries per source</label>
            <input id="ret" className="input" type="number" min={1} max={6} value={form.retries} onChange={(e) => set("retries", Number(e.target.value))} />
          </div>
          <div className="field">
            <label>Backoff between attempts</label>
            <div className="fixed">{form.backoff_minutes.map((m) => `${m} min`).join(", ")}</div>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          An incomplete refresh is re-attempted once a day for up to {form.retries} days. The {form.interval_days}-day clock only resets after a complete refresh.
        </p>
      </div>

      <div className="card">
        <h3>Research spending limits</h3>
        <div className="muted">Covers AI research and page retrieval. Hosting is billed separately.</div>
        <div className="fields">
          {(
            [
              ["budget_refresh_usd", "Per scheduled refresh (USD)", "Typical run: $2–$3.50"],
              ["budget_initial_usd", "Initial research (USD)", "One-off: about $8–$12"],
              ["budget_live_month_usd", "Live checks per month (USD)", "About $0.02–$0.05 per check"],
            ] as const
          ).map(([k, label, hint]) => (
            <div key={k} className="field">
              <label htmlFor={k}>{label}</label>
              <input id={k} className="input" type="number" min={0} step="0.5" value={form[k]} onChange={(e) => set(k, Number(e.target.value))} />
              <span className="small muted">{hint}</span>
            </div>
          ))}
        </div>
        <div className="field" style={{ marginTop: 16 }}>
          <label>When a limit is reached</label>
          <div className="row">
            {(
              [
                ["stop", "Stop and mark incomplete"],
                ["finish", "Finish current source, then stop"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={`opt${form.on_limit === k ? " active" : ""}`} onClick={() => set("on_limit", k)}>{label}</button>
            ))}
          </div>
          <span className="small muted">Either way the run is marked incomplete and current guidance is not replaced.</span>
        </div>
      </div>

      <div className="card">
        <h3>Official source domains</h3>
        <div className="grid-2" style={{ marginTop: 12 }}>
          {PLATFORMS.map((p) => (
            <div key={p} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <PName p={p} />
              {data.domains[p].map((d) => <div key={d}>{d}</div>)}
            </div>
          ))}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>Third-party pages can suggest leads to check but are never stored as current guidance.</p>
      </div>

      <div className="card">
        <h3>Creative Academy profile</h3>
        <div className="muted">Used for “For Creative Academy” notes and the briefing.</div>
        <textarea className="input" style={{ marginTop: 12 }} value={form.campaign_profile} onChange={(e) => set("campaign_profile", e.target.value)} />
      </div>

      <div className="card">
        <h3>Alerts</h3>
        <div className="field" style={{ marginTop: 12, maxWidth: 360 }}>
          <label htmlFor="email">Email when a refresh fails or is incomplete</label>
          <input id="email" className="input" type="email" placeholder="sabah@example.com" value={form.alert_email ?? ""} onChange={(e) => set("alert_email", e.target.value)} />
        </div>
      </div>

      <div className="card row" style={{ justifyContent: "space-between" }}>
        <div>
          <h3>Publishing and spend changes</h3>
          <div className="muted">Off for knowledge updates. Not configurable here.</div>
        </div>
        <span className="locked">Locked</span>
      </div>

      <div className="row">
        <button className="btn btn-primary" onClick={save}>Save settings</button>
        {saved ? <span className="toast">Saved. Applies from the next run.</span> : null}
        {error ? <span className="error-text">{error}</span> : null}
      </div>
    </div>
  );
}
