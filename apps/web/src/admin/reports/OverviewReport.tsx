import { useEffect, useState } from 'react';
import {
  getDashboardStats,
  getDormantCustomers,
  listStaffActions,
  type DashboardStats,
  type DormantCustomer,
  type StaffActionRow,
} from '../../lib/api/admin';
import { card, EmptyState, fmtDay, MUTED, SHADOW, StatTile } from './shared';

const fmtRelative = (iso: string, now = new Date()): string => {
  const t = new Date(iso).getTime();
  const diff = now.getTime() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'לפני רגע';
  if (m < 60) return `לפני ${m} דקות`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} שעות`;
  const d = Math.floor(h / 24);
  if (d < 7) return `לפני ${d} ימים`;
  return fmtDay(iso);
};

export function OverviewReport() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [dormant, setDormant] = useState<DormantCustomer[] | null>(null);
  const [actions, setActions] = useState<StaffActionRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, d, a] = await Promise.all([
        getDashboardStats(),
        getDormantCustomers(),
        listStaffActions(),
      ]);
      if (cancelled) return;
      if (s.ok) setStats(s.data.stats);
      if (d.ok) setDormant(d.data.customers);
      if (a.ok) setActions(a.data.actions);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <StatTile label="כניסות 24 שעות" value={stats?.entriesLast24h ?? '—'} />
        <StatTile label="כניסות 7 ימים" value={stats?.entriesLast7d ?? '—'} />
        <StatTile label="כניסות 30 ימים" value={stats?.entriesLast30d ?? '—'} />
        <StatTile label="כרטיסיות שנמכרו (30 ימים)" value={stats?.cardsSoldLast30d ?? '—'} />
        <StatTile label="פג תוקף ב-30 ימים הקרובים" value={stats?.expiringIn30d ?? '—'} />
        <StatTile label="לקוחות חדשים (7 ימים)" value={stats?.newCustomersLast7d ?? '—'} />
      </div>

      <div style={card}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>לקוחות שלא ביקרו 30+ ימים</div>
        {!dormant ? (
          <div style={{ color: MUTED, fontSize: 14, marginTop: 8 }}>טוען…</div>
        ) : dormant.length === 0 ? (
          <EmptyState>אין לקוחות רדומים — כל הלקוחות עם כרטיסיות פעילות ביקרו לאחרונה.</EmptyState>
        ) : (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {dormant.slice(0, 8).map((c, i) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderTop: i ? '1px solid #f3efea' : 'none',
                  fontSize: 14,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {c.firstName} {c.lastName}
                  </div>
                  <div style={{ fontSize: 12.5, color: MUTED }}>
                    {c.phone} · {c.customerNumber}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: MUTED }}>
                  ביקור אחרון: {c.lastVisit ? fmtDay(c.lastVisit) : 'אף פעם'}
                </div>
              </div>
            ))}
            {dormant.length > 8 && (
              <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>
                ועוד {dormant.length - 8} לקוחות. ניתן לסנן בדוח לקוחות.
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ ...card, boxShadow: SHADOW }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>יומן פעולות אחרונות</div>
        {!actions ? (
          <div style={{ color: MUTED, fontSize: 14, marginTop: 8 }}>טוען…</div>
        ) : actions.length === 0 ? (
          <EmptyState>אין פעולות עדיין.</EmptyState>
        ) : (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column' }}>
            {actions.slice(0, 12).map((a, i) => {
              const who =
                a.staffFirstName || a.staffLastName
                  ? `${a.staffFirstName ?? ''} ${a.staffLastName ?? ''}`.trim()
                  : 'מערכת';
              return (
                <div
                  key={a.id}
                  style={{
                    padding: '8px 0',
                    borderTop: i ? '1px solid #f3efea' : 'none',
                    fontSize: 13.5,
                  }}
                >
                  <div>
                    <strong>{who}</strong> · {a.summary}
                  </div>
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                    {fmtRelative(a.createdAt)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
