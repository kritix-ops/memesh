import { Logo, Sun } from '@memesh/brand';
import { StaffLoginForm, StaffSessionProvider, useStaffSession } from '@memesh/staff-auth';
import type { CSSProperties } from 'react';
import { AdminApp } from './admin/AdminApp';

// Thin shell for the admin surface. SSO is provided by the .memesh.co.il
// cookie scope: a signed-in staff member from staff.memesh.co.il is already
// authenticated here, so we never show a second login form to admin role.
// staff role is signed in but not authorized — they see a "no permission"
// screen with a one-click link back to the staff station.
//
// The customer surface is unreachable from any URL on this origin — by
// design. Anyone landing on admin.memesh.co.il lands on the admin app.

const STAFF_URL = import.meta.env.VITE_STAFF_URL ?? 'https://staff.memesh.co.il';

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
  // Admin and manager roles get the full admin surface. Cashier-level staff
  // hit the role-gate screen instead — the API still rejects their requests,
  // so this is UX, not security.
  if (state.user.role === 'cashier') return <NoPermission />;
  return <AdminApp />;
}

function NoPermission() {
  return (
    <main
      style={{
        maxWidth: 520,
        margin: '0 auto',
        padding: '96px 20px',
        textAlign: 'center',
        color: '#2d3436',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
        <Sun size={56} />
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 10 }}>אין הרשאה לאזור הניהול</div>
      <div style={{ color: '#636e72', fontSize: 15, marginBottom: 28 }}>
        אזור הניהול פתוח רק למשתמשי ניהול. עברו לעמדת הצוות כדי להמשיך לעבוד.
      </div>
      <a href={STAFF_URL} style={primaryLinkStyle}>
        מעבר לעמדת הצוות
      </a>
    </main>
  );
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

const primaryLinkStyle: CSSProperties = {
  display: 'inline-block',
  background: '#ffa983',
  color: '#fff',
  textDecoration: 'none',
  borderRadius: 10,
  padding: '12px 26px',
  fontWeight: 600,
  fontSize: 15,
};
