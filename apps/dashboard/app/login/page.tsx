"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "../../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@demo.co");
  const [password, setPassword] = useState("admin12345");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { token } = await api<{ token: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(token);
      router.replace("/dashboard");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <form
        onSubmit={submit}
        style={{ width: 340, padding: 28, background: "#131c2e", borderRadius: 12, border: "1px solid #223" }}
      >
        <h1 style={{ marginTop: 0, fontSize: 22 }}>EmpTrack Admin</h1>
        <p style={{ color: "#8aa", marginTop: -6, fontSize: 13 }}>Sign in to your company dashboard</p>
        <label style={labelStyle}>Email</label>
        <input style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} />
        <label style={labelStyle}>Password</label>
        <input
          style={inputStyle}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p style={{ color: "#f87171", fontSize: 13 }}>{error}</p>}
        <button type="submit" disabled={loading} style={btnStyle}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

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
const btnStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 20,
  padding: "11px 12px",
  background: "#3b82f6",
  color: "white",
  border: "none",
  borderRadius: 8,
  fontWeight: 600,
  cursor: "pointer",
};
