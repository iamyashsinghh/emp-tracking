"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  Session,
  canSwitchTenant,
  getSession,
  login,
  logout,
  refreshSession,
  setActiveTenant,
} from "../../lib/api";

/** Only allow same-origin relative redirects after sign-in. */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

type Step = "loading" | "credentials" | "company";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("loading");
  const [session, setSessionState] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Shown only when the email exists in more than one company.
  const [needsCompany, setNeedsCompany] = useState(false);
  const [tenantSlug, setTenantSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in: `/login?switch=1` opens the company picker, anything
  // else goes straight to the app.
  useEffect(() => {
    const existing = getSession();
    if (!existing) {
      setStep("credentials");
      return;
    }
    const wantsSwitch = new URLSearchParams(window.location.search).has("switch");
    if (!wantsSwitch) {
      router.replace(nextPath());
      return;
    }
    refreshSession()
      .then((s) => {
        if (s && canSwitchTenant(s)) {
          setSessionState(s);
          setStep("company");
        } else {
          router.replace(nextPath());
        }
      })
      .catch(() => setStep("credentials"));
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await login(email.trim(), password, needsCompany ? tenantSlug.trim() : undefined);
      if (canSwitchTenant(s)) {
        setSessionState(s);
        setStep("company");
      } else {
        router.replace(nextPath());
      }
    } catch (err) {
      if (err instanceof ApiError && err.needsCompany) {
        setNeedsCompany(true);
        setError("This email is used in more than one company. Enter the company ID to continue.");
      } else if (err instanceof ApiError && err.isUnauthorized) {
        setError(needsCompany ? "Invalid email, password or company" : "Invalid email or password");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  function chooseCompany(tenantId: string) {
    setActiveTenant(tenantId);
    router.replace(nextPath());
  }

  function switchAccount() {
    logout();
    setSessionState(null);
    setPassword("");
    setStep("credentials");
  }

  if (step === "loading") {
    return <main style={{ padding: 40 }}>Loading…</main>;
  }

  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 16, boxSizing: "border-box" }}>
      {step === "credentials" ? (
        <form onSubmit={submit} style={cardStyle} noValidate>
          <h1 style={{ marginTop: 0, fontSize: 22 }}>EmpTrack Admin</h1>
          <p style={subStyle}>Sign in to your company dashboard</p>
          <label style={labelStyle} htmlFor="email">
            Email
          </label>
          <input
            id="email"
            style={inputStyle}
            type="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label style={labelStyle} htmlFor="password">
            Password
          </label>
          <input
            id="password"
            style={inputStyle}
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {needsCompany && (
            <>
              <label style={labelStyle} htmlFor="tenantSlug">
                Company ID
              </label>
              <input
                id="tenantSlug"
                style={inputStyle}
                autoComplete="organization"
                autoCapitalize="none"
                placeholder="e.g. acme"
                autoFocus
                required
                value={tenantSlug}
                onChange={(e) => setTenantSlug(e.target.value.toLowerCase())}
              />
            </>
          )}
          {error && (
            <p role="alert" style={{ color: "#f87171", fontSize: 13, marginBottom: 0 }}>
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || !email || !password || (needsCompany && !tenantSlug)}
            style={btnStyle(busy || !email || !password || (needsCompany && !tenantSlug))}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : (
        session && (
          <div style={cardStyle}>
            <h1 style={{ marginTop: 0, fontSize: 22 }}>Choose a company</h1>
            <p style={subStyle}>
              Signed in as {session.user.name || session.user.email}. You can switch any time from the header.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: "16px 0 0", display: "grid", gap: 8 }}>
              {session.tenants.map((t) => {
                const active = t.id === session.activeTenantId;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => chooseCompany(t.id)}
                      style={{
                        ...companyBtnStyle,
                        borderColor: active ? "#3b82f6" : "#334",
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{t.name}</span>
                      <span style={{ color: "#8aa", fontSize: 12 }}>
                        {t._count ? `${t._count.users} users · ${t._count.devices} devices` : t.slug}
                        {active ? " · last used" : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button type="button" onClick={switchAccount} style={linkBtnStyle}>
              Use a different account
            </button>
          </div>
        )
      )}
    </main>
  );
}

const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 380,
  padding: 28,
  background: "#131c2e",
  borderRadius: 12,
  border: "1px solid #223",
  boxSizing: "border-box",
};
const subStyle: React.CSSProperties = { color: "#8aa", marginTop: -6, fontSize: 13 };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "#9ab", marginTop: 14 };
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  marginTop: 4,
  background: "#0b1220",
  border: "1px solid #334",
  borderRadius: 8,
  color: "#e6edf7",
  boxSizing: "border-box",
};
const btnStyle = (disabled: boolean): React.CSSProperties => ({
  width: "100%",
  marginTop: 20,
  padding: "11px 12px",
  background: "#3b82f6",
  color: "white",
  border: "none",
  borderRadius: 8,
  fontWeight: 600,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
});
const companyBtnStyle: React.CSSProperties = {
  width: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  padding: "12px 14px",
  background: "#0b1220",
  color: "#e6edf7",
  border: "1px solid #334",
  borderRadius: 8,
  cursor: "pointer",
  textAlign: "left",
};
const linkBtnStyle: React.CSSProperties = {
  marginTop: 16,
  background: "none",
  border: "none",
  color: "#9ab",
  fontSize: 13,
  cursor: "pointer",
  padding: 0,
};
