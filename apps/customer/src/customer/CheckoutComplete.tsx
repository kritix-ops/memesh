import { Sun } from '@memesh/brand';
import { verifyHandoffToken } from '@memesh/customer-auth';
import { useEffect, type CSSProperties } from 'react';

// Landing page for the WooCommerce checkout handoff. The WP plugin redirects
// the buyer to my.memesh.co.il/checkout-complete?token=<raw> after a paid
// order. This page:
//
//   1. Reads the token from the URL
//   2. POSTs it to /auth/customer/wc-handoff/verify (api.memesh.co.il)
//      → on success the API sets the customer_token cookie and returns the
//        profile; the buyer is now logged in.
//      → on failure (consumed, expired, garbage) the API returns 401.
//   3. Whichever outcome, immediately replaces the URL with '/' so the
//      single-use token doesn't sit in browser history, then hard-reloads
//      the page so the session provider re-hydrates from /me and the
//      customer lands in their personal area (or the OTP login form on
//      failure).
//
// We deliberately don't try to keep React state alive across the swap —
// reloading is the simplest path and the cookie carries the session for us.
// The page is on-screen for ~300ms in the happy path; longer if the network
// is slow.

export function CheckoutComplete() {
  useEffect(() => {
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (!token) {
        console.info('[checkout-complete] no token in URL, redirecting to /');
        window.location.replace('/');
        return;
      }
      console.info('[checkout-complete] exchanging token', {
        tokenLength: token.length,
      });
      const res = await verifyHandoffToken(token);
      if (res.ok) {
        console.info('[checkout-complete] handoff verified', {
          customerNumber: res.data.profile.customerNumber,
        });
      } else {
        console.warn('[checkout-complete] handoff rejected', {
          status: res.status,
          error: res.error,
        });
      }
      // Strip the token from history and do a clean reload. CustomerSession-
      // Provider will hydrate from /me, see the new cookie, and land the
      // user on their cards. On failure, the OTP login form takes over.
      window.location.replace('/');
    })();
  }, []);

  return (
    <main style={pageStyle}>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Sun size={56} spin />
      </div>
      <div style={titleStyle}>משלים התחברות…</div>
      <div style={subtitleStyle}>הכרטיסייה שלך כבר כמעט שם.</div>
    </main>
  );
}

const pageStyle: CSSProperties = {
  maxWidth: 420,
  margin: '0 auto',
  padding: '96px 20px',
  textAlign: 'center',
};

const titleStyle: CSSProperties = {
  marginTop: 24,
  fontSize: 20,
  fontWeight: 600,
  color: '#2d3436',
};

const subtitleStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 14,
  color: '#636e72',
};
