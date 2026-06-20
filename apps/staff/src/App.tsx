import { Logo, Sun } from '@memesh/brand';
import { StaffLoginForm, StaffSessionProvider, useStaffSession } from '@memesh/staff-auth';
import type { CSSProperties } from 'react';
import { PosApp } from './pos/PosApp';

// Thin shell for the staff station. No tab switcher, no admin nav, no
// customer surface — by design. Anyone landing here lands on the POS.
// The admin surface lives at admin.memesh.co.il; the cookie scoped to
// .memesh.co.il (set by api.memesh.co.il in prod) carries SSO between the
// two so a staff member with admin role doesn't have to sign in twice.

export function App() {
  return (
    <StaffSessionProvider>
      <AppShell />
    </StaffSessionProvider>
  );
}

function AppShell() {
  const { state, signOut } = useStaffSession();
  const signedIn = state.status === 'signed-in';

  return (
    <div dir="rtl" style={{ minHeight: '100%', background: '#f9f9f9', color: '#2d3436' }}>
      <header style={headerStyle}>
        <Logo />
        {signedIn ? (
          <button onClick={signOut} style={headerActionStyle} aria-label="התנתק">
            התנתק
          </button>
        ) : (
          <div style={{ width: 0 }} />
        )}
      </header>
      <SurfaceBody />
    </div>
  );
}

function SurfaceBody() {
  const { state } = useStaffSession();
  if (state.status === 'loading') return <LoadingShell />;
  if (state.status === 'signed-out') return <StaffLoginForm />;
  return <PosApp />;
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

const headerStyle: CSSProperties = {
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
};

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
