import { QRCodeSVG } from 'qrcode.react';
import { INK } from './tokens';

// Real, scannable QR for a punch card. Encodes the server-minted HMAC
// `qrToken` so the staff app's camera reader (`@yudiel/react-qr-scanner`)
// can decode it and resolve the card via /scan/lookup. Level 'M' is the
// sweet spot for the ~200-char token at customer-phone display sizes:
// 15% error correction survives glare and slight defocus, without
// pushing module size below the 2-px scanner threshold. The 4-module
// margin is mandatory per the QR spec for reliable finder detection.
//
// Lives in its own file (not brand.tsx) so the test runner can import it
// without pulling in the png-asset imports that brand.tsx needs.
interface MemeshQrProps {
  /** The HMAC-signed token to encode. Use `punchCard.qrToken`. */
  value: string;
  /** Rendered SVG side length in px. Defaults to 180 — large enough that
   *  a ~v10 symbol stays sharp on a customer's phone, small enough to
   *  fit the existing card layout. */
  size?: number;
  /** Accessible label. Defaults to a generic Hebrew string; callers can
   *  pass the serial for a more specific label. */
  title?: string;
}

export function MemeshQr({ value, size = 180, title = 'קוד QR של הכרטיסייה' }: MemeshQrProps) {
  return (
    <QRCodeSVG
      value={value}
      size={size}
      level="M"
      marginSize={4}
      bgColor="#FFFFFF"
      fgColor={INK}
      title={title}
    />
  );
}
