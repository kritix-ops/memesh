# ממש – Super Brief מעודכן
## מערכת ניהול כרטיסיות – Phase 1
### גרסה 3.0 | מאי 2026 | לשימוש פנימי

---

## עדכון ביחס לגרסאות קודמות

| מה השתנה | למה |
|---|---|
| ❌ אינטגרציית AccuPOS בוטלה | AP לא משתפי פעולה, API לא זמין |
| ✅ מערכת עצמאית standalone | לא תלויה ב-WooCommerce לניהול הכרטיסיות |
| ✅ Phase 1: כרטיסיות בלבד | כרטיסי כניסה בודדים = שלמים במקום + חותמת יד, אין ערך לדיגיטציה עכשיו |
| ✅ iPad-first לצוות בקופה | עובדים מזינים פרטים מאייפד או מכל דפדפן |
| ✅ סינכרון ל-WordPress | כל לקוח חדש במערכת → נוצר גם כ-WP user |

---

## מה המערכת עושה – בגדול

מערכת web-based שרצה על שרת ממש, נגישה מכל דפדפן ומותאמת לאייפד.

היא עושה שלושה דברים:

1. **קופאי/עובד רושם לקוח** + מוכר לו כרטיסייה (12 כניסות)
2. **לקוח בכניסה** – קופאי סורק QR, המערכת מנקבת כניסה ומציגת כמה נשאר
3. **לקוח מהבית** – נכנס לאזור אישי, רואה כמה כניסות נותרו, מעדכן פרטים

---

## 1. הקשר עסקי

**ממש** = משחקייה פנים עירונית, רמת השרון, גיל 0–6.

**Stack קיים (נשאר בעינו):**
- WordPress + Elementor Pro + WooCommerce על Cloudways
- Meshulam/Grow לתשלומי אתר
- AccuPOS לסליקת אשראי פיזית (נשאר, אבל ללא אינטגרציה)
- Cloudflare + Redis Object Cache Pro

**מה המערכת החדשה לא עושה:**
- לא מחליפה את AccuPOS לסליקה
- לא מנהלת כרטיסי כניסה בודדים (אלה נמכרים במקום, חותמת יד, אין צורך במעקב)
- לא מנהלת חוגים – זה שלב הבא

---

## 2. מוצרים רלוונטיים ל-Phase 1

| Product ID (WC) | מוצר | בשימוש במערכת החדשה? |
|---|---|---|
| 306 | כרטיסייה 12 כניסות (משלמים 10) | ✅ כן – הלב של המערכת |
| 300 | כרטיס כניסה ליחיד/ה + מלווה | ❌ לא – שלמים במקום, חותמת |
| 304 | כרטיס כניסה לתינוק/ת + מלווה | ❌ לא – שלמים במקום, חותמת |
| 305 | כרטיס מלווה שני/ה | ❌ לא – מוכרים במקום בקופה |

### כרטיסייה 306 – חוקים עסקיים:
- 12 כניסות במחיר 10
- כל כניסה = ילד אחד + מלווה אחד
- תוקף: שנה מיום הרכישה
- ניתן לרכוש: פיזית בקופה (שלב 1) + דרך האתר/WC (שלב הבא)
- מלווה שני: אפשרי רק אם אושר ידנית בקופה, לא מוגבל טכנית (רק פיזית)

---

## 3. פרופיל לקוח – שדות

### שדות חובה (בכל רישום):
- שם פרטי + שם משפחה
- מספר טלפון (גם username לכניסה)

### שדות מומלצים (ממלאים אם אפשר):
- מייל (לשליחת QR + עדכונים)
- ערוץ תקשורת מועדף: SMS / WhatsApp / מייל

### שדות אופציונליים (עם הסכמת ההורה):
- ילדים: שם + תאריך לידה (לשימוש בהמשך: יום הולדת, מבצעים, חוגים לפי גיל)

### שדות פנימיים (נראים לצוות בלבד, לא ללקוח):
- הערות פנימיות (למשל: "לקוח VIP", "בעיה בעבר", "קיבל חריגה")
- תאריך הצטרפות (אוטומטי)
- מי רשם אותו (staff_id)
- מקור הגעה: המלצה / רשתות חברתיות / עבר ליד / אחר (לצורכי מרקטינג)

### שדות אוטומטיים:
- מספר לקוח (L-NNNN)
- סטטוס: פעיל / מוקפא / VIP
- סה״כ ביקורים
- תאריך ביקור אחרון

---

## 4. כרטיסיות – מבנה ב-DB

```sql
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_number VARCHAR UNIQUE, -- L-0001, L-0002...
  wp_user_id INT, -- אם נוצר ב-WordPress
  first_name VARCHAR NOT NULL,
  last_name VARCHAR NOT NULL,
  phone VARCHAR UNIQUE NOT NULL, -- גם login identifier
  email VARCHAR,
  preferred_channel VARCHAR DEFAULT 'sms', -- sms | whatsapp | email
  children JSONB DEFAULT '[]', -- [{name, dob}]
  internal_notes TEXT, -- צוות בלבד
  source VARCHAR, -- referral | social | walk_by | website | other
  status VARCHAR DEFAULT 'active', -- active | frozen | vip
  registered_by UUID, -- staff_id
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE punch_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  wc_order_id VARCHAR, -- אם נרכש דרך WooCommerce
  serial_number VARCHAR UNIQUE NOT NULL, -- M-YYYYMMDD-NNNN
  qr_token VARCHAR UNIQUE NOT NULL, -- HMAC-SHA256 signed
  total_entries INT NOT NULL DEFAULT 12,
  used_entries INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP NOT NULL, -- created_at + 365 days
  source VARCHAR DEFAULT 'pos', -- pos | online | manual
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE punch_card_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  punch_card_id UUID REFERENCES punch_cards(id),
  punched_by UUID REFERENCES staff(id),
  method VARCHAR, -- qr_scan | serial | phone | manual
  companion_count INT DEFAULT 1,
  notes TEXT,
  punched_at TIMESTAMP DEFAULT now()
);

CREATE TABLE staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR,
  last_name VARCHAR,
  phone VARCHAR UNIQUE,
  email VARCHAR,
  role VARCHAR, -- admin | manager | cashier
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);
```

---

## 5. אבטחת QR

זהה לגרסה הקודמת – HMAC-SHA256:

```
payload   = punch_card_id + "|" + customer_id + "|" + created_ts + "|" + serial
signature = HMAC-SHA256(payload, SERVER_SECRET)
qr_token  = base64url(payload + "." + signature)
```

**אימות בניקוב:**
1. פענוח + אימות חתימה (`crypto.timingSafeEqual`)
2. בדיקת `is_active` + תוקף `expires_at`
3. בדיקת `used_entries < total_entries`
4. כתיבת `punch_card_entry` + עדכון `used_entries++`
5. אם `used_entries == total_entries` → `is_active = false`

**Fallback (אם QR לא עובד):**
- חיפוש לפי serial: `M-YYYYMMDD-NNNN`
- חיפוש לפי טלפון → רשימת כרטיסיות פעילות → בחירה ידנית

---

## 6. ממשקי המשתמש

### 6.1 ממשק קופאי / צוות (iPad + דפדפן)

**דף ראשי – 3 פעולות גדולות וברורות:**
```
[ 🔍 חפש לקוח ]  [ ➕ לקוח חדש ]  [ 📷 סרוק QR ]
```

**חיפוש לקוח:**
- חיפוש לפי שם / טלפון / מספר לקוח
- תוצאות מיידיות (debounce 300ms)
- לחיצה → כרטיס לקוח עם כרטיסיות פעילות

**כרטיס לקוח (Staff view):**
- שם + טלפון + תמונת QR הכרטיסייה הפעילה
- כניסות נותרות (גדול וברור: "נותרו 8 מתוך 12")
- כפתור "נקב כניסה" (עם אישור: "כמה מלווים?")
- היסטוריית כניסות אחרונות
- עריכת פרטי לקוח + הערות פנימיות

**רישום לקוח חדש:**
- טופס פשוט, מותאם לאייפד (שדות גדולים, מקלדת נוחה)
- שם + טלפון = חובה, שאר = אופציונלי
- כפתור "שמור ומכור כרטיסייה" – מייד אחרי רישום

**מכירת כרטיסייה:**
- בחירת סוג (כרגע רק 12 כניסות)
- אישור מחיר
- סליקה דרך AccuPOS (ידנית – הקופאי סולק ב-AP, אז לוחץ "אושר" במערכת שלנו)
- המערכת יוצרת כרטיסייה + QR + שולחת SMS ללקוח

**סריקת QR (ניקוב מהיר):**
- פתיחת מצלמה
- סריקה → תוצאה מיידית (✅ שם לקוח + נותרו X כניסות / ❌ סיבת דחייה)
- אישור עם "כמה מלווים?" (1 = ברירת מחדל)
- ניקוב

### 6.2 אזור אישי ללקוח (web, mobile-first)

- **כניסה:** מספר טלפון + OTP (SMS) – ללא סיסמה
- **מה רואה:**
  - כרטיסיות פעילות: כניסות נותרות + QR + תאריך תפוגה
  - היסטוריית כניסות (תאריך + שעה)
  - כרטיסיות שפגו תוקף
- **מה יכול לערוך:**
  - שם, מייל, ילדים, ערוץ תקשורת מועדף
  - לא: טלפון (זה ה-ID שלו – רק צוות יכול לשנות)

### 6.3 Admin Panel (מנהל / אדמין)

**דשבורד:**
- כניסות היום / השבוע / החודש
- כרטיסיות שנמכרו
- כרטיסיות שעומדות לפוג תוקף ב-30 יום הקרובים
- לקוחות חדשים השבוע

**ניהול לקוחות:**
- טבלה עם search + filter
- פתיחת לקוח → כל הפרטים + היסטוריה + עריכה + הקפאה

**ניהול כרטיסיות:**
- כל הכרטיסיות: פעילות / פגות / מבוטלות
- יצירה ידנית (manual) לצורכי תיקון / מתנה
- ביטול כרטיסייה + הערה

**ניהול צוות:**
- הוספת / הסרת staff
- הרשאות לפי תפקיד
- לוג פעולות (מי נקב, מתי, באיזה כרטיסייה)

**דוחות:**
- הכנסות לפי תקופה
- ניצול כרטיסיות (ממוצע כניסות לפני תפוגה)
- לקוחות שלא ביקרו 30+ יום

---

## 7. סינכרון ל-WordPress

כשנרשם לקוח חדש במערכת:

```
POST /wp-json/wp/v2/users  (WP REST API)
{
  "username": phone,
  "email": email || phone + "@memesh.local",
  "first_name": ...,
  "last_name": ...,
  "password": random_secure_password,
  "roles": ["subscriber"]
}
```

→ שמור `wp_user_id` ב-customers table.

**למה:** לקוח שיקנה אונליין בעתיד דרך WooCommerce יהיה כבר מזוהה, וה-webhook יוכל לשייך את הכרטיסייה לאותו לקוח.

**הפוך:** כשלקוח קונה דרך WooCommerce (בעתיד) → webhook מחפש לפי `customer_id` → אם קיים ב-customers table – מקשר, אם לא – יוצר.

---

## 8. Tech Stack מומלץ

| שכבה | טכנולוגיה | הערה |
|---|---|---|
| Backend | Node.js + Express / FastAPI | מוכר ל-Yoav |
| DB | PostgreSQL | על Cloudways – כבר שם |
| Auth – Staff | JWT + refresh tokens | |
| Auth – לקוח | Phone + OTP (SMS) | ללא סיסמה |
| Frontend | React + TypeScript | Admin + Customer Area |
| CSS | Tailwind | מהיר לפיתוח, responsive |
| QR Generation | `qrcode` npm / Python lib | Server-side |
| QR Scanning | `@zxing/browser` | Camera API בדפדפן |
| SMS | Twilio / Vonage Israel | OTP + הודעות |
| Email | Resend / Mailgun | |
| Hosting | Cloudways (כבר קיים) | Docker container חדש |
| WP Sync | WP REST API + JWT Auth plugin | |

---

## 9. פלואו מרכזי – מכירה פיזית + ניקוב

### מכירה:
```
קופאי מחפש לקוח (טלפון / שם)
         ↓
    לקוח קיים?
   כן ↙      ↘ לא
פותח כרטיס    רישום מהיר (שם + טלפון)
         ↓
   מוכר כרטיסייה
         ↓
  סליקה ב-AccuPOS (ידנית)
         ↓
  לוחץ "אושר" במערכת
         ↓
  המערכת יוצרת punch_card + QR
         ↓
  SMS ללקוח עם QR + serial
```

### ניקוב:
```
קופאי סורק QR / מחפש לקוח
         ↓
  Backend מאמת HMAC
         ↓
   תקין? פעיל? יש כניסות?
  כן ↙             ↘ לא
"כמה מלווים?"    הצגת שגיאה + סיבה
         ↓
  ניקוב + עדכון used_entries
         ↓
  "✅ {שם} – נותרו X מתוך 12"
```

---

## 10. שאלות פתוחות לסגור

1. **SMS provider** – Twilio? יש account? Vonage Israel?
2. **Domain / subdomain** – המערכת תשב על `pos.memesh.co.il`? `app.memesh.co.il`?
3. **OTP timeout** – כמה דקות בתוקף? (מומלץ: 5 דקות)
4. **מה קורה אם לקוח שכח טלפון?** – איפוס דרך מייל? רק צוות יכול?
5. **האם הצוות צריך OTP לכניסה** או user/password רגיל?
6. **הדפסת QR** – האם רוצים להדפיס פיזית (נייר) בנוסף ל-SMS?

---

## 📋 TLDR – מה המערכת עושה (לפני שצוללים)

**ממש** מפעילה משחקייה לילדים עם מערכת כרטיסיות: לקוח קונה כרטיסייה ל-12 כניסות, ובכל ביקור מנקבים כניסה אחת.

**המערכת שנבנה היא web app אחד שעושה שלושה דברים:**

**① קופה (על אייפד)** — עובד ממש מחפש לקוח לפי שם/טלפון, רושם לקוח חדש, מוכר כרטיסייה (סליקה עצמאית דרך AccuPOS, ואז אישור ידני במערכת). בכניסה פיזית — סורק QR מהטלפון של הלקוח ומנקב כניסה.

**② אזור אישי ללקוח (מהנייד/בית)** — הלקוח נכנס עם מספר טלפון + קוד SMS, רואה כמה כניסות נותרו בכרטיסייה שלו, מתי היה בפעם האחרונה, ויכול לעדכן פרטים אישיים.

**③ Admin Panel (מנהל)** — תצוגה מלאה על כל הלקוחות, הכרטיסיות, הכניסות, הדוחות, וניהול צוות. כולל התראה אוטומטית על כרטיסיות שעומדות לפוג.

**מה לא בשלב זה:** חוגים, הזמנות מראש, כרטיסי כניסה בודדים (אלה ממשיכים להימכר פיזית עם חותמת יד).

**טכנית:** React frontend + Node/Python backend + PostgreSQL, רץ על שרת Cloudways הקיים. מסתנכרן עם WordPress כדי שכל לקוח חדש יהיה גם WP user לשימוש עתידי.

---

## 11. עיצוב ומיתוג

### צבעי ממש

| שם | HEX | שימוש |
|---|---|---|
| כתום ראשי | `#ffa983` | כפתורים ראשיים, הדגשות, CTA |
| ירוק משני | `#c4d898` | אישורים, הצלחות, כפתורים משניים |
| כהה | `#2d3436` | טקסט ראשי, כותרות |
| אפור | `#636e72` | טקסט משני, תוויות, placeholders |
| רקע | `#f9f9f9` | רקע דפים |
| לבן | `#ffffff` | כרטיסים, modals, אזורי תוכן |

### פונט
- **פלוני (Ploni)** – הפונט הרשמי של ממש, זמין ב-3 משקלים:
  - 300 (Light): טקסט רץ, תיאורים
  - 400 (Regular): body text
  - 600 (DemiBold): כותרות, כפתורים, מספרים חשובים
- קבצי הפונט זמינים ב: `https://memesh.co.il/wp-content/uploads/2025/12/`
  - `ploni-light-aaa.woff2`
  - `ploni-regular-aaa.woff2`
  - `ploni-demibold-aaa.woff2`

### סגנון כללי
- **70% מינימליסטי, 30% משחקי** – ממשק נקי ומקצועי עם חמימות
- RTL מלא – כל הממשק בעברית ימין-לשמאל
- **ללא אימוג'ים בשום מקום** – לא בטקסטים, לא בהתראות, לא בכפתורים
- עיגולי פינות: `border-radius: 12–16px` לכרטיסים, `8–10px` לכפתורים
- צללים עדינים: `box-shadow: 0 4px 20px rgba(0,0,0,0.08)`
- אנימציות קצרות: `transition: 0.2–0.3s ease`

### קומפוננטים מרכזיים

**כפתור ראשי:**
```css
background: #ffa983;
color: #ffffff;
border-radius: 10px;
font-weight: 600;
padding: 14px 28px;
```

**כפתור אישור / הצלחה:**
```css
background: #c4d898;
color: #ffffff;
```

**כרטיס / Card:**
```css
background: #ffffff;
border-radius: 16px;
box-shadow: 0 4px 20px rgba(0,0,0,0.08);
padding: 20px;
```

**שדה קלט:**
```css
border: 2px solid #e0e0e0;
border-radius: 8px;
font-size: 16px; /* חשוב למניעת zoom באייפד */
padding: 12px 16px;
```

**תצוגת "נותרו X כניסות" (אלמנט מרכזי בממשק הקופה):**
```css
font-size: 48px;
font-weight: 600;
color: #ffa983;
/* X קטן ואפור: */
font-size: 18px;
color: #636e72;
```

### התאמה לאייפד
- גודל מינימלי לאלמנטים הניתנים ללחיצה: `44x44px`
- שדות טופס: `font-size: 16px` (מונע auto-zoom של Safari)
- layout: Grid / Flexbox responsive, breakpoint ראשי ב-768px
- כפתורי הפעולה הראשיים (נקב / מכור): גדולים במיוחד, ממלאים את הרוחב

---

## 12. אבטחת QR – יצירה מאובטחת מפני מניפולציות

### הבעיה

מערכת ה-QR הקיימת (Vollstart) משתמשת ב-CRC32 על ticket_id + timestamp. **ניתחנו ופרצנו את השיטה** – ניתן לחשב QR תקין עבור כרטיס שלא קיים. המערכת החדשה חייבת להיות חסינה לחלוטין.

### הפתרון – HMAC-SHA256

**QR לא מכיל מידע עצמאי. הוא רק מצביע לשרת. השרת הוא האמת היחידה.**

```
payload   = punch_card_id + "|" + customer_id + "|" + created_ts + "|" + serial
signature = HMAC-SHA256(payload, SERVER_SECRET_KEY)
qr_token  = base64url(payload + "." + signature)
```

**מה זה אומר בפועל:**
- בלי ה-`SERVER_SECRET_KEY` (שנשמר רק ב-env של השרת) – **אי אפשר לייצר QR תקין**
- כל שינוי בpayload (אפילו תו אחד) → חתימה שגויה → נדחה
- אין הבדל אם מישהו רואה את ה-QR – הוא לא יכול ליצור QR דומה אחר

### מבנה Serial Number

פורמט: `M-YYYYMMDD-NNNN`

דוגמה: `M-20260517-0042`

- `M` – קידומת ממש
- `YYYYMMDD` – תאריך יצירת הכרטיסייה
- `NNNN` – counter אטומי מה-DB (SEQUENCE ב-Postgres)

**למה חשוב:** Serial הוא fallback ידידותי לאדם כשה-QR לא עובד. הוא לא סודי, אבל גם אי אפשר לנחש serial שלא קיים – השרת מאמת שה-serial קיים ב-DB לפני כל פעולה.

### שכבות הגנה נוספות

**1. Rate Limiting על ניסיונות סריקה:**
```
מקסימום 10 סריקות/דקה לכל IP
מקסימום 3 כישלונות רצופים → חסימה זמנית של 5 דקות
```

**2. Replay Protection לכרטיסי כניסה בודדים (עתיד):**
- נוסף `nonce` חד-פעמי לpayload
- לאחר ניקוב – ה-nonce נשרף, לא ניתן לסרוק שוב באותו יום

**3. כרטיסייה – הגנה כפולה:**
- `used_entries < total_entries` חייב להיות true
- כתיבת `punch_card_entry` בתוך DB transaction אטומית
- אם שתי סריקות מגיעות בו-זמנית (race condition): `SELECT FOR UPDATE` על השורה

**4. Key Rotation:**
```
qr_token = base64url(key_id + "." + payload + "." + signature)
```
- `key_id` מאפשר להחזיק מספר מפתחות פעילים בו-זמנית
- ניתן לפרוש מפתח ישן בהדרגה מבלי לבטל כרטיסיות קיימות

**5. Audit Log מלא:**
```sql
-- כל ניסיון סריקה נרשם, גם כושלים
CREATE TABLE scan_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_token_hash VARCHAR, -- hash של הtoken (לא הtoken עצמו)
  result VARCHAR, -- success | invalid_signature | expired | exhausted | not_found
  ip_address VARCHAR,
  terminal_id VARCHAR,
  attempted_at TIMESTAMP DEFAULT now()
);
```
- מאפשר לזהות ניסיונות מתקפה
- לא שומרים את ה-token עצמו (רק hash) לפרטיות

### סיכום – מה שמישהו זדוני יכול לנסות, ולמה זה לא יעבוד

| ניסיון מתקפה | למה נכשל |
|---|---|
| לנחש QR של כרטיסייה שלא קנה | HMAC-SHA256 – בלי SECRET אי אפשר |
| לשנות את מספר הכניסות ב-QR | כל שינוי בpayload → חתימה שגויה |
| להעתיק QR של מישהו אחר ולנקב פעמיים | used_entries מונה בDB, atomic transaction |
| לנסות serials אקראיים | Rate limiting + serial חייב להתאים לDB |
| לנסות לקרוא את ה-SECRET מה-QR | הSECRET לא נמצא בQR בשום שלב |

