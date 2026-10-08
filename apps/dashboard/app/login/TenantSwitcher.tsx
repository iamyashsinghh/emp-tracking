"use client";

import { canSwitchTenant, setActiveTenant, useSession } from "../../lib/api";

/**
 * Company switcher for the dashboard header. Renders nothing unless the
 * signed-in user can see more than one company.
 *
 * By default the page reloads after a switch so every view refetches with the
 * new tenant; pass `onSwitched` to handle it in place instead (e.g. by keying
 * data fetches on `useSession()?.activeTenantId`).
 */
export function TenantSwitcher({ onSwitched }: { onSwitched?: (tenantId: string) => void }) {
  const session = useSession();
  if (!session || !canSwitchTenant(session)) return null;

  function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    setActiveTenant(id);
    if (onSwitched) onSwitched(id);
    else window.location.reload();
  }

  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "#9ab" }}>
      Company
      <select
        aria-label="Active company"
        value={session.activeTenantId}
        onChange={change}
        style={{
          padding: "7px 10px",
          background: "#0b1220",
          color: "#e6edf7",
          border: "1px solid #334",
          borderRadius: 8,
          fontSize: 14,
        }}
      >
        {session.tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export default TenantSwitcher;
