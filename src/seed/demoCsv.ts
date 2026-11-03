/**
 * Demo statement generator — the app's "seeder".
 *
 * Produces an anonymized, English-language bank export in the built-in
 * Alternative-Bank-Schweiz layout (only the CSV *headers* stay German, because
 * that is the schema the app parses out of the box). Payees are well-known
 * Swiss and German shops plus common online shops, so the starter categories in
 * `default-category-setting.json` light up immediately, while a few rows stay
 * deliberately unmatchable so "Uncategorized" is visible too.
 *
 * Nothing real appears here: no people, no accounts, no amounts. The data comes
 * from a fixed pseudo-random sequence, so the demo looks the same on every load.
 */

export const DEMO_FILE_NAME = 'demo-statement.csv';

/** number of months the demo covers (including the current one) */
const MONTHS = 6;
/** fixed PRNG seed → identical demo on every visit */
const SEED = 20261001;

/** mulberry32 — a tiny deterministic PRNG */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Account = 'everyday' | 'savings';

interface Row {
  day: number;
  /** description; '\n' renders as a quoted multi-line cell */
  text: string;
  credit?: number;
  debit?: number;
  account?: Account;
  /** shared reference: the two legs of an internal transfer use one ref */
  ref?: string;
  /** valuta delay in days (real exports sometimes book a day later) */
  shift?: number;
}

const ACCOUNTS: Record<Account, { konto: string; alias: string; iban: string }> = {
  everyday: { konto: '0234567.890', alias: 'Everyday account', iban: 'CH45 0470 0000 0012 3456 7' },
  savings: { konto: '0987654.321', alias: 'Savings account', iban: 'CH63 0470 0000 0098 7654 3' },
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** shops that appear on the statement — known Swiss / German retailers and online shops */
const GROCERS: Array<[string, string]> = [
  ['MIGROS', 'Zurich'], ['COOP', 'Winterthur'], ['DENNER', 'Schaffhausen'],
  ['ALDI', 'Singen'], ['LIDL', 'Konstanz'], ['REWE', 'Singen'],
  ['EDEKA', 'Radolfzell'], ['SPAR', 'Baar'], ['Kaufland', 'Weinfelden'],
];
const DINING: string[] = [
  'Starbucks Coffee Zurich Bahnhof', "McDonald's Zurich West", 'Restaurant Schuetzenhaus',
  'Vapiano Geneva', 'Cafe Spruengli', 'Brezelkoenig Bakery', 'Pizza Delivery Express',
  'Just Eat food order', 'Hotel Bareiss Restaurant',
];
const ONLINE: Array<[string, string]> = [
  ['AMZN Mktp DE*EXAMPLE1234', 'Amazon order'], ['ZALANDO SE', 'Zalando return window'],
  ['TEMU.COM', 'Temu order'], ['ALIEXPRESS', 'AliExpress order'], ['GALAXUS', 'Galaxus order'],
  ['RICARDO AG', 'Ricardo auction'], ['TUTTI CH', 'tutti.ch purchase'], ['EBAY', 'eBay purchase'],
  ['SHEIN', 'Shein order'], ['BRACK.CH', 'Brack.ch electronics'], ['VINTED UAB', 'Vinted purchase'],
  ['KAUFLAND.DE', 'Kaufland online shop'],
];
const INSTORE: Array<[string, string]> = [
  ['MANOR', 'Department store'], ['JUMBO', 'Do-it-yourself'], ['OBI', 'Garden centre'],
  ['IKEA', 'Furniture'], ['DM DROGERIE', 'Drugstore'], ['ROSMANN', 'Drugstore'],
  ['MEDIAMARKT', 'Electronics'], ['FUST', 'Electronics'], ['DECATHLON', 'Sports gear'],
  ['DOUGLAS', 'Perfume'], ['H&M', 'Clothing'], ['ZARA', 'Clothing'],
];
const FUEL: string[] = ['Shell gasoline station', 'AGROLA tankstelle', 'Tamoil Tankstelle', 'Migrol garage', 'TANK & RAST Autohof'];
const TRANSIT: string[] = ['SBB CFF FFS ticket Zurich-Bern', 'ZVV monthly zone 156', 'PostAuto bus ticket', 'DB Bahnfahrt Stuttgart-Ulm', 'Straessenverkehrsamt fee'];
const UNCAT: string[] = ['PAYPAL *EXAMPLESELLER99', 'ONLINE MARKTPLATZ XYZ GmbH', 'KLEINANZEIGE 7712 UNKNOWN', 'CASHBACK PORTAL MIRAPONE'];

const pad = (n: number): string => String(n).padStart(2, '0');

/** 'CHF 1,234.56' / 'CHF -1,234.56' — the amount style the built-in schema parses */
function amount(n: number, negative: boolean): string {
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `CHF ${negative ? '-' : ''}${s}`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** one month of transactions; `r` is the shared PRNG so amounts vary month to month */
function monthRows(r: () => number, y: number, m: number, monthName: string, refPrefix: string): Row[] {
  const pick = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)];
  const money = (base: number, spread: number, cents = true): number => {
    const v = base + r() * spread;
    return cents ? Math.round(v * 100) / 100 : Math.round(v / 10) * 10;
  };
  /** card purchase line, the way terminals print it */
  const card = (label: string): string =>
    `Debit card ${pad(day(r))}.${pad(m)}.${y} ${pad(9 + Math.floor(r() * 12))}:${pad(Math.floor(r() * 60))} ${label}`;
  const ref = (): string => `${refPrefix}/${String(100000 + Math.floor(r() * 899999))}`;

  const rows: Row[] = [];
  const add = (row: Row): void => {
    rows.push({ ...row, ref: row.ref ?? ref() });
  };

  // ---- fixed commitments -------------------------------------------------
  add({
    day: 1,
    debit: 1850,
    text: `Credit payment to landlord\nAlpenblick Rental AG\nBahnhofstrasse 12\n8001 Zurich\nPayment purpose: Rent ${monthName} ${y}`,
  });
  add({ day: 1, debit: 342.6, text: `Direct debit SWICA health insurance premium ${monthName} ${y}` });
  add({ day: 2, debit: money(78, 22), text: 'Direct debit Strom AG electricity monthly advance', shift: 1 });
  add({ day: 3, debit: 69.9, text: 'Direct debit Sunrise Fibre 500 internet subscription' });
  add({ day: 5, debit: 29.5, text: 'Direct debit Salt mobile subscription' });
  add({ day: 8, debit: 59, text: 'Direct debit Movida Fitness membership' });
  add({ day: 12, debit: pick([19.9, 12.99]), text: pick(['NETFLIX.COM premium', 'Spotify Premium family', 'Disney+ Standard', 'iCloud+ 200GB']) });
  add({ day: 14, debit: pick([9.99, 19.99, 29.99]), text: pick(['STEAM digital purchase', 'Nintendo eShop top-up', 'PlayStation Plus membership', 'Epic Games store']) });
  add({ day: 25, credit: money(4180, 60), text: `Salary\nNorthwind Software Ltd\nIndustriestrasse 4\n8600 Duebendorf\nPayment purpose: wages ${monthName} ${y}` });
  add({ day: 28, debit: 12.9, text: 'Bank fee account package and debit card' });

  // ---- groceries (four a month) ------------------------------------------
  for (const d of [7, 10, 16, 22]) {
    const [shop, city] = pick(GROCERS);
    add({ day: d, debit: money(9, 85), text: card(`${shop} ${city}`) });
  }

  // ---- eating out ---------------------------------------------------------
  for (const d of [4, 9, 15, 23]) {
    add({ day: d, debit: money(6, 45), text: card(pick(DINING)) });
  }

  // ---- online shopping ----------------------------------------------------
  for (const d of [6, 19]) {
    const [payee, note] = pick(ONLINE);
    add({ day: d, debit: money(14, 130), text: `${payee} — ${note}` });
  }

  // ---- shops in town ------------------------------------------------------
  {
    const [shop, note] = pick(INSTORE);
    add({ day: 20, debit: money(18, 140), text: card(`${shop} ${pick(['Zurich', 'Winterthur', 'Basel', 'St. Gallen'])} — ${note}`) });
  }

  // ---- transport ----------------------------------------------------------
  add({ day: 4, debit: money(12, 90), text: pick(TRANSIT) });
  add({ day: 18, debit: money(20, 70), text: card(pick(FUEL)) });
  if (r() < 0.5) add({ day: 11, debit: money(4, 12), text: 'Parking Citycar Zurich' });

  // ---- cash + own accounts ------------------------------------------------
  add({ day: 13, debit: money(8, 40), text: `TWINT payment to ${pick(['Example Flower Shop', 'Corner Bakery White Cat', 'Garage Brenner', 'Market Kiosk'])}` });
  add({ day: 11, debit: money(60, 180, false), text: 'Bancomat cash withdrawal Zurich Hauptbahnhof' });
  const transferRef = `${refPrefix}/900001`;
  const transferAmt = money(200, 400, false);
  add({ day: 27, debit: transferAmt, account: 'everyday', ref: transferRef, text: `Transfer to savings account ${monthName}` });
  add({ day: 27, credit: transferAmt, account: 'savings', ref: transferRef, text: `Transfer from everyday account ${monthName}` });

  // ---- irregular life events ---------------------------------------------
  if (m % 2 === 0) add({ day: 21, debit: money(9, 45), text: card(pick(['Amavita pharmacy', 'Apotheke zur Waage', 'Drogist Mueller'])) });
  if (m % 3 === 0) add({ day: 17, debit: money(35, 120), text: pick(['Zahnarzt dental control', 'Doctor practice internal medicine', 'Physio Praxis Rhy']) });
  if (m % 3 === 1) add({ day: 21, debit: money(15, 70), text: pick(['ZOOPPLUS pet food', 'Tierarzt Praxis am Park', 'Fressnapf Hundekorb']) });
  if (m % 4 === 2) add({ day: 24, debit: money(40, 200), text: pick(['BOOKING.COM hotel stay', 'AIRBNB apartment', 'SBB international train tickets']) });
  if (m % 5 === 3) add({ day: 6, debit: money(12, 60), text: pick(['Kindergarten monthly fee', 'School trip contribution', 'Pippi baby clothes', 'Hust & Claire children wear']) });
  if (m % 6 === 5) add({ day: 26, debit: money(25, 90), text: pick(['Udemy online course', 'Buchhandlung Orell Fuessli book', 'Coursera membership']) });

  // ---- income extras ------------------------------------------------------
  if (r() < 0.5) add({ day: 27, credit: money(18, 60), account: 'savings', text: 'Interest and dividend payout index fund' });
  if (r() < 0.4) add({ day: 15, credit: money(20, 90), text: 'Salary reimbursement of expenses Northwind Software Ltd' });
  add({ day: 9, debit: money(10, 30), text: pick(['Donation Example Foundation', 'Charity winter collection', 'Spende Soup Kitchen']) });

  // ---- rows that stay uncategorized on purpose ----------------------------
  for (const d of [24, 29]) add({ day: d, debit: money(5, 55), text: card(pick(UNCAT)) });

  return rows;
}

/** random day between 1 and 28 so every month has the same shape */
function day(r: () => number): number {
  return 1 + Math.floor(r() * 28);
}

/**
 * Full demo CSV (newest bookings first, like a real export).
 * `today` is injectable for tests.
 */
export function demoCsv(today: Date = new Date(), seed: number = SEED): string {
  const r = rng(seed);
  const header = ['Buchungsdatum', 'Valutadatum', 'Auftragsnummer', 'Konto', 'Kontoalias', 'IBAN', 'Buchungstext', 'Gutschrift', 'Belastung'];
  const rows: string[][] = [];

  for (let back = MONTHS - 1; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth() - back, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const daysInMonth = new Date(y, m, 0).getDate();
    const monthName = MONTH_NAMES[m - 1];
    const refPrefix = `ZV${y}${pad(m)}X`;
    for (const row of monthRows(r, y, m, monthName, refPrefix)) {
      const acc = ACCOUNTS[row.account ?? 'everyday'];
      const bookingDay = Math.min(row.day, daysInMonth);
      const booking = `${pad(bookingDay)}.${pad(m)}.${y}`;
      const valueDay = new Date(y, m - 1, Math.min(bookingDay + (row.shift ?? 0), daysInMonth));
      const value = `${pad(valueDay.getDate())}.${pad(valueDay.getMonth() + 1)}.${valueDay.getFullYear()}`;
      rows.push([
        booking,
        value,
        row.ref ?? '',
        acc.konto,
        acc.alias,
        acc.iban,
        row.text,
        row.credit ? amount(row.credit, false) : '',
        row.debit ? amount(row.debit, true) : '',
      ]);
    }
  }

  // newest booking date first, refs as tie-break so the order is deterministic
  const sortKey = (c: string[]): string => `${c[0].slice(6)}${c[0].slice(3, 5)}${c[0].slice(0, 2)} ${c[2]}`;
  rows.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

  return [header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
