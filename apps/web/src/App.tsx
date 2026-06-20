import { useState, type CSSProperties } from 'react';
import { AdminApp } from './admin/AdminApp';
import { Logo, Sun } from './brand';
import { CustomerApp } from './customer/CustomerApp';
import { CustomerSessionProvider } from './lib/customer-session';
import { StaffSessionProvider, useStaffSession } from './lib/staff-session';
import { PosApp } from './pos/PosApp';
import { StaffLoginForm } from './pos/StaffLoginForm';

type Surface = 'staff' | 'customer' | 'admin';

const TABS: { key: Surface; label: string }[] = [
  { key: 'staff', label: 'עמדת צוות' },
  { key: 'customer', label: 'אזור אישי' },
  { key: 'admin', label: 'ניהול' },
];

export function App() {
  return (
    <StaffSessionProvider>
      <CustomerSessionProvider>
        <AppShell />
      </CustomerSessionProvider>
    </StaffSessionProvider>
  );
}

function AppShell() {
  const [surface, setSurface] = useState<Surface>('staff');
  const { state, signOut } = useStaffSession();
  const requiresStaffAuth = surface === 'staff' || surface === 'admin';
  const signedIn = state.status === 'signed-in';

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
        {requiresStaffAuth && signedIn ? (
          <button onClick={signOut} style={headerActionStyle} aria-label="התנתק">
            התנתק
          </button>
        ) : (
          <div style={{ width: 0 }} />
        )}
      </header>
      <SurfaceBody surface={surface} />
    </div>
  );
}

function SurfaceBody({ surface }: { surface: Surface }) {
  const { state } = useStaffSession();
  if (surface === 'customer') return <CustomerApp />;

  if (state.status === 'loading') return <LoadingShell />;
  if (state.status === 'signed-out') return <StaffLoginForm />;
  if (surface === 'staff') return <PosApp />;
  return <AdminApp />;
}

function LoadingShell() {
  return (
    <main
      style={{
        maxWidth: 920,
        margin: '0 auto',
        padding: '96px 20px',
        textAlign: 'center',
        color: '#636e72',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Sun size={48} />
      </div>
      <div style={{ marginTop: 16, fontSize: 15 }}>טוען…</div>
    </main>
  );
}

const headerActionStyle: CSSProperties = {
  border: '1.5px solid #e9e0d9',
  background: '#fff',
  color: '#636e72',
  borderRadius: 9,
  padding: '8px 14px',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
};
