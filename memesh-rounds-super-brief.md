# Super Brief — מערכת סבבי כניסה (Memesh Rounds)
### מפרט טכני מקיף לפיתוח · עבור יואב

> מסמך זה מניח היכרות עם מערכת הכרטיסיות הקיימת (`memesh-opal.vercel.app`, endpoint `/auth/customer/wc-handoff/mint`, מודל לקוחות, ברקודים מבוססי HMAC-SHA256). המערכת החדשה **מרחיבה** את הקיימת, לא מחליפה אותה.

---

## 0. עקרונות-על

1. **מקור אמת יחיד למלאי = מערכת הסבבים (לא WooCommerce).** WooCommerce משמש כצינור תשלום ושורות-הזמנה בלבד. מלאי, holds, וזמינות מנוהלים אך ורק בצד המערכת.
2. **המאגר (pool) נספר בילדים בלבד.** מלווים — כלולים או נוספים — לא צורכים קיבולת.
3. **Hold לפני תשלום הוא חובה ארכיטקטונית.** בלעדיו יש oversell. ה-hold נוצר ברגע הבחירה, לפני המעבר ל-WooCommerce.
4. **כל פרמטר תפעולי ניתן לקונפיגורציה מפאנל האדמין.** מספרים, שעות, קיבולת, מחירים, TTL, חלונות זמן — שום ערך לא hardcoded.
5. **שלב 1 = סבבי אחה"צ בלבד**, אבל הסכמה והקוד תומכים ב-N סבבים ביום ללא שינוי קוד — רק הגדרה.

---

## 1. טרמינולוגיה ומודל נתונים

### 1.1 ישויות ליבה

| ישות | תיאור |
|------|-------|
| `round` | הגדרת סבב חוזרת (תבנית): שם, שעת התחלה/סיום, ימים פעילים. למשל "אחה"צ 16:00–18:00". |
| `round_instance` | מימוש של סבב לתאריך ספציפי. נושא את הקיבולת בפועל (עם אפשרות override לחגים/אירועים). |
| `ticket_type` | סוג כרטיס: `child_under_walking` (₪45), `child_over_walking` (₪55). שניהם צורכים מהמאגר. |
| `companion` | מלווה. `included` (חינם, 1 לכל כרטיס) או `additional` (בתשלום, עד 1 לכל כרטיס). **לא צורך מהמאגר.** מינימום גיל נשלט מ-`companion_min_age` (ברירת מחדל 16). תפקיד: השגחה ואחריות על הילד בלבד. אח/ות מתחת ל-`companion_min_age` לא יכול/ה להיות מלווה. |
| `booking` | שיבוץ של לקוח לסבב. מחזיק סטטוס, ברקוד, TTL (אם hold), קישור להזמנת WC. |
| `waitlist_entry` | רישום לרשימת המתנה לסבב מלא. |
| `punch_card` | קיים. ניקוב משמש כתחליף תשלום. **טרנספרבילי לחלוטין** — בעל כרטיסייה יכול לנקב עבור כל אדם, ומותר לנקב N ניקובים בעסקה אחת (בכפוף ליתרה). מאפשר רכישה קבוצתית של כמה אמהות עם כרטיסייה משותפת. |
| `customer` | קיים. שימוש חוזר (טלפון, מייל, שם). |

### 1.2 סכמת DB מוצעת

> שמות טבלאות/שדות ניתנים להתאמה לקונבנציות הקיימות שלך. המבנה הוא העיקר.

```sql
-- הגדרות סבבים (תבניות חוזרות)
CREATE TABLE rounds (
    id              BIGINT PRIMARY KEY,
    label           VARCHAR(64),        -- 'morning' | 'afternoon' | 'evening' (תווית פנימית)
    display_name    VARCHAR(128),       -- "סבב אחר הצהריים" (מוצג ללקוח)
    start_time      TIME NOT NULL,      -- 16:00
    end_time        TIME NOT NULL,      -- 18:00
    days_active     SMALLINT,           -- bitmask ימים בשבוע (0=ראשון ... 6=שבת)
    default_capacity INT NOT NULL,      -- קיבולת ברירת מחדל (ילדים)
    is_active       BOOLEAN DEFAULT true,
    sort_order      INT DEFAULT 0
);

-- מימוש סבב לתאריך
CREATE TABLE round_instances (
    id              BIGINT PRIMARY KEY,
    round_id        BIGINT REFERENCES rounds(id),
    date            DATE NOT NULL,
    capacity        INT NOT NULL,       -- מועתק מ-default_capacity, ניתן ל-override
    is_closed       BOOLEAN DEFAULT false,  -- סגירה ידנית (אירוע פרטי וכו')
    UNIQUE (round_id, date)
);

-- שיבוצים (כולל holds — המצב נשמר ב-status)
CREATE TABLE bookings (
    id              BIGINT PRIMARY KEY,
    round_instance_id BIGINT REFERENCES round_instances(id),
    customer_id     BIGINT REFERENCES customers(id),
    ticket_type     VARCHAR(32) NOT NULL,   -- 'child_under_walking' | 'child_over_walking'
    additional_companions SMALLINT DEFAULT 0,  -- 0 או 1
    source          VARCHAR(16) NOT NULL,   -- 'paid' | 'punchcard' | 'gift' | 'manual'
    status          VARCHAR(16) NOT NULL,   -- 'held' | 'confirmed' | 'used' | 'cancelled' | 'expired'
    barcode_token   VARCHAR(128) UNIQUE,    -- נוצר רק במעבר ל-confirmed
    hold_expires_at TIMESTAMP NULL,         -- מאוכלס רק כש-status='held'
    wc_order_id     BIGINT NULL,
    punch_card_id   BIGINT NULL,            -- אם source='punchcard'
    gift_recipient  JSONB NULL,             -- אם source='gift' (ראה §7)
    created_at      TIMESTAMP DEFAULT now(),
    confirmed_at    TIMESTAMP NULL,
    used_at         TIMESTAMP NULL,
    INDEX (round_instance_id, status),
    INDEX (customer_id, status),
    INDEX (hold_expires_at) WHERE status = 'held'
);

-- רשימת המתנה
CREATE TABLE waitlist_entries (
    id              BIGINT PRIMARY KEY,
    round_instance_id BIGINT REFERENCES round_instances(id),
    customer_id     BIGINT REFERENCES customers(id),
    requested_type  VARCHAR(32),
    requested_companions SMALLINT DEFAULT 0,
    status          VARCHAR(16) NOT NULL,   -- 'waiting' | 'notified' | 'claimed' | 'expired' | 'cancelled'
    notified_at     TIMESTAMP NULL,
    claim_expires_at TIMESTAMP NULL,
    created_at      TIMESTAMP DEFAULT now(),
    INDEX (round_instance_id, status, created_at)  -- FIFO
);

-- קונפיגורציה גלובלית (key-value, נשלט מהאדמין)
CREATE TABLE settings (
    key             VARCHAR(64) PRIMARY KEY,
    value           JSONB
);
```

### 1.3 חישוב זמינות — הלב של המערכת

```
available(round_instance) =
    capacity
  − COUNT(bookings
          WHERE round_instance_id = ?
            AND ticket_type IN ('child_under_walking','child_over_walking')
            AND status IN ('held','confirmed','used'))
```

**קריטי:**
- נספרים **רק כרטיסי ילד**. `additional_companions` מתעלמים לחלוטין מחישוב המאגר.
- holds פעילים (`status='held'` ו-`hold_expires_at > now()`) **כן** תופסים מקום.
- holds שפג תוקפם **לא** נספרים (ראה §3 על expiry).

---

## 2. תרשים זרימה — מסע הרכישה

```
[בחירת תאריך + סבב]  ← availability בזמן אמת
        ↓
[בחירת סוג כרטיס + כמות + מלווים]
        ↓
[יצירת HOLD]  ← נעילה אטומית, TTL 15 דק', המקום יורד מהמאגר מיידית
        ↓
   ┌────┴────┐
[תשלום WC]  [ניקוב כרטיסייה]
   └────┬────┘
        ↓
[המרת hold → confirmed booking]  ← יצירת ברקוד HMAC
        ↓
[איזור אישי + מייל/SMS]
```

---

## 3. מנגנון ה-HOLD (החלק הכי חשוב)

### 3.1 שלושת מצבי המלאי

המלאי הוא **לא** מספר יחיד אלא נגזרת של מצבי `booking`:
- **זמין** — `capacity − (held + confirmed + used)`
- **נעול זמנית** — `status='held' AND hold_expires_at > now()`
- **משובץ** — `status IN ('confirmed','used')`

### 3.2 יצירת hold — קטע קריטי (race-safe)

חובה למנוע שני לקוחות שתופסים את המקום האחרון. השתמש ב-transaction עם נעילת שורה:

```sql
BEGIN;
  -- נעילה על ה-round_instance
  SELECT capacity FROM round_instances WHERE id = ? FOR UPDATE;

  -- בדיקת זמינות (כולל holds תקפים בלבד)
  SELECT COUNT(*) AS taken FROM bookings
   WHERE round_instance_id = ?
     AND ticket_type IN ('child_under_walking','child_over_walking')
     AND (status IN ('confirmed','used')
          OR (status='held' AND hold_expires_at > now()));

  -- אם taken + requested_children <= capacity:
  INSERT INTO bookings (..., status='held', hold_expires_at = now() + interval '15 min');
COMMIT;
```

החזר ללקוח: `{ hold_id, expires_at }`.

> **אין תקרת qty מלאכותית** (`max_children_per_order` ברירת מחדל `null`). לקוח יכול לבקש hold ל-N ילדים בסבב יחיד; הבדיקה היחידה היא `taken + N <= capacity`. אם האדמין מגדיר תקרה, היא נאכפת **לפני** הכניסה ל-transaction.

### 3.3 פקיעת holds

שתי שכבות (גם וגם):
1. **Lazy expiry** — בכל קריאת availability, holds עם `hold_expires_at <= now()` לא נספרים. זה מבטיח נכונות מיידית גם בלי job.
2. **Cleanup job** — כל דקה, `UPDATE bookings SET status='expired' WHERE status='held' AND hold_expires_at <= now()`. מנקה רשומות ושומר על היגיינת DB. **חשוב:** כשרשומה פוקעת בסבב שיש לו רשימת המתנה — הפעל את לוגיקת ה-waitlist (§8).

### 3.4 ה-hold עובד גם לכרטיסיות

ניקוב כרטיסייה עובר את אותו זרם בדיוק. ההבדל היחיד: שלב 4 הוא ניקוב במקום תשלום. ה-hold נוצר זהה ב-§3.2, ובמעבר ל-confirmed מנקבים את הכרטיסייה במקום לאמת תשלום WC.

**רכישה קבוצתית בכרטיסייה אחת:** hold ל-N ילדים ניתן ל-confirm באמצעות N ניקובים מכרטיסייה יחידה בעסקה אחת, בכפוף ליתרה (`punch_card.remaining >= N`). העסקה אטומית: או שכל N הניקובים מבוצעים וכל ה-N bookings עוברים ל-confirmed, או ROLLBACK מלא. מקרה שימוש: כמה אמהות מגיעות יחד וקונות סבב לכל הילדים מכרטיסייה אחת משותפת.

---

## 4. אינטגרציית WooCommerce ↔ מערכת

### 4.1 מבנה מוצרי WooCommerce

> **המלצה: לא ליצור 9 מוצרים עם מלאי WC נפרד.** מודל המאגר המשותף שובר את ההנחה של "מלאי לכל SKU". במקום זה:

- **מוצרים קיימים ב-WC** (מקור: רשימת המוצרים בלוח הניהול של חנות WC). כולם `manage_stock=false` — המערכת היא מקור האמת. עברו לתגיות `single`/`multi`:
  - **1001** — "כרטיס כניסה לילד/ה יחיד/ה + מבוגר/ת מלווה" — ₪55 (entry card, child ≥ walking age, כולל מלווה אחד) — tag `single`
  - **1002** — "כרטיס כניסה לתינוק/ת + מבוגר/ת מלווה" — ₪45 (entry card, baby/infant, כולל מלווה אחד) — tag `single`
  - **1003** — "כרטיס כניסה למלווה שני/ה" — ₪12 (additional companion) — tag `single`
  - **1004** — "כרטיסייה – משלמים על 10 כניסות ומקבלים 12" — ₪550 (punch card) — tag `multi`
- **מיפוי `ticket_type` → SKU:**
  - `ticket_type='child_over_walking'` → product 1001
  - `ticket_type='child_under_walking'` → product 1002
  - `additional_companions > 0` → line item נוסף עם product 1003 × N
  - punch card purchase → product 1004
- **הסבב, התאריך, וה-hold_id נוסעים כ-line-item meta** — בדיוק כמו ה-gift meta הקיים. WC לא מנהל מלאי; המערכת היא מקור האמת.

> **חשוב:** entry cards (1001/1002/1003) הם **מוצר WC נפרד לגמרי** מ-punch card (1004). שני קווי מוצר שונים, שני סוגי flows. גם אם §12.4 מציע "החלף סל לכרטיסייה אחת", זה swap בין מוצרים שונים — לא שדרוג בתוך אותו מוצר.

יתרון: אין סיכון של "9 מלאים עצמאיים" שסותרים את המאגר המשותף. דיווח/הכנסות לפי סבב מופקים מהמערכת, לא מ-WC.

### 4.2 הזרם המלא מול הקוד הקיים

הקוד הקיים מבצע handoff/mint **אחרי** התשלום. לסבבים צריך גם שלב **לפני** התשלום (ה-hold). הזרם:

```
1. WP (JS) → POST /rounds/hold
   body: { round_instance_id, ticket_type, qty, additional_companions, customer_hint }
   ← { hold_id, expires_at }

2. WP: שמירת hold_id ב-WC session + הוספת line item עם meta:
   { _memesh_round_instance_id, _memesh_slot_label, _memesh_ticket_type,
     _memesh_hold_id, _memesh_additional_companions }

3. לקוח משלם ב-WooCommerce (Meshulam/Grow)

4. עם תשלום מוצלח → ה-handoff/mint הקיים נורה, עם meta_data שכולל את ה-_memesh_round_* + _memesh_hold_id
   (אותו דפוס array_map של get_meta_data() שכבר מוטמע)

5. המערכת (mint extended):
   a. אמת ש-hold_id עדיין תקף
   b. אם תקף → המר hold → confirmed, צור barcode_token (HMAC)
   c. אם פג תוקף בזמן התשלום → re-check availability:
        - יש מקום → צור confirmed booking בכל זאת
        - אין מקום → סמן booking כ-'payment_received_no_slot', alert לאדמין, הפעל refund workflow
   d. אם source=gift → צור/אתר חשבון מקבל + שייך + שלח התראה (§7)
   e. שלח מייל/SMS עם הברקוד

6. החזרת success → WP מפנה לאיזור האישי
```

### 4.3 רשת ביטחון (webhook)

אם הלקוח סוגר את הטאב אחרי אישור הבנק אבל לפני טעינת דף התודה — ה-WC webhook (כמו snippet 5 הקיים) חייב לירות את ה-mint בצד שרת. ה-mint חייב להיות **idempotent**: אם כבר נוצר booking ל-`wc_order_id` הזה, החזר אותו ולא תיצור כפילות.

> **idempotency key מומלץ:** `wc_order_id`. בדוק קיום לפני יצירה.

---

## 5. מצבי Booking (State Machine)

```
                 ┌──────────────────────────────────────┐
                 │                                       │
  [created] → held ──(תשלום/ניקוב הצליח)──→ confirmed ──(סריקה בכניסה)──→ used
                 │                              │
                 │                              ├──(החלפה)──→ confirmed @ round_instance חדש (אטומי)
                 │                              │
                 ├──(TTL פג)──→ expired         └──(ביטול ≥24ש)──→ cancelled → שחרור מאגר → trigger waitlist
                 │
                 └──(תשלום נכשל)──→ released
```

מעברים אסורים:
- `confirmed → cancelled` כש-`now() > round_start − 24h`. רק החלפה מותרת מנקודה זו ועד שעת התחלת הסבב.
- `used → *` — סופי.

---

## 6. החלפות וביטולים

### 6.1 החלפת סבב (swap)

**מותר:** בכל זמן עד **שעת התחלת הסבב המקורי** (`round_instance.date + round.start_time`), בכפוף לזמינות ביעד.

**אטומיות חובה** — או ששני הצדדים קורים או ששום דבר:

```sql
BEGIN;
  SELECT ... FROM round_instances WHERE id = :target FOR UPDATE;
  -- בדוק זמינות ביעד
  -- אם אין מקום → ROLLBACK, החזר שגיאה "הסבב מלא", הלקוח נשאר במקורי
  UPDATE bookings SET round_instance_id = :target WHERE id = :booking;
  -- אם source=punchcard → הניקוב נשאר על השיבוץ החדש (לא מוחזר)
COMMIT;
-- אחרי commit: אם המקור היה מלא ויש לו waitlist → trigger waitlist על המקור
```

זמין גם דרך האתר וגם דרך פאנל הצוות (במקום), שניהם בכפוף למקום פנוי.

### 6.2 ביטול (cancellation)

**מותר:** רק עד 24 שעות לפני תחילת הסבב.
- `source=paid` → החזר כספי + שחרור מאגר + trigger waitlist.
- `source=punchcard` → **החזרת הניקוב** לכרטיסייה + שחרור מאגר + trigger waitlist.
- אחרי חלון 24 השעות → אין ביטול, רק החלפה (עד שעת הסבב).

---

## 7. רכישת מתנה

כבר מוטמע בצ'קאאוט (`_memesh_gift_recipient_*`). ההרחבה לסבבים:

- שדות המקבל (שם פרטי, שם משפחה, טלפון, מייל) נוסעים ב-meta_data → ה-mint.
- ה-mint יוצר/מאתר חשבון מקבל לפי **טלפון** (מפתח ראשי) או מייל:
  - **מקבל קיים** → שייך את ה-booking לחשבונו + שלח התראה (SMS+מייל) "קיבלת מתנה!".
  - **מקבל חדש** → צור חשבון, שייך, שלח פרטי כניסה לאיזור האישי + התראה.
- שמור snapshot של פרטי המקבל ב-`bookings.gift_recipient` (JSONB) לתיעוד.

> שים לב להתאמת השדות למה שמערכת הכרטיסיות כבר דורשת — טלפון, מייל, שם מלא. השמות בצ'קאאוט כבר תואמים (`memesh_gift_recipient_first_name` וכו').

---

## 8. רשימת המתנה (Waitlist)

### 8.1 הפעלה

מופעלת בכל שחרור מקום בסבב `R` (ביטול, החלפה-החוצה, או פקיעת hold) **אם** ל-`R` יש `waiting` entries.

### 8.2 אלגוריתם

```
on_slot_freed(round_instance R):
    entry = SELECT * FROM waitlist_entries
            WHERE round_instance_id = R.id AND status='waiting'
            ORDER BY created_at ASC LIMIT 1   -- FIFO
    if entry is null: return

    now = current_time
    if within_active_hours(now):              -- ברירת מחדל 08:00–22:00, מהאדמין
        notify(entry)                          -- SMS + מייל
        entry.status = 'notified'
        entry.notified_at = now
        entry.claim_expires_at = now + claim_window   -- ברירת מחדל 60 דק', מהאדמין
    else:
        -- "שעות שקטות" — דחיית הספירה לחלון הפעיל הבא
        schedule_notification(entry, at = next_active_window_start)
        -- בזמן ההוא: notify + claim_expires_at = window_start + claim_window
```

### 8.3 Claim ו-timeout

- הלקוח לוחץ "תפוס מקום" → עובר את זרם ה-hold הרגיל (§3) → אם משלים, `entry.status='claimed'`.
- אם `claim_expires_at` עובר ללא claim → `entry.status='expired'`, וקרא שוב ל-`on_slot_freed(R)` (הבא בתור).

### 8.4 שקיפות ללקוח (חובה)

בעת ההרשמה לרשימה, הצג בדיוק את הכללים:
> "אם יתפנה מקום בשעות הפעילות — נודיע לך מיד, ויהיו לך 60 דקות לתפוס. אם זה קורה בלילה — נודיע לך בבוקר עם הזמן המלא. אם לא תתפוס בזמן, המקום עובר לבא בתור."

### 8.5 פרמטרים מהאדמין

`active_hours_start`, `active_hours_end`, `claim_window_minutes`.

---

## 9. תזכורות זמן שהייה

### 9.1 לוגיקה

הסבב הוא חלון קבוע. תזכורת מבוססת על **שעת סיום הסבב** (batch — כל המשובצים מקבלים יחד), לא על זמן כניסה אישי.

- שלח ב-`round.end_time − 30min` וב-`round.end_time − 10min` (offsets מהאדמין).
- **דלג על הסבב האחרון של היום** — המקום נסגר ב-19:00, תזכורת מיותרת ומציקה.

### 9.2 הגדרת "הסבב האחרון"

`round_instance` עם ה-`end_time` המאוחר ביותר באותו תאריך מבין הפעילים. ניתן גם להגדיר `closing_time` גלובלי (19:00) ולדלג על תזכורות שה-end שלהן בתוך X דקות מהסגירה.

### 9.3 מימוש

Scheduled job שרץ לכל `round_instance` עתידי, יוצר משימות שליחה ל-confirmed bookings. נשלח רק ל-`status='confirmed'` (לא ל-used/cancelled).

### 9.4 פרמטרים מהאדמין

`reminder_offsets` (מערך, ברירת מחדל [30,10] דק'), `closing_time`, `skip_last_round` (bool).

---

## 10. ברקוד ואבטחה

- שימוש חוזר במנגנון HMAC-SHA256 הקיים. `barcode_token = HMAC(secret, booking_id || nonce)`.
- נוצר רק במעבר ל-`confirmed` (לא ל-held).
- **חיפוש בפאנל צוות:** לפי **שם לקוח + סבב** (`round_instance`). השאילתה:
  ```sql
  SELECT b.*, c.full_name FROM bookings b JOIN customers c ON b.customer_id=c.id
   WHERE b.round_instance_id = ? AND c.full_name ILIKE '%?%'
     AND b.status IN ('confirmed','used')
  ```
- סריקה בכניסה → אימות HMAC → מעבר ל-`used` (חד-פעמי; סריקה שנייה מציגה "כבר נוקב").

---

## 11. שלושת הפאנלים

### 11.1 פאנל אדמין (שליטה מלאה)

#### 11.1.1 דשבורד ראשי — הדף הראשון שרואים

**עיקרון:** מינימליסטי, נקי, RTL, ללא scrollבדסקטופ. תמיד מציג את הדאטה הכי חשובה לרגע הנוכחי, ללא צורך בקליק. רענון אוטומטי כל `dashboard_refresh_interval_seconds` (ברירת מחדל 30s).

**ארבעה זונים, סדר עדיפות מלמעלה למטה (או ימין-לשמאל ב-RTL):**

| זון | תוכן | מתי מוצג |
|-----|------|----------|
| **1. סבבי היום (גדול, hero)** | tile לכל סבב פעיל היום: שם, שעות, פס תפוסה (X/Y ילדים), אחוז מילוי, צבע סטטוס (ירוק <70%, צהוב 70–90%, אדום >90% או מלא). קליק → ניהול הסבב. | תמיד |
| **2. היום במספרים** | מטריקות מפתח: הכנסה היום (₪), הזמנות היום (count), holds פעילים (count), כרטיסיות שנמכרו היום. השוואה ויזואלית קטנה מול אתמול (▲/▼). | תמיד (ניתן להסתיר את `הכנסה` ע"י `dashboard_show_revenue=false`) |
| **3. התראות פעילות** | רשימת אירועים דורשי-טיפול: `payment_received_no_slot`, holds תקועים, סבב מלא עם waitlist גדול, סבב סגור באירוע. כל פריט עם קליק → context. | רק כשיש התראות. אחרת — זן זה נעלם לחלוטין (לא placeholder ריק). |
| **4. רשימת המתנה חיה** | פר סבב היום עם waitlist: כמה ממתינים, כמה notified, claim_expires הקרובים. | רק כשיש waitlist activity |
| **5. 7 ימים קדימה (אופציונלי)** | mini-grid: 7 עמודות (ימים), שורה לכל סבב, צבע לפי % מילוי. קליק על תא → ניהול הסבב באותו תאריך. | רק אם `dashboard_show_week_ahead=true` |

**עקרונות עיצוב (מחייב):**
- אין gradients, אין glassmorphism, אין shadows כבדים. סגנון flat ונקי.
- היררכיה ויזואלית ברורה: מספרי hero גדולים, labels קטנים, רווחים נדיבים.
- צבעוניות מצומצמת: שחור/לבן/אפור בסיס + 3 צבעי סטטוס (ירוק/צהוב/אדום) בלבד.
- אין fake data, אין placeholders של "Lorem ipsum". empty states ממשיים ("אין סבבים פעילים היום").
- מובייל: זונים נערמים אנכית, אותו תוכן בדיוק (לא tab-bar שמסתיר זונים).
- כל מספר במספר עברי תקין, אג' עם ₪ לפני המספר (RTL convention).
- אין emojis. שום צ'יפים צבעוניים מיותרים.
- ביצועים: render initial < 200ms, רענון < 100ms.

**מה לא בדשבורד (כדי לשמור על מינימליות):**
- דוחות עומק → טאב נפרד (§11.1.2 "דוחות").
- ניהול הזמנות → טאב נפרד.
- הגדרות → טאב נפרד.
- היסטוריה ישנה → טאב נפרד.

> הדשבורד הוא הצוהר היומיומי. כל מה שהאדמין צריך לדעת בעלייה לבוקר — שם. אם הוא צריך לקלוק כדי לדעת אם הכל בסדר היום — כשלנו.

#### 11.1.2 ניהול ושליטה (בלשוניות / תפריט צד)

- **סבבים:** יצירה/עריכה/מחיקה, שעות התחלה/סיום, ימים פעילים, הפעלה/השבתה. הוספת סבבי בוקר/ערב = פעולת הגדרה בלבד.
- **קיבולת:** ברירת מחדל לכל סבב + override פר-תאריך (חגים, אירועים, סגירה).
- **תמחור:** כל סוגי הכרטיסים, כרטיסייה, מלווה נוסף.
- **קונפיגורציה:** TTL ל-hold, offsets לתזכורות, גבולות שעות פעילות, חלון claim לרשימת המתנה.
- **כללים ומדיניות:** מינימום גיל מלווה, אכיפת גיל בטופס באתר (כן/לא), מדיניות בדיקת ת"ז בכניסה, מחיר מלווה שלישי+ (walk-in), טקסט צ'קבוקס תקנון (rich text — כולל כלל הגרביים), הפעלת מכירת גרביים בקופה.
- **הזמנות:** צפייה בכל ה-bookings, סינון לפי תאריך/סבב/סטטוס/לקוח. יצירה/ביטול/override ידני.
- **ברקודים:** regeneration במקרה הצורך.
- **דוחות:** תפוסה לפי סבב, הכנסות, שימוש בכרטיסיות, no-shows.

### 11.2 פאנל צוות (בזמן משמרת)

- סבבי היום + תפוסה חיה לכל סבב.
- חיפוש שיבוץ לפי **שם + סבב**.
- סריקה/lookup של ברקוד → אימות → ניקוב (`→ used`).
- הצגת מספר מלווים לשיבוץ (לבקרת כניסה).
- **החלפה במקום** (אם יש מקום).
- **מכירת walk-in במקום** (מהמאגר הנותר, בכפוף לזמינות).
- **תצוגת זמינות למלווה נוסף בהגעה** (השלישי ומעלה — מבוסס מקום פנוי, ידני, ללא שריון).

### 11.3 פאנל לקוח

- צפייה בשיבוצים פעילים/עתידיים + ברקוד.
- הצגת ברקוד בכניסה.
- **החלפת סבב** (עד שעת הסבב המקורי, אם יש מקום).
- **הוספת מלווה נוסף** (עד 1 לכל ילד — לא צורך מאגר, נחסם רק ע"י כלל ה-1-לכל-ילד).
- יתרת כרטיסייה + היסטוריה. **הכרטיסייה טרנספרבילית** — בעל הכרטיסייה יכול לנקב עבור כל אדם, וגם כמה ניקובים בבת אחת (למשל לרכישה קבוצתית של כמה אמהות).
- התראות מתנה.
- סטטוס רשימת המתנה.

---

## 12. לוגיקת ה-upsell לכרטיסייה

### 12.1 נתוני בסיס

- מחיר כרטיסייה = ₪550 ל-12 כניסות → **₪45.83 לכניסה** (משלמים על 10, מקבלים 12).
- מול ₪55 → חיסכון ₪9.17/כניסה. **כדאי להציג.**
- מול ₪45 → ₪0.83 *יותר* יקר לכניסה. **לא להציג השוואת חיסכון.**

### 12.2 כללי הצגה (חובה לדיוק — אמינות)

תהי `n55` = כמות כרטיסי ₪55 בסל, `n45` = כמות כרטיסי ₪45. הספים נשלטים מ-§15.1:

```
if n55 == 0:
    אין השוואה כלל   (רק ₪45 → הצגה לא כנה; ניתן לעקוף ע"י upsell_show_for_pure_n45_carts)
elif n55 < settings.upsell_assertive_n55_threshold:  # ברירת מחדל 2 — כלומר n55==1
    הצעה רכה: settings.upsell_text_soft   (ללא מספרי חיסכון אגרסיביים)
else:  # n55 >= upsell_assertive_n55_threshold
    אסרטיבי + מספרים אמיתיים, מבוסס רק על כרטיסי ₪55 (settings.upsell_text_assertive)
```

### 12.3 ניסוח האסרטיבי (מבוסס ₪55 בלבד)

ברירת המחדל של `upsell_text_assertive`:

> "כרטיסייה: ₪550 ל-12 כניסות. במקום ₪55 לכניסה — רק ₪45.83. על פני 12 ביקורים תחסוך ₪110."

החישוב **מתעלם לחלוטין מכרטיסי ₪45** בסל מעורב. הניסוח נערך מהאדמין.

### 12.4 שכבת קבוצה — הצעת איחוד לכרטיסייה אחת (החלטת ינאי)

מעבר ללוגיקת הפר-כרטיס של §12.2–12.3, יש מסלול נוסף לקלאסטר *רכישה קבוצתית*: סל עם הרבה כרטיסי כניסה באותו סבב (למשל 6 אמהות שמגיעות יחד עם ילדיהן). כאן ההצעה היא לקנות כרטיסייה אחת ולנקב ממנה את כל המקומות בעסקה אחת — מאפשר על-ידי הטרנספרביליות (§1.1, §3.4). הטיפול בקבוצה הוא **טרנספרבילי הדדית** לשני סוגי הכרטיסים: כרטיסי כניסה הם bearer (ברקודים שניתן לחלק לקבוצה), כרטיסייה היא account-based (בעל הכרטיסייה מנקב עבור כל הקבוצה). המנגנון להלן עוסק בהשוואת המחירים והעברה מסל כרטיסי כניסה לכרטיסייה אחת.

יהי `n_total` = `n55 + n45` בסל. כל המספרים בקוד למטה נשלטים מהאדמין דרך §15.1; להלן ברירות המחדל:

```
cart_cost     = n55 * 55 + n45 * 45
card_cost     = settings.punch_card_price                       # 550
card_entries  = settings.punch_card_entries                     # 12
punches_used  = n_total
punches_left  = max(0, card_entries - n_total)

# גייט 0: סל ₪45 בלבד — בד"כ מדכאים השוואה (לא הוגן)
if n55 == 0 and not settings.upsell_show_for_pure_n45_carts:
    return None

# טיר 1: חיסכון מיידי
if settings.upsell_tier_today_enabled \
   and n_total >= settings.upsell_today_savings_threshold:        # 10
    savings_today = max(0, cart_cost - card_cost)
    return render(settings.upsell_text_today_savings,
                  n=n_total, savings=savings_today,
                  remaining=punches_left)

# טיר 2: השקעה לעתיד
if settings.upsell_tier_investment_enabled \
   and n_total >= settings.upsell_investment_threshold:           # 6
    # גייט היסטוריה: אם מוגדר, להציג רק ללקוחות חוזרים
    if settings.min_visits_for_investment_upsell is not None:
        if customer.completed_visits < settings.min_visits_for_investment_upsell:
            return None                                            # מדלגים — מוקדם מדי
    investment_cost = card_cost - cart_cost                        # תוספת מעבר לסל
    return render(settings.upsell_text_investment,
                  n=n_total, investment=investment_cost,
                  future=punches_left)

# אחרת — נופל ללוגיקת הפר-כרטיס של §12.2
return per_ticket_upsell(n55, n45)
```

**עקרונות:**
- אם המערכת כבר מציעה ב-§12.3 (אסרטיבי פר-כרטיס) **ו**מתאימה גם לקלאסטר קבוצה — להציג את שכבת הקבוצה **במקום** הפר-כרטיס, לא בנוסף. הודעה אחת ברורה עדיפה על שתיים מתחרות.
- ההצעה הקבוצתית **לא** יוצרת אוטומטית את הכרטיסייה — היא משנה את ה-CTA: "החליפו את הסל בכרטיסייה אחת + ניקוב מיידי" → כפתור שמבצע החלפת סל אטומית בקליק אחד (אם `settings.upsell_one_click_swap_enabled`).
- הגייט `min_visits_for_investment_upsell` קיים כדי למנוע push אגרסיבי על לקוח first-time (₪220+ מעבר לסל הנוכחי על הבטחת ביקור עתידי). ברירת המחדל `null` (ללא גייט). ינאי יחליט אם להפעיל בפועל.

> משתלב עם המנגנון הקיים שמחשב כדאיות כרטיסייה (לפי ינאי, "המנגנון שממליץ לאנשים ומחשב להם"). המודל המוצע כאן הוא הרחבה למקרה הקבוצתי, לא החלפה. כל הספים, הניסוחים, וההפעלה/השבתה — מאדמין (§15.1).

### 12.5 מיקומי הצגה (5 נקודות, עוצמה משתנה)

כל אחת מהנקודות ניתנת להפעלה/השבתה דרך `settings.upsell_placements` (§15.1) — JSON של נקודות פעילות. ברירת מחדל: כולן פעילות.

| נקודה | מפתח | עוצמה |
|-------|------|-------|
| עמוד בחירת סבב | `round_selection` | באנר עדין |
| בחירת כרטיסים | `ticket_selection` | השוואת מחיר חיה (פר כרטיס ₪55) |
| לפני תשלום | `before_payment` | הצעה בולטת + חישוב מלא (כולל שכבת הקבוצה אם רלוונטי) |
| דף תודה | `thank_you` | הצעה לפעם הבאה |
| איזור אישי | `personal_area` | תזכורת קבועה עדינה |

עיקרון: תמיד נוכח, אף פעם לא חוסם. בולט רק בשתי הנקודות הממירות (`ticket_selection`, `before_payment`). אם ינאי משבית נקודה — היא נעלמת לחלוטין, ללא placeholder.

---

## 13. תצוגות בחירת סבב

ה-widget של בחירת הסבב (מוטמע ב-WP, מוגש מהמערכת לטובת מקור-אמת יחיד לזמינות) תומך במספר תצוגות:
- **לוח שנה** (חודש/שבוע)
- **רשימה** (סבבים כרונולוגית)
- **משבצות גדולות** (tiles)

כל תצוגה מציגה זמינות חיה פר סבב. ברירת מחדל נקבעת מהאדמין; הלקוח יכול להחליף.

---

## 14. כללי המשחקייה — checkbox התחייבות

ב-checkout (WP), checkbox **חובה** (חוסם תשלום אם לא מסומן). הטקסט עצמו נשלט מ-`terms_checkbox_text` (rich text באדמין), ברירת מחדל:

> "אני מאשר/ת שחובה להיכנס עם גרביים (לי ולילד/ה) — **ללא יוצא מן הכלל, כולל במקרה רפואי**. אפשר לקנות במקום או להביא מהבית. בנוסף, מתחייב/ת לכל כללי המשחקייה: התנהגות נאותה, שמירה על ניקיון והיגיינה, ואי-השארת ילדים ללא השגחת מלווה אחראי מתאים מגיל 16 ומעלה."

---

## 15. רשימת פרמטרים מהאדמין (Master List)

| פרמטר | ברירת מחדל | תיאור |
|-------|------------|-------|
| `hold_ttl_minutes` | 15 | משך נעילה זמנית |
| `pool_capacity` (פר סבב) | 50 | קיבולת ילדים |
| `active_hours_start` | 08:00 | תחילת שעות פעילות (waitlist) |
| `active_hours_end` | 22:00 | סוף שעות פעילות (waitlist) |
| `claim_window_minutes` | 60 | זמן לתפוס מקום מרשימת המתנה |
| `reminder_offsets` | [30, 10] | דקות לפני סוף סבב לתזכורת |
| `closing_time` | 19:00 | שעת סגירת המקום |
| `skip_last_round_reminder` | true | דילוג תזכורת לסבב אחרון |
| `cancellation_window_hours` | 24 | חלון ביטול מותר |
| `punch_card_price` | 550 | מחיר כרטיסייה |
| `punch_card_entries` | 12 | כניסות בכרטיסייה |
| `additional_companion_max_per_child` | 1 | מקסימום מלווים נוספים לכרטיס |
| `companion_min_age` | 16 | מינימום גיל מלווה |
| `require_companion_age_in_booking` | false | אכיפת גיל מלווה בטופס באתר (false = אכיפה בכניסה בלבד) |
| `walkin_additional_companion_price` | null | מחיר מלווה שלישי+ ב-walk-in (null = שווה למחיר מלווה נוסף הרגיל) |
| `companion_id_check_policy` | `when_young` | מדיניות בדיקת ת"ז בכניסה: `always` \| `when_young` \| `on_suspicion`. נקבע ע"י האדמין, נראה לצוות בפאנל המשמרת. |
| `terms_checkbox_text` | (טקסט ברירת מחדל מ-§14) | טקסט הצ'קבוקס בצ'קאאוט. rich text. |
| `sock_sales_pos_enabled` | true | האם גרביים מופיעות כפריט מכירה בקופה (אם false — נמכרות ידנית בלי תיעוד מערכת) |
| `max_children_per_order` | null | תקרת ילדים בהזמנה יחידה. `null` = ללא תקרה, מוגבל אך ורק ע"י זמינות הסבב (החלטת ינאי: ימי הולדת בתיאום אישי, לא דרך האתר; אבל אין הגבלה מלאכותית על כמות) |

### 15.1 גמישות upsell לכרטיסייה (החלטות ינאי, חלים על שני סוגי הכרטיסים)

| פרמטר | ברירת מחדל | תיאור |
|-------|------------|-------|
| `upsell_today_savings_threshold` | 10 | סף `n_total` להפעלת שכבת הקבוצה ב-framing "חיסכון היום" (§12.4) |
| `upsell_investment_threshold` | 6 | סף `n_total` להפעלת framing "השקעה לעתיד" (§12.4) |
| `upsell_assertive_n55_threshold` | 2 | סף `n55` שבו §12.2 עובר מ"רך" ל"אסרטיבי פר-כרטיס" |
| `min_visits_for_investment_upsell` | null | מינימום ביקורים קודמים של הלקוח כדי להציג שכבת ההשקעה. `null` = ללא גייט. ינאי מחליט אם להפעיל (ראה אזהרה ב-§12.4) |
| `upsell_show_for_pure_n45_carts` | false | האם להציג השוואה גם בסל של ₪45 בלבד (ברירת מחדל: לא — לא הוגן) |
| `upsell_tier_today_enabled` | true | הפעלת/השבתת טיר "חיסכון היום" |
| `upsell_tier_investment_enabled` | true | הפעלת/השבתת טיר "השקעה לעתיד" |
| `upsell_one_click_swap_enabled` | true | האם להציע כפתור "החלף סל לכרטיסייה אחת + ניקוב מיידי" בלחיצה |
| `upsell_placements` | `["round_selection","ticket_selection","before_payment","thank_you","personal_area"]` | מערך נקודות הצגה פעילות (§12.5). השמטת מפתח = כיבוי הנקודה. |
| `upsell_text_today_savings` | (טקסט ברירת מחדל מ-§12.4) | rich text — ניסוח טיר "חיסכון היום". משתני חישוב: `{n}`, `{savings}`, `{remaining}` |
| `upsell_text_investment` | (טקסט ברירת מחדל מ-§12.4) | rich text — ניסוח טיר "השקעה". משתנים: `{n}`, `{investment}`, `{future}` |
| `upsell_text_assertive` | (טקסט מ-§12.3) | rich text — ניסוח אסרטיבי פר-כרטיס |
| `upsell_text_soft` | "מתכננים להגיע הרבה? כרטיסייה משתלמת." | rich text — ניסוח הצעה רכה (n55==1) |

### 15.2 מדיניות כרטיסים (טרנספרביליות וקבוצה)

| פרמטר | ברירת מחדל | תיאור |
|-------|------------|-------|
| `punch_card_transferable` | true | האם בעל כרטיסייה יכול לנקב עבור אחרים. כיבוי = הכרטיסייה רק לבעליה (`customer_id` חייב להתאים) |
| `punch_card_multi_punch_per_txn` | true | האם מותר לנקב יותר מניקוב אחד בעסקה (group buy). כיבוי = ניקוב אחד בלבד בכל פעם |
| `punch_card_max_multi_punch_per_txn` | null | תקרת ניקובים בעסקה יחידה. `null` = רק לפי יתרת הכרטיסייה |
| `entry_card_bearer_transferable` | true | האם ברקוד של כרטיס כניסה הוא bearer (כל מי שמחזיק בברקוד יכול להיכנס). כיבוי = דרישת זיהוי לקוח בכניסה |
| `entry_card_separate_emails` | false | בהזמנה קבוצתית עם N כרטיסי כניסה: `false` = מייל אחד עם כל הברקודים, `true` = N מיילים נפרדים |

### 15.3 דשבורד אדמין

| פרמטר | ברירת מחדל | תיאור |
|-------|------------|-------|
| `dashboard_refresh_interval_seconds` | 30 | קצב רענון אוטומטי של הדשבורד |
| `dashboard_show_revenue` | true | האם להציג את מטריקת ההכנסה (למקרה שמשתמש לא-מורשה צופה) |
| `dashboard_show_week_ahead` | true | האם להציג את זן 7 הימים קדימה |
| `dashboard_capacity_warning_pct` | 70 | אחוז תפוסה שעובר מירוק לצהוב |
| `dashboard_capacity_danger_pct` | 90 | אחוז תפוסה שעובר מצהוב לאדום |
| `dashboard_widgets_order` | `["rounds_today","stats_today","alerts","waitlist","week_ahead"]` | סדר הזונים. השמטת מפתח = הסתרה. מאפשר התאמה אישית של הסדר. |

---

## 16. מקרי קצה (Edge Cases)

| תרחיש | טיפול |
|-------|-------|
| Hold פג באמצע תשלום | re-check availability ב-mint; יש מקום → confirm; אין → `payment_received_no_slot` + alert + refund |
| שני לקוחות על המקום האחרון | `SELECT ... FOR UPDATE` ב-§3.2 מונע oversell |
| החלפה לסבב מלא | ROLLBACK אטומי, הלקוח נשאר במקורי, הודעה "הסבב מלא" |
| ביטול < 24ש | חסום; הצע החלפה (עד שעת הסבב) |
| מתנה למקבל קיים | שייך לחשבונו + התראה |
| מתנה למקבל חדש | צור חשבון + פרטי כניסה + התראה |
| הוספת מלווה נוסף מאוחר | תמיד אפשרי עד 1/ילד (לא צורך מאגר) |
| כרטיסייה: ביטול ≥24ש | החזר ניקוב + שחרר מאגר |
| כרטיסייה: החלפה | ניקוב נשאר על השיבוץ החדש |
| כרטיסייה: ניקוב קבוצתי (N>1) | עסקה אטומית — בודק `remaining >= N`, מנקב N בבת אחת, מחבר N bookings ל-confirmed. נכשל ROLLBACK מלא (אין ניקוב חלקי). הכרטיסייה אינה חייבת להיות של אחד המשובצים. |
| כרטיסייה: ניקוב עבור אדם אחר | מותר ללא הגבלה — בעל הכרטיסייה לא חייב להיות אחד המשובצים (טרנספרביליות מלאה). |
| webhook + thank-you שניהם יורים | mint idempotent לפי `wc_order_id` |
| כמה ילדים בסבבים שונים | הזמנה נפרדת לכל סבב (החלטה מוצרית) |
| מלווה שלישי+ | לא קיים במערכת — walk-in ידני בלבד, ללא שריון בשום ערוץ (לא טלפון, לא הודעה). מחיר מ-`walkin_additional_companion_price`. |
| מלווה מתחת לגיל המינימום מגיע בכניסה | חסום כניסה כמלווה. הצע רכישת walk-in למלווה בוגר (בכפוף לזמינות). הכלל מוצג בצ'קבוקס §14 לפני התשלום. |
| בדיקת ת"ז בכניסה | לפי `companion_id_check_policy`. הצוות רואה את המדיניות הפעילה בפאנל המשמרת. |
| הזמנה גדולה בודדת (10+ ילדים בסבב יחיד) | מותר באתר, מוגבל אך ורק ע"י זמינות הסבב (החלטה: ללא תקרת qty מלאכותית). ימי הולדת רשמיים = תיאום אישי מולנו, **לא בזרם האתר**. |

---

## 17. היקף שלב 1

**נכלל בשלב 1:**
- סבבי **אחה"צ בלבד** (בוקר/ערב = הגדרה עתידית, ללא קוד)
- מודל מאגר + holds + state machine
- אינטגרציית WC (מוצרים גנריים + meta + mint extended + webhook)
- תשלום + ניקוב כרטיסייה
- החלפות + ביטולים (כללי 24ש / שעת סבב)
- מתנות (שיוך לחשבון קיים/חדש)
- רשימת המתנה (כולל שעות שקטות)
- תזכורות (כולל דילוג סבב אחרון)
- שלושת הפאנלים
- ברקוד HMAC + חיפוש שם+סבב
- upsell (כללי ההשוואה הכנה)
- checkbox התחייבות

**ניתן לדחות לשלב 2 אם צריך לצמצם:**
- תצוגות בחירה מתקדמות (אפשר להתחיל עם רשימה בלבד, להוסיף לוח שנה/tiles אח"כ)
- דוחות אדמין מתקדמים (להתחיל עם תפוסה + הכנסות בסיסי)

**מחוץ לסקופ שלב 1 (החלטות ינאי):**
- **ימי הולדת / אירועים קבוצתיים** — לא זרם באתר. תיאום אישי בלבד מול המקום. אין UI ייעודי, אין הזמנת קבוצה דרך הצ'קאאוט.
- **תקרת qty להזמנה** — אין. לקוח יכול לרכוש כמה כרטיסים שירצה לסבב יחיד, מוגבל אך ורק ע"י זמינות (ראה `max_children_per_order` ב-§15).

---

## נספח A — סיכום ה-API surface המוצע

> שמות ניתנים להתאמה לקונבנציות הקיימות. כל ה-endpoints תחת `memesh-opal.vercel.app`.

```
# זמינות + holds
POST /rounds/availability      { date }  → [{ round_instance_id, label, available, capacity }]
POST /rounds/hold              { round_instance_id, ticket_type, qty, additional_companions, customer_hint }
                               → { hold_id, expires_at }
POST /rounds/hold/release      { hold_id }  → { ok }

# mint (קיים — מורחב לטיפול בסבבים)
POST /auth/customer/wc-handoff/mint   { ...existing..., meta_data:[...] }
                               → { booking_id, barcode_token, status }   # idempotent על wc_order_id

# שינויים
POST /rounds/swap              { booking_id, target_round_instance_id }  → { ok | full }
POST /rounds/cancel            { booking_id }  → { ok | window_closed }

# רשימת המתנה
POST /waitlist/join            { round_instance_id, customer_id, requested_type }  → { entry_id }
POST /waitlist/claim           { entry_id }  → { hold_id, expires_at | expired }

# לקוח
GET  /bookings/{customer_id}   → [{ booking, round_instance, barcode }]

# צוות
POST /staff/lookup             { round_instance_id, name_query }  → [{ booking, customer }]
POST /staff/punch              { barcode_token }  → { ok | already_used | invalid }
POST /staff/walkin             { round_instance_id, ticket_type, ... }  → { booking }

# אדמין — CRUD על rounds, round_instances, settings, pricing
```

---

*סוף המסמך. כל ערך מספרי כאן הוא ברירת מחדל ניתנת-לקונפיגורציה, לא קבוע.*
