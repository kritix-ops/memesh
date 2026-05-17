import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WcOrderLineItem {
  id: number;
  product_id: number;
  name: string;
  quantity: number;
  price: string;
}

export interface WcOrderBilling {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
}

export interface WcOrderPayload {
  id: number;
  status: string;
  customer_id: number;
  billing: WcOrderBilling;
  line_items: WcOrderLineItem[];
  date_created?: string;
}

export const verifyWcSignature = (
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean => {
  if (!signatureHeader) return false;
  const expectedB64 = createHmac('sha256', secret).update(rawBody).digest('base64');
  const expectedBuf = Buffer.from(expectedB64, 'utf8');
  const actualBuf = Buffer.from(signatureHeader.trim(), 'utf8');
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
};
