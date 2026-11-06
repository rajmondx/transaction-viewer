import type { CashEntry, Settings } from '../types';
import { seedSettings } from '../categories/schema';

export const DEMO_CASH_ENTRY_PREFIX = 'demo-cash:';

/** Ensure the built-in cash categories in the default bundle can classify the demo rows. */
export function configureDemoCashCategories(settings: Settings): boolean {
  const seedCategories = seedSettings().categories.filter((category) => category.cashMovement);
  let changed = false;
  for (const seedCategory of seedCategories) {
    const existing = settings.categories.find((category) => category.tag === seedCategory.tag);
    if (!existing) {
      settings.categories.push(structuredClone(seedCategory));
      changed = true;
      continue;
    }
    if (existing.cashMovement !== seedCategory.cashMovement) {
      existing.cashMovement = seedCategory.cashMovement;
      changed = true;
    }
    // Older stored defaults used the broad "cash" rule on withdrawals, which
    // would claim the new Cash Deposits demo row before its specific category.
    if (seedCategory.tag === 'Cash Withdrawals') {
      const specificRules = existing.rules.filter((rule) => rule.text.trim().toLowerCase() !== 'cash');
      if (specificRules.length !== existing.rules.length) {
        existing.rules = specificRules;
        changed = true;
      }
    }
  }
  return changed;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateMonthsAgo(today: Date, monthsAgo: number, day: number): string {
  const month = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1);
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const date = new Date(month.getFullYear(), month.getMonth(), Math.min(day, lastDay));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A few deterministic manual purchases to demonstrate the wallet ledger. */
export function demoCashEntries(today: Date = new Date()): CashEntry[] {
  return [
    {
      id: `${DEMO_CASH_ENTRY_PREFIX}groceries-${dateMonthsAgo(today, 0, 20)}`,
      date: dateMonthsAgo(today, 0, 20), kind: 'expense', amount: 18.7,
      category: 'Groceries', note: 'Farmers market vegetables (cash)',
    },
    {
      id: `${DEMO_CASH_ENTRY_PREFIX}bakery-${dateMonthsAgo(today, 1, 15)}`,
      date: dateMonthsAgo(today, 1, 15), kind: 'expense', amount: 8.5,
      category: 'Dining Out', note: 'Bakery coffee and pastry (cash)',
    },
    {
      id: `${DEMO_CASH_ENTRY_PREFIX}market-${dateMonthsAgo(today, 3, 16)}`,
      date: dateMonthsAgo(today, 3, 16), kind: 'expense', amount: 24.1,
      category: 'Groceries', note: 'Weekly market groceries (cash)',
    },
  ];
}

/** Replace previous sample entries while leaving all user-entered cash data intact. */
export function mergeDemoCashEntries(existing: CashEntry[], today: Date = new Date()): CashEntry[] {
  return [
    ...existing.filter((entry) => !entry.id.startsWith(DEMO_CASH_ENTRY_PREFIX)),
    ...demoCashEntries(today),
  ];
}

/** Remove only the sample wallet rows when the demo statement is removed. */
export function withoutDemoCashEntries(entries: CashEntry[]): CashEntry[] {
  return entries.filter((entry) => !entry.id.startsWith(DEMO_CASH_ENTRY_PREFIX));
}
