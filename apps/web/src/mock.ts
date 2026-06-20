export interface Child {
  name: string;
  dob: string;
}

export interface HistoryEntry {
  date: string; // yyyy-mm-dd
  time: string;
  comp: number;
}

export type CardStatus = 'active' | 'expiring' | 'expired';

export interface MockCustomer {
  id: string;
  first: string;
  last: string;
  phone: string;
  email: string;
  used: number;
  total: number;
  serial: string;
  expiry: string;
  status: CardStatus;
  note: string;
  children: Child[];
  history: HistoryEntry[];
}

export const initialCustomers: MockCustomer[] = [
  {
    id: 'L-0001',
    first: 'נועה',
    last: 'כהן',
    phone: '052-3456789',
    email: 'noa.cohen@gmail.com',
    used: 4,
    total: 12,
    serial: 'M-20260517-0042',
    expiry: '2027-05-17',
    status: 'active',
    note: 'מגיעה בעיקר בשישי בבוקר. הבת הקטנה רגישה לרעש, מפנות לאזור השקט.',
    children: [
      { name: 'איתמר', dob: '2021-04-12' },
      { name: 'יעל', dob: '2023-09-01' },
    ],
    history: [
      { date: '2026-06-15', time: '16:32', comp: 1 },
      { date: '2026-06-08', time: '10:15', comp: 2 },
      { date: '2026-05-30', time: '17:05', comp: 1 },
      { date: '2026-05-22', time: '11:40', comp: 1 },
    ],
  },
  {
    id: 'L-0002',
    first: 'דניאל',
    last: 'לוי',
    phone: '054-7788123',
    email: 'daniel.levi@gmail.com',
    used: 9,
    total: 12,
    serial: 'M-20260410-0031',
    expiry: '2027-04-10',
    status: 'active',
    note: 'משלם תמיד במזומן.',
    children: [{ name: 'רוני', dob: '2020-11-03' }],
    history: [
      { date: '2026-06-14', time: '15:10', comp: 1 },
      { date: '2026-06-01', time: '16:20', comp: 1 },
    ],
  },
  {
    id: 'L-0003',
    first: 'מיכל',
    last: 'אברהם',
    phone: '050-9988776',
    email: 'michal.a@gmail.com',
    used: 11,
    total: 12,
    serial: 'M-20251201-0188',
    expiry: '2026-07-01',
    status: 'expiring',
    note: '',
    children: [
      { name: 'אלמה', dob: '2022-02-18' },
      { name: 'עומר', dob: '2024-06-22' },
    ],
    history: [{ date: '2026-06-16', time: '09:50', comp: 2 }],
  },
  {
    id: 'L-0004',
    first: 'יוסי',
    last: 'מזרחי',
    phone: '053-4561234',
    email: '',
    used: 12,
    total: 12,
    serial: 'M-20250403-0017',
    expiry: '2026-04-03',
    status: 'expired',
    note: '',
    children: [{ name: 'נטע', dob: '2019-08-30' }],
    history: [{ date: '2026-03-28', time: '14:00', comp: 1 }],
  },
  {
    id: 'L-0005',
    first: 'תמר',
    last: 'פרידמן',
    phone: '058-1122334',
    email: 'tamar.f@walla.co.il',
    used: 2,
    total: 12,
    serial: 'M-20260601-0077',
    expiry: '2027-06-01',
    status: 'active',
    note: '',
    children: [{ name: 'אורי', dob: '2023-01-14' }],
    history: [
      { date: '2026-06-12', time: '17:30', comp: 1 },
      { date: '2026-06-04', time: '10:05', comp: 1 },
    ],
  },
  {
    id: 'L-0006',
    first: 'רותם',
    last: 'שגב',
    phone: '052-6677889',
    email: 'rotem.segev@gmail.com',
    used: 6,
    total: 12,
    serial: 'M-20260215-0054',
    expiry: '2027-02-15',
    status: 'active',
    note: '',
    children: [
      { name: 'גיא', dob: '2021-12-05' },
      { name: 'שירה', dob: '2024-03-19' },
    ],
    history: [{ date: '2026-06-10', time: '16:45', comp: 2 }],
  },
];

const AVATARS = [
  { bg: '#fff4ee', color: '#ffa983' },
  { bg: '#f3f7e8', color: '#8fae4f' },
  { bg: '#fdeee6', color: '#d98b62' },
  { bg: '#eef3e2', color: '#7fa043' },
];

export const fullName = (c: MockCustomer): string => `${c.first} ${c.last}`;
export const initials = (c: MockCustomer): string => (c.first[0] ?? '') + (c.last[0] ?? '');
export const avatar = (c: MockCustomer) => {
  const i = Number.parseInt(c.id.slice(-1), 10) % AVATARS.length;
  return AVATARS[i] ?? AVATARS[0]!;
};

export const statusBadge = (s: CardStatus) => {
  if (s === 'active') return { text: 'פעילה', bg: '#f0f5e3', color: '#6f8f37' };
  if (s === 'expiring') return { text: 'עומדת לפוג', bg: '#fff1e6', color: '#c97a52' };
  return { text: 'פג תוקף', bg: '#ececec', color: '#9aa3a6' };
};

export const companionLabel = (n: number): string => (n === 1 ? 'מלווה אחד' : `${n} מלווים`);
