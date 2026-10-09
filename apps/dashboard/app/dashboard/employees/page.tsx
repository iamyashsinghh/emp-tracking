"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { API_URL, DashboardUser, Role, usersApi } from "../../../lib/api";
import { Empty, ErrorText, muted, Section, Shell, tableStyle, Td, Th, useAuthGuard } from "../_components/ui";

const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"];
const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  EMPLOYEE: "Employee",
};

const inputStyle: React.CSSProperties = {
  background: "#0b1220",
  color: "#e6edf7",
  border: "1px solid #334",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 14,
  minWidth: 0,
};
const buttonStyle: React.CSSProperties = {
  background: "#2563eb",
  color: "white",
  border: 0,
  borderRadius: 6,
  padding: "8px 14px",
  fontSize: 14,
  cursor: "pointer",
};
const ghostButton: React.CSSProperties = {
  ...buttonStyle,
  background: "transparent",
  color: "#93c5fd",
  border: "1px solid #334",
  padding: "6px 10px",
  fontSize: 13,
};

interface IssuedToken {
  userName: string;
  enrollmentToken: string;
}

export default function EmployeesPage() {
  const claims = useAuthGuard();
  const isAdmin = !!claims && ADMIN_ROLES.includes(claims.role);
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await usersApi.list());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (claims) void load();
  }, [claims, load]);

  async function issueToken(u: DashboardUser) {
    setBusyUser(u.id);
    setError(null);
    try {
      const { enrollmentToken } = await usersApi.createDevice(u.id);
      setIssued({ userName: u.name, enrollmentToken });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyUser(null);
    }
  }

  return (
    <Shell title="Employees" claims={claims}>
      <ErrorText error={error} />
      {claims && !isAdmin && <Empty>Only admins can add employees and devices.</Empty>}

      {isAdmin && (
        <AddEmployee
          canCreateAdmin={claims!.role === "SUPER_ADMIN"}
          onCreated={async (u) => {
            await load();
            await issueToken(u);
          }}
          onError={setError}
        />
      )}

      {issued && <TokenCard token={issued} onClose={() => setIssued(null)} />}

      <Section title={`People (${users.length})`}>
        {users.length === 0 ? (
          <Empty>No employees yet.</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                {isAdmin && <Th />}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <Td>{u.name}</Td>
                  <Td>{u.email}</Td>
                  <Td>{ROLE_LABEL[u.role] ?? u.role}</Td>
                  <Td>{u.isActive ? "Active" : <span style={{ color: muted }}>Deactivated</span>}</Td>
                  {isAdmin && (
                    <Td>
                      {u.isActive && (
                        <button style={ghostButton} disabled={busyUser === u.id} onClick={() => issueToken(u)}>
                          {busyUser === u.id ? "Generating…" : "Add device"}
                        </button>
                      )}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </Shell>
  );
}

function AddEmployee({
  canCreateAdmin,
  onCreated,
  onError,
}: {
  canCreateAdmin: boolean;
  onCreated: (u: DashboardUser) => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Exclude<Role, "SUPER_ADMIN">>("EMPLOYEE");
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return onError("Password must be at least 8 characters.");
    setSaving(true);
    onError(null);
    try {
      const created = await usersApi.create({ name: name.trim(), email: email.trim(), password, role });
      setName("");
      setEmail("");
      setPassword("");
      await onCreated({ ...created, isActive: true, createdAt: new Date().toISOString() });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Add employee">
      <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
        <input style={inputStyle} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input style={inputStyle} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          style={inputStyle}
          type="password"
          placeholder="Password (min 8)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        <select style={inputStyle} value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, "SUPER_ADMIN">)}>
          <option value="EMPLOYEE">Employee</option>
          <option value="MANAGER">Manager</option>
          {canCreateAdmin && <option value="ADMIN">Admin</option>}
        </select>
        <button type="submit" style={buttonStyle} disabled={saving}>
          {saving ? "Adding…" : "Add & create device token"}
        </button>
      </form>
      <p style={{ color: muted, fontSize: 12, marginBottom: 0 }}>
        Adding an employee also generates a one-time device token for their computer.
      </p>
    </Section>
  );
}

function TokenCard({ token, onClose }: { token: IssuedToken; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied(null);
    }
  };
  return (
    <Section
      title={`Device token for ${token.userName}`}
      action={
        <button style={ghostButton} onClick={onClose}>
          Done
        </button>
      }
    >
      <p style={{ margin: "0 0 12px", color: muted, fontSize: 14 }}>
        Install the EmpTrack Agent on the employee&apos;s computer and enter these on first launch. The token works once and is not
        shown again.
      </p>
      {[
        { label: "Server URL", value: API_URL },
        { label: "Enrollment token", value: token.enrollmentToken },
      ].map((row) => (
        <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ color: muted, fontSize: 13, width: 130 }}>{row.label}</span>
          <code style={{ background: "#0b1220", padding: "6px 10px", borderRadius: 6, wordBreak: "break-all", flex: 1 }}>{row.value}</code>
          <button style={ghostButton} onClick={() => copy(row.label, row.value)}>
            {copied === row.label ? "Copied" : "Copy"}
          </button>
        </div>
      ))}
    </Section>
  );
}
