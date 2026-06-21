import { Logo } from '@memesh/brand';
import { CustomerSessionProvider } from '@memesh/customer-auth';
import type { CSSProperties } from 'react';
import { CheckoutComplete } from './customer/CheckoutComplete';
import { CustomerApp } from './customer/CustomerApp';

// Thin shell for the customer personal area. No staff/admin component is
// reachable from any path on this origin — by design. CustomerApp owns its
// own login UI (OTP) and its own sign-out button, so the shell only
// provides the brand chrome and the RTL container.
//
// One dedicated route exists in addition to the default landing: the
// WooCommerce post-checkout handoff at /checkout-complete. That page
// exchanges the URL token for a session cookie and forwards the buyer
// to the regular customer area. Anything else lands on CustomerApp.

const isCheckoutComplete = (): boolean =>
  typeof window !== 'undefined' && window.location.pathname === '/checkout-complete';

export function App() {
  return (
    <CustomerSessionProvider>
      <div dir="rtl" style={canvasStyle}>
        <header style={headerStyle}>
          <Logo />
        </header>
        {isCheckoutComplete() ? <CheckoutComplete /> : <CustomerApp />}
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
