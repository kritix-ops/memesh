import { useState } from 'react';
import { AdminApp } from './admin/AdminApp';
import { Logo } from './brand';
import { CustomerApp } from './customer/CustomerApp';
import { PosApp } from './pos/PosApp';

type Surface = 'staff' | 'customer' | 'admin';

const TABS: { key: Surface; label: string }[] = [
  { key: 'staff', label: 'עמדת צוות' },
  { key: 'customer', label: 'אזור אישי' },
  { key: 'admin', label: 'ניהול' },
];

export function App() {
  const [surface, setSurface] = useState<Surface>('staff');
  return (
    <div dir="rtl" style={{ minHeight: '100%', background: '#f9f9f9', color: '#2d3436' }}>
      <header
        style={{
          background: '#fff',
          borderBottom: '1px solid #f0eae5',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          position: 'sticky',
          top: 0,
          zIndex: 30,
        }}
      >
        <Logo />
        <div
          style={{
            display: 'flex',
            gap: 6,
            background: '#fff4ee',
            padding: 5,
            borderRadius: 12,
            border: '1px solid #ffe3d4',
          }}
        >
          {TABS.map((t) => {
            const active = surface === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setSurface(t.key)}
                style={{
                  border: 'none',
                  cursor: 'pointer',
                  borderRadius: 9,
                  padding: '8px 16px',
                  fontWeight: 600,
                  fontSize: 14,
                  background: active ? '#fff' : 'transparent',
                  color: active ? '#2d3436' : '#a98d7d',
                  boxShadow: active ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </header>
      {surface === 'staff' && <PosApp />}
      {surface === 'customer' && <CustomerApp />}
      {surface === 'admin' && <AdminApp />}
    </div>
  );
}
