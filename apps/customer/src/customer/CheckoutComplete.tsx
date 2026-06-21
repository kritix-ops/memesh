import { Sun } from '@memesh/brand';
import { verifyHandoffToken, type HandoffThankyou } from '@memesh/customer-auth';
import { useEffect, useState, type CSSProperties } from 'react';

// Landing page after a successful WooCommerce checkout. The WP plugin
// redirects the buyer here with ?token=<raw>, we exchange it for a session
// cookie, then we sit on a Hebrew thank-you card with a CTA into the personal
// area. The customer clicks when they're ready — no auto-redirect.
//
// Three states:
//   loading   - verifying the token (~300ms in the happy path)
//   ready     - cookie is set, thank-you card rendered with CTA
//   failed    - token consumed/expired/invalid; the page nudges the customer
//               toward OTP login (the CTA goes to / which shows the OTP form
//               because no cookie was set).
//
// The thank-you copy comes from the API response (rendered server-side from
// card_settings, so Yanay can edit it from admin → Settings → דף תודה without
// shipping a frontend change).

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; thankyou: HandoffThankyou }
  | { kind: 'failed'; error: string };

export function CheckoutComplete() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      // Always strip the token from the URL once we've read it — single-use
      // tokens have no business sitting in browser history.
      if (token) window.history.replaceState({}, '', '/checkout-complete');

      if (!token) {
        if (!cancelled) setState({ kind: 'failed', error: 'no_token' });
        return;
      }
      console.info('[checkout-complete] exchanging token', { tokenLength: token.length });
      const res = await verifyHandoffToken(token);
      if (cancelled) return;
      if (res.ok) {
        console.info('[checkout-complete] handoff verified', {
          customerNumber: res.data.profile.customerNumber,
        });
        setState({ kind: 'ready', thankyou: res.data.thankyou });
      } else {
        console.warn('[checkout-complete] handoff rejected', {
          status: res.status,
          error: res.error,
        });
        setState({ kind: 'failed', error: res.error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') return <LoadingCard />;
  if (state.kind === 'ready') return <ReadyCard thankyou={state.thankyou} />;
  return <FailedCard />;
}

function LoadingCard() {
  return (
    <main style={pageStyle}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Sun size={56} spin />
        </div>
        <div style={titleStyle}>משלים התחברות…</div>
        <div style={subtitleStyle}>הכרטיסייה שלך כבר כמעט שם.</div>
      </Card>
    </main>
  );
}

function ReadyCard({ thankyou }: { thankyou: HandoffThankyou }) {
  return (
    <main style={pageStyle}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Sun size={64} />
        </div>
        <h1 style={readyTitleStyle}>{thankyou.title}</h1>
        <p style={bodyStyle}>{thankyou.body}</p>
        <a href="/" style={ctaStyle}>
          {thankyou.buttonText}
        </a>
      </Card>
    </main>
  );
}

function FailedCard() {
  // The token was already consumed / expired / never valid. The customer's
  // purchase still went through (WP wouldn't redirect them here otherwise);
  // we just can't auto-sign them in, so we send them to /, which renders
  // the OTP login form. Direct, honest, no error noise.
  return (
    <main style={pageStyle}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Sun size={56} />
        </div>
        <h1 style={readyTitleStyle}>תודה רבה על הרכישה! 🎉</h1>
        <p style={bodyStyle}>
          הקישור האוטומטי כבר נוצל או פג תוקפו. כדי לראות את הכרטיסייה החדשה שלך,
          היכנסו לאזור האישי עם מספר הטלפון שלכם וקוד SMS חד-פעמי.
        </p>
        <a href="/" style={ctaStyle}>
          כניסה לאזור האישי
        </a>
      </Card>
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div style={cardStyle}>{children}</div>;
}

const pageStyle: CSSProperties = {
  maxWidth: 480,
  margin: '0 auto',
  padding: '64px 20px',
  textAlign: 'center',
};

const cardStyle: CSSProperties = {
  background: '#fff',
  borderRadius: 18,
  boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
  padding: '40px 28px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 16,
};

const titleStyle: CSSProperties = {
  marginTop: 24,
  fontSize: 20,
  fontWeight: 600,
  color: '#2d3436',
};

const subtitleStyle: CSSProperties = {
  marginTop: 0,
  fontSize: 14,
  color: '#636e72',
};

const readyTitleStyle: CSSProperties = {
  margin: '8px 0 0',
  fontSize: 26,
  fontWeight: 700,
  color: '#2d3436',
  lineHeight: 1.25,
};

const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  color: '#636e72',
  lineHeight: 1.55,
};

const ctaStyle: CSSProperties = {
  marginTop: 12,
  display: 'inline-block',
  background: '#ffa983',
  color: '#fff',
  textDecoration: 'none',
  borderRadius: 12,
  padding: '16px 28px',
  fontWeight: 700,
  fontSize: 17,
  textAlign: 'center',
};
