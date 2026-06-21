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

// The WordPress marketing/shop site. Both the logo (left-of-RTL = visual
// right) and the explicit "shop" button on the other end of the header
// route here, so the customer area never feels like a one-way street.
const MAIN_SITE_URL = 'https://memesh.co.il';

const isCheckoutComplete = (): boolean =>
  typeof window !== 'undefined' && window.location.pathname === '/checkout-complete';

export function App() {
  return (
    <CustomerSessionProvider>
      <div dir="rtl" style={canvasStyle}>
        <header style={headerStyle}>
          <a href={MAIN_SITE_URL} style={logoLinkStyle} aria-label="לאתר הראשי של ממש">
            <Logo />
          </a>
          <a href={MAIN_SITE_URL} style={backLinkStyle}>
            <HomeGlyph />
            <span>לאתר הראשי</span>
          </a>
        </header>
        {isCheckoutComplete() ? <CheckoutComplete /> : <CustomerApp />}
      </div>
    </CustomerSessionProvider>
  );
}

// Inline SVG so the button looks identical on every browser/OS — no
// emoji fallback fonts, no Unicode arrow that flips weirdly in RTL.
// The glyph is a soft outline of a house; the brand orange matches the
// border/accent colors elsewhere in the shell.
function HomeGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
    </svg>
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

const logoLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  textDecoration: 'none',
  color: 'inherit',
  cursor: 'pointer',
};

const backLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  background: '#fff4ee',
  border: '1.5px solid #ffe3d4',
  color: '#a98d7d',
  borderRadius: 9,
  padding: '8px 14px',
  fontWeight: 600,
  fontSize: 14,
  textDecoration: 'none',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
