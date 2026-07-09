import { type CSSProperties, useState } from 'react';
import { CancellationsReport } from './CancellationsReport';
import { CardsReport } from './CardsReport';
import { CustomersReport } from './CustomersReport';
import { EntriesReport } from './EntriesReport';
import { OverviewReport } from './OverviewReport';
import { RevenueReport } from './RevenueReport';
import { TicketsReport } from './TicketsReport';
import { card as cardStyle, MUTED, ORANGE, SHADOW } from './shared';

type SectionKey =
  | 'overview'
  | 'customers'
  | 'cards'
  | 'tickets'
  | 'entries'
  | 'cancellations'
  | 'revenue';

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'overview', label: 'סקירה' },
  { key: 'customers', label: 'לקוחות' },
  { key: 'cards', label: 'כרטיסיות' },
  { key: 'tickets', label: 'כרטיסים' },
  { key: 'entries', label: 'כניסות' },
  { key: 'cancellations', label: 'ביטולים' },
  { key: 'revenue', label: 'הכנסות' },
];

const subNavStyle = (active: boolean): CSSProperties => ({
  display: 'block',
  width: '100%',
  textAlign: 'right',
  background: active ? '#fff4ee' : 'transparent',
  color: active ? '#c97a52' : MUTED,
  border: 'none',
  borderRadius: 10,
  padding: '10px 12px',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  position: 'relative',
  paddingInlineStart: 26,
});

const dotStyle = (active: boolean): CSSProperties => ({
  position: 'absolute',
  insetInlineStart: 10,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 8,
  height: 8,
  borderRadius: 4,
  background: active ? ORANGE : '#dfe3e3',
});

export function Reports() {
  const [active, setActive] = useState<SectionKey>('overview');
  return (
    <div
      style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}
      className="no-print"
    >
      <nav
        className="no-print"
        style={{
          ...cardStyle,
          padding: 10,
          width: 200,
          flexShrink: 0,
          alignSelf: 'flex-start',
          boxShadow: SHADOW,
        }}
        aria-label="דוחות"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => {
              console.info('[web reports] view', { section: s.key });
              setActive(s.key);
            }}
            style={subNavStyle(active === s.key)}
            aria-current={active === s.key ? 'page' : undefined}
          >
            <span style={dotStyle(active === s.key)} />
            {s.label}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, minWidth: 0 }}>
        {active === 'overview' && <OverviewReport />}
        {active === 'customers' && <CustomersReport />}
        {active === 'cards' && <CardsReport />}
        {active === 'tickets' && <TicketsReport />}
        {active === 'entries' && <EntriesReport />}
        {active === 'cancellations' && <CancellationsReport />}
        {active === 'revenue' && <RevenueReport />}
      </div>
    </div>
  );
}
