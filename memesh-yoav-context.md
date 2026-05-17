# הקשר מלא למערכת ממש – לקלוד של יואב

## מי אני ומה אנחנו בונים

אני יואב, מפתח AI. אחי ינאי מפעיל משחקייה פנים עירונית בשם **ממש** (memesh.co.il) ברמת השרון לילדים גיל 0–6. אנחנו בונים מערכת ניהול מלאה שתחליף את Amelia Booking ואת Vollstart Event Tickets – שתי מערכות מסחריות שכרגע מנהלות את החוגים והכרטיסים.

**המשימה הנוכחית:** חיבור WooCommerce → Backend חדש. ברגע שלקוח קונה כרטיס/כרטיסייה באתר, ה-backend מקבל webhook, יוצר QR מאובטח, ושולח SMS ללקוח.

---

## Stack קיים באתר (לא נוגעים בו)

- **WordPress** + Elementor Pro על Cloudways
- **WooCommerce** + שער תשלום **Meshulam/Grow** (ישראכרט)
- **Cloudflare** (CDN + DNS)
- **Redis Object Cache Pro**
- תוסף מותאם: `memesh-customer-area` (PHP) – אזור אישי לקוח קיים, ייוחלף בעתיד ב-React SPA
- **אין webhooks קיימים ב-WooCommerce** – שדה נקי

---

## מוצרי WooCommerce – IDs ולוגיקה עסקית

| Product ID | שם מוצר | סוג | לוגיקה |
|---|---|---|---|
| 300 | כרטיס כניסה ליחיד/ה עד גיל 6 + מבוגר/ת מלווה | `child_single` | תקף יום אחד (יום הניקוב בלבד) |
| 304 | כרטיס כניסה לתינוק/ת + מבוגר/ת מלווה | `baby_single` | תקף יום אחד (יום הניקוב בלבד) |
| 305 | כרטיס כניסה למלווה שני/ה | `companion` | תמיד נרכש יחד עם 300/304/306; מקסימום אחד לכל הזמנה |
| 306 | כרטיסייה – משלמים על 10 כניסות ומקבלים 12 | `punch_card` | 12 כניסות, תוקף שנה מיום הרכישה, מלווה כלול בכל כניסה |

### חוקים עסקיים קריטיים:
1. **כרטיסים 300/304** – תקפים יום ניקוב בלבד. לא תאריך תפוגה קשיח, אלא: ברגע שנוקבים – תקף עד חצות של אותו יום.
2. **כרטיסייה 306** – `expires_at = created_at + 365 days`. 12 כניסות, כל כניסה = ילד + מלווה אחד.
3. **כרטיס 305 (מלווה)** – לא עומד לבד. תמיד מלווה 300/304/306. הלוגיקה: בכל הזמנה שיש 305, חפש גם 300/304/306 וקשר אליו. אם יש 305 בלי כרטיס ראשי – שגיאה.
4. **מקסימום מלווה אחד נוסף** לכל כרטיס/כרטיסייה. האתר כבר אוכף זאת, אבל ה-backend צריך לאמת גם.

---

## אבטחת QR – HMAC-SHA256

### רקע חשוב:
ניתחנו את שיטת ה-QR של Vollstart (שהמערכת הקיימת משתמשת בה). הם משתמשים ב-CRC32 על ticket_id + timestamp. **זה חלש** – ניתן לפצח. המערכת החדשה תשתמש ב-HMAC-SHA256.

### מבנה ה-QR Token:

```
payload = ticket_id + "|" + user_id + "|" + created_ts + "|" + serial
signature = HMAC-SHA256(payload, SERVER_SECRET_KEY)
qr_token = base64url(payload + "." + signature)
```

### פרמטרים:
- `ticket_id` – UUID
- `user_id` – UUID של הלקוח (מ-WP user ID)
- `created_ts` – Unix timestamp ברגע יצירת הכרטיס
- `serial` – מספר ידידותי לאדם בפורמט: `M-YYYYMMDD-NNNN` (למשל: `M-20260517-0042`)
- `SERVER_SECRET_KEY` – נשמר ב-env בלבד, לעולם לא מועבר ללקוח
- `key_id` – מזהה המפתח (לתמיכה ב-key rotation)

### אימות בניקוב:
1. פענוח base64url → הפרדת payload ו-signature
2. חישוב HMAC מחדש → השוואה constant-time (`crypto.timingSafeEqual`)
3. בדיקת תוקף (לכרטיס יומי: האם `redeemed_date == today`?)
4. בדיקת `is_active`
5. יצירת `Redemption` record

---

## מבנה DB המומלץ

### טבלת `tickets`:
```sql
CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wp_order_id VARCHAR NOT NULL,
  wp_user_id INT NOT NULL,
  wc_product_id INT NOT NULL,
  ticket_type VARCHAR NOT NULL, -- child_single | baby_single | companion | punch_card
  qr_token VARCHAR UNIQUE NOT NULL,
  serial_number VARCHAR UNIQUE NOT NULL, -- M-YYYYMMDD-NNNN
  total_entries INT, -- NULL לכרטיס יומי; 12 לכרטיסייה
  used_entries INT DEFAULT 0,
  companion_ticket_id UUID REFERENCES tickets(id), -- קשר מלווה → ראשי
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP, -- NULL לכרטיס יומי; +1yr לכרטיסייה
  source VARCHAR DEFAULT 'online', -- online | pos | manual
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID REFERENCES tickets(id),
  redeemed_by_staff_id UUID,
  pos_terminal_id VARCHAR,
  method VARCHAR, -- qr_scan | serial | phone_lookup | manual
  companion_count INT DEFAULT 1,
  redeemed_at TIMESTAMP DEFAULT now(),
  is_offline_sync BOOLEAN DEFAULT false,
  notes TEXT
);
```

---

## פלואו ה-Webhook המדויק

```
WooCommerce: order.status = "completed"
       ↓
POST /webhooks/woocommerce/order-completed
  Header: X-WC-Webhook-Signature: <HMAC-SHA256>
  Body: WC Order Object (JSON)
       ↓
Backend: אימות חתימת webhook (HMAC-SHA256 על body גולמי)
       ↓
ריצה על כל line_item בהזמנה:
  - product_id ∈ [300, 304, 306] → צור ticket
  - product_id == 305 → שמור בצד, תקשר לכרטיס ראשי בסוף
  - product_id אחר → התעלם
       ↓
לכל ticket שנוצר:
  - חשב serial: M-{YYYYMMDD}-{padded counter}
  - חשב qr_token: HMAC-SHA256 כנ"ל
  - שמור ב-DB
       ↓
שלח SMS ללקוח (Twilio / Vonage):
  "היי {שם}! הכרטיס שלך לממש מוכן 🎉
   מספר: {serial}
   QR: {link}/ticket/{qr_token}
   כניסות: {total_entries או 'יומי'}"
       ↓
החזר 200 OK ל-WooCommerce (חשוב! WC מנסה שוב אם לא מקבל 200)
```

---

## מה ינאי יוסיף ב-WordPress

ינאי יוסיף את ה-webhook ידנית (הוא לא מעביר גישת מנהל):

`WooCommerce → Settings → Advanced → Webhooks → יצירת Webhook חדש`

- **שם:** Memesh Backend – Order Completed
- **סטטוס:** פעיל
- **נושא:** Order completed
- **Delivery URL:** `{URL שתיתן}`
- **Secret:** `{SECRET שתיתן}`
- **API Version:** WP REST API Integration v3

---

## מידע על הלקוח בתוך ה-WC Webhook

ה-payload של WC order.completed מכיל:
```json
{
  "id": 12345,
  "status": "completed",
  "billing": {
    "first_name": "...",
    "last_name": "...",
    "email": "...",
    "phone": "..."
  },
  "customer_id": 67,
  "line_items": [
    {
      "id": 1,
      "product_id": 300,
      "name": "כרטיס כניסה ליחיד/ה...",
      "quantity": 1,
      "price": "55"
    }
  ],
  "date_created": "2026-05-17T10:00:00"
}
```

ה-`customer_id` הוא ה-WordPress user ID – זה הקשר ל-WP users.

---

## מה עוד קיים ורלוונטי

- **תוסף `memesh-customer-area`** (PHP/WP): כרגע מציג ללקוח את הכרטיסים שלו מ-Vollstart. בשלב הראשון הוא ממשיך לעבוד במקביל – אין conflict. בעתיד ייוחלף ב-SPA.
- **Code Snippets Pro**: כל ה-JS/PHP המותאם של האתר נמצא שם (לא ב-child theme).
- **Meshulam/Grow**: מעבד התשלום. WC מקבל callback מ-Meshulam → משנה סטטוס הזמנה ל-completed → מופעל ה-webhook שלנו.
- **שני קופות פיזיות** (AccuPOS Android) – בשלב הזה לא נוגעים בהן, זה שלב הבא.

---

## שאלות שצריך לסגור לפני שמתחילים

1. **URL של ה-endpoint** – איפה ה-backend רץ? מה הכתובת המלאה?
2. **Webhook secret** – תייצר ו/או תשלח לינאי להזין ב-WC
3. **SMS provider** – Twilio? Vonage? יש account?
4. **DB** – PostgreSQL? SQLite? Supabase? מה הבחירה?
5. **Serial counter** – איך מנהלים אותו? atomic counter ב-DB (recommended: `SEQUENCE` ב-Postgres)
6. **מה קורה אם webhook נכשל?** – WC שולח שוב עד 5 פעמים. ה-endpoint חייב להיות idempotent (בדיקת `wp_order_id` כדי לא ליצור כפילויות)

---

## Idempotency – חשוב מאוד

WooCommerce ינסה לשלוח את ה-webhook שוב אם לא מקבל 200. לכן:

```python
# בתחילת הטיפול ב-webhook:
existing = db.query("SELECT id FROM tickets WHERE wp_order_id = %s", [order_id])
if existing:
    return {"status": "already_processed"}, 200  # החזר 200 ואל תעשה כלום

# רק אם לא קיים – צור את הכרטיסים
```

---

זה הכל לשלב הנוכחי. ברגע שה-URL והסוד מוכנים – ינאי מוסיף תוך דקה.
