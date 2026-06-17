import { type CSSProperties, type ReactNode, useState } from 'react';
import { avatar, fmtDate, fullName, initialCustomers, initials, statusBadge } from '../mock';

const ORANGE = '#ffa983';
const GREEN = '#c4d898';
const INK = '#2d3436';
const MUTED = '#636e72';
const SHADOW = '0 4px 20px rgba(0,0,0,0.08)';

const card: CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: SHADOW,
  padding: 20,
};

type View = 'dashboard' | 'customers' | 'cards' | 'staff' | 'reports';
const NAV: { key: View; label: string }[] = [
  { key: 'dashboard', label: 'לוח בקרה' },
  { key: 'customers', label: 'ניהול לקוחות' },
  { key: 'cards', label: 'ניהול כרטיסיות' },
  { key: 'staff', label: 'ניהול צוות' },
  { key: 'reports', label: 'דוחות' },
];

const STATS = [
  { label: 'כניסות היום', value: '38', delta: '+12% מאתמול', num: ORANGE },
  { label: 'כניסות השבוע', value: '214', delta: '+6% משבוע שעבר', num: INK },
  { label: 'כניסות החודש', value: '892', delta: 'יעד: 950', num: INK },
  { label: 'כרטיסיות שנמכרו', value: '46', delta: 'החודש', num: INK },
  { label: 'עומדות לפוג תוקף', value: '7', delta: '30 ימים קרובים', num: '#c97a52' },
  { label: 'לקוחות חדשים', value: '9', delta: 'השבוע', num: INK },
];

const WEEK = [
  { d: 'א', v: 28 },
  { d: 'ב', v: 34 },
  { d: 'ג', v: 38 },
  { d: 'ד', v: 22 },
  { d: 'ה', v: 41 },
  { d: 'ו', v: 46 },
  { d: 'ש', v: 5 },
];

const REVENUE = [
  { m: 'ינו', a: 9 },
  { m: 'פבר', a: 11 },
  { m: 'מרץ', a: 10 },
  { m: 'אפר', a: 13 },
  { m: 'מאי', a: 12 },
  { m: 'יוני', a: 15 },
];

const STAFF = [
  { name: 'מליה ברק', role: 'מנהלת המשחקייה', badge: 'אדמין', tone: 'admin' },
  { name: 'עידן רוזן', role: 'אחראי משמרת', badge: 'מנהל משמרת', tone: 'manager' },
  { name: 'שני דהן', role: 'קופאית', badge: 'קופאי', tone: 'cashier' },
  { name: 'אלמוג כץ', role: 'קופאי', badge: 'קופאי', tone: 'cashier' },
] as const;

const ACTION_LOG = [
  { who: 'שני דהן', action: 'ניקבה כניסה · נועה כהן', when: 'היום 16:32', dot: ORANGE },
  { who: 'עידן רוזן', action: 'מכר כרטיסייה · תמר פרידמן', when: 'היום 14:05', dot: GREEN },
  { who: 'שני דהן', action: 'ניקבה כניסה · רותם שגב', when: 'היום 11:20', dot: ORANGE },
  { who: 'מליה ברק', action: 'ביטלה כרטיסייה · יוסי מזרחי', when: 'אתמול 18:40', dot: '#c25a5a' },
  { who: 'אלמוג כץ', action: 'פתח לקוח חדש · מיכל אברהם', when: 'אתמול 10:15', dot: GREEN },
  { who: 'עידן רוזן', action: 'ניקב כניסה · דניאל לוי', when: 'אתמול 09:50', dot: ORANGE },
];

const roleStyle = (tone: string): { bg: string; color: string } => {
  if (tone === 'admin') return { bg: '#fff4ee', color: '#c97a52' };
  if (tone === 'manager') return { bg: '#f0f5e3', color: '#6f8f37' };
  return { bg: '#f1f2f2', color: MUTED };
};

type CardFilter = 'active' | 'expired' | 'cancelled';

export function AdminApp() {
  const [view, setView] = useState<View>('dashboard');
  const [query, setQuery] = useState('');
  const [cardFilter, setCardFilter] = useState<CardFilter>('active');

  return (
    <main
      style={{
        maxWidth: 1140,
        margin: '0 auto',
        padding: '24px 20px 64px',
        display: 'flex',
        gap: 20,
      }}
    >
      <nav style={{ ...card, width: 210, alignSelf: 'flex-start', padding: 10 }}>
        {NAV.map((n) => {
          const on = view === n.key;
          return (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                textAlign: 'right',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 10,
                padding: '11px 12px',
                fontWeight: 600,
                fontSize: 14.5,
                background: on ? '#fff4ee' : 'transparent',
                color: on ? '#c97a52' : MUTED,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  background: on ? ORANGE : '#dfe3e3',
                }}
              />
              {n.label}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1, minWidth: 0 }}>
        {view === 'dashboard' && <Dashboard />}
        {view === 'customers' && <Customers query={query} setQuery={setQuery} />}
        {view === 'cards' && <Cards filter={cardFilter} setFilter={setCardFilter} />}
        {view === 'staff' && <Staff />}
        {view === 'reports' && <Reports />}
      </div>
    </main>
  );
}

function Dashboard() {
  const wmax = Math.max(...WEEK.map((w) => w.v));
  const newcomers = [initialCustomers[4]!, initialCustomers[5]!, initialCustomers[2]!];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div
        style={{
          ...card,
          background: '#fff4ee',
          boxShadow: 'none',
          border: '1px solid #ffe3d4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontWeight: 600 }}>7 כרטיסיות עומדות לפוג תוקף ב-30 הימים הקרובים</div>
          <div style={{ color: MUTED, fontSize: 13.5, marginTop: 2 }}>
            כדאי לשלוח תזכורת ללקוחות לחידוש
          </div>
        </div>
        <span style={{ fontSize: 28, fontWeight: 600, color: '#c97a52' }}>7</span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))',
          gap: 14,
        }}
      >
        {STATS.map((s) => (
          <div key={s.label} style={card}>
            <div style={{ fontSize: 30, fontWeight: 600, color: s.num }}>{s.value}</div>
            <div style={{ fontSize: 13.5, marginTop: 2 }}>{s.label}</div>
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>{s.delta}</div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))',
          gap: 16,
        }}
      >
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 14 }}>כניסות לפי יום · השבוע</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 130 }}>
            {WEEK.map((b) => (
              <div
                key={b.d}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: `${Math.round((b.v / wmax) * 100)}%`,
                    background: b.v === wmax ? ORANGE : GREEN,
                    borderRadius: 8,
                    minHeight: 6,
                  }}
                />
                <span style={{ fontSize: 12.5, color: MUTED }}>{b.d}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>לקוחות חדשים השבוע</div>
          {newcomers.map((c) => {
            const a = avatar(c);
            return (
              <div
                key={c.id}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}
              >
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 11,
                    background: a.bg,
                    color: a.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 600,
                  }}
                >
                  {initials(c)}
                </div>
                <div style={{ flex: 1 }}>{fullName(c)}</div>
                <span style={{ fontSize: 12.5, color: MUTED }}>
                  {fmtDate(c.history[c.history.length - 1]?.date ?? c.expiry)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Customers({ query, setQuery }: { query: string; setQuery: (v: string) => void }) {
  const rows = initialCustomers.filter((c) => {
    const q = query.trim();
    if (!q) return true;
    return fullName(c).includes(q) || c.phone.includes(q) || c.id.includes(q);
  });
  return (
    <div style={card}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>ניהול לקוחות</div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש…"
          style={{
            fontSize: 15,
            padding: '9px 14px',
            border: '1.5px solid #e9e0d9',
            borderRadius: 10,
            outline: 'none',
            minWidth: 200,
          }}
        />
      </div>
      <Table head={['שם', 'מספר לקוח', 'כרטיסייה', 'סטטוס']}>
        {rows.map((c) => {
          const b = statusBadge(c.status);
          return (
            <tr key={c.id} style={{ borderTop: '1px solid #f3efea' }}>
              <Td>{fullName(c)}</Td>
              <Td muted>{c.id}</Td>
              <Td muted>
                {c.total - c.used} / {c.total}
              </Td>
              <Td>
                <Badge text={b.text} bg={b.bg} color={b.color} />
              </Td>
            </tr>
          );
        })}
      </Table>
    </div>
  );
}

function Cards({ filter, setFilter }: { filter: CardFilter; setFilter: (f: CardFilter) => void }) {
  const filters: { k: CardFilter; l: string }[] = [
    { k: 'active', l: 'פעילות' },
    { k: 'expired', l: 'שפגו' },
    { k: 'cancelled', l: 'בוטלו' },
  ];
  const rows =
    filter === 'cancelled'
      ? []
      : initialCustomers.filter((c) =>
          filter === 'expired' ? c.status === 'expired' : c.status !== 'expired',
        );
  return (
    <div style={card}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          {filters.map((f) => {
            const on = filter === f.k;
            return (
              <button
                key={f.k}
                onClick={() => setFilter(f.k)}
                style={{
                  border: `1.5px solid ${on ? ORANGE : '#e9e0d9'}`,
                  background: on ? '#fff4ee' : '#fff',
                  color: on ? '#c97a52' : MUTED,
                  borderRadius: 10,
                  padding: '8px 16px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {f.l}
              </button>
            );
          })}
        </div>
        <button
          style={{
            border: 'none',
            background: ORANGE,
            color: '#fff',
            borderRadius: 10,
            padding: '9px 18px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          יצירת כרטיסייה ידנית
        </button>
      </div>
      {rows.length === 0 ? (
        <div style={{ textAlign: 'center', color: MUTED, padding: '24px 0' }}>
          אין כרטיסיות בקטגוריה זו
        </div>
      ) : (
        <Table head={['מספר סידורי', 'לקוח', 'ניצול', 'תוקף', 'סטטוס']}>
          {rows.map((c) => {
            const b = statusBadge(c.status);
            return (
              <tr key={c.id} style={{ borderTop: '1px solid #f3efea' }}>
                <Td muted>{c.serial}</Td>
                <Td>{fullName(c)}</Td>
                <Td muted>
                  {c.used} / {c.total}
                </Td>
                <Td muted>{fmtDate(c.expiry)}</Td>
                <Td>
                  <Badge text={b.text} bg={b.bg} color={b.color} />
                </Td>
              </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}

function Staff() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))',
        gap: 16,
      }}
    >
      <div style={card}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 600 }}>צוות</div>
          <button
            style={{
              border: 'none',
              background: ORANGE,
              color: '#fff',
              borderRadius: 10,
              padding: '8px 16px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            הוספת איש צוות
          </button>
        </div>
        {STAFF.map((m, i) => {
          const r = roleStyle(m.tone);
          return (
            <div
              key={m.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 0',
                borderTop: i ? '1px solid #f3efea' : 'none',
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: r.bg,
                  color: r.color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                }}
              >
                {(m.name[0] ?? '') + (m.name.split(' ')[1]?.[0] ?? '')}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{m.name}</div>
                <div style={{ fontSize: 13, color: MUTED }}>{m.role}</div>
              </div>
              <Badge text={m.badge} bg={r.bg} color={r.color} />
            </div>
          );
        })}
      </div>
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>יומן פעולות</div>
        {ACTION_LOG.map((l, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 10,
              padding: '9px 0',
              borderTop: i ? '1px solid #f3efea' : 'none',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: l.dot,
                marginTop: 7,
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14 }}>
                <strong style={{ fontWeight: 600 }}>{l.who}</strong> · {l.action}
              </div>
              <div style={{ fontSize: 12.5, color: MUTED }}>{l.when}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Reports() {
  const rmax = Math.max(...REVENUE.map((r) => r.a));
  const dormant = [initialCustomers[3]!, initialCustomers[1]!];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 14 }}>הכנסות לפי חודש</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: 150 }}>
          {REVENUE.map((b) => (
            <div
              key={b.m}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span style={{ fontSize: 12, color: MUTED }}>₪{(b.a * 1000).toLocaleString()}</span>
              <div
                style={{
                  width: '100%',
                  height: `${Math.round((b.a / rmax) * 100)}%`,
                  background: b.a === rmax ? ORANGE : GREEN,
                  borderRadius: 8,
                  minHeight: 6,
                }}
              />
              <span style={{ fontSize: 12.5, color: MUTED }}>{b.m}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>ניצול כרטיסיות</div>
        <div style={{ color: MUTED, fontSize: 14 }}>
          ממוצע 7.5 כניסות נוצלו לפני פקיעה (מתוך 12)
        </div>
      </div>
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>לקוחות שלא ביקרו 30+ ימים</div>
        {dormant.map((c) => {
          const a = avatar(c);
          return (
            <div
              key={c.id}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0' }}
            >
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 11,
                  background: a.bg,
                  color: a.color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                }}
              >
                {initials(c)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{fullName(c)}</div>
                <div style={{ fontSize: 13, color: MUTED }}>{c.total - c.used} כניסות נותרו</div>
              </div>
              <span style={{ fontSize: 12.5, color: MUTED }}>
                ביקור אחרון {fmtDate(c.history[c.history.length - 1]?.date ?? c.expiry)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
      <thead>
        <tr>
          {head.map((h) => (
            <th
              key={h}
              style={{
                textAlign: 'right',
                color: MUTED,
                fontWeight: 600,
                fontSize: 13,
                padding: '0 0 8px',
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Td({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <td style={{ padding: '11px 0', color: muted ? MUTED : INK }}>{children}</td>;
}

function Badge({ text, bg, color }: { text: string; bg: string; color: string }) {
  return (
    <span style={{ fontSize: 12.5, background: bg, color, borderRadius: 8, padding: '4px 10px' }}>
      {text}
    </span>
  );
}
