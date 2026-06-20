import { Logo } from '@memesh/brand';
import { CustomerSessionProvider } from '@memesh/customer-auth';
import type { CSSProperties } from 'react';
import { CustomerApp } from './customer/CustomerApp';

// Thin shell for the customer personal area. No staff/admin component is
// reachable from any path on this origin — by design. CustomerApp owns its
// own login UI (OTP) and its own sign-out button, so the shell only
// provides the brand chrome and the RTL container.

export function App() {
  return (
    <CustomerSessionProvider>
      <div dir="rtl" style={canvasStyle}>
        <header style={headerStyle}>
          <Logo />
        </header>
        <CustomerApp />
      </div>
    </CustomerSessionProvider>
  );
}

const canvasStyle: CSSProperties = {
  minHeight: '100%',
  background: '#f9f9f9',
  color: '#2d3436',
};

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
