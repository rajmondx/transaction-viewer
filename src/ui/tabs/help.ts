import { BookOpen, ChevronDown, HelpCircle, Mail, Phone } from 'lucide';
import { C, clear, cx, h } from '../util';
import { Ic } from '../icons';

type Child = Node | string | null | undefined;

const MAIL = 'rajmond.xhaferi@gmail.com';

function mailLink(): HTMLElement {
  return h('a', { class: C.link, attrs: { href: `mailto:${MAIL}` }, text: MAIL });
}

/** expandable FAQ entry */
function faq(question: string, ...answer: Child[]): HTMLElement {
  return h('details', { class: cx(C.card, 'group px-4 py-3') },
    h('summary', { class: 'flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] font-semibold [&::-webkit-details-marker]:hidden' },
      h('span', { text: question }),
      Ic(ChevronDown, 'size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180')),
    h('div', { class: 'mt-2 grid gap-1.5 text-[13px] leading-relaxed text-muted-foreground' }, ...answer));
}

function p(...kids: Child[]): HTMLElement {
  return h('p', {}, ...kids);
}

function b(text: string): HTMLElement {
  return h('b', { class: 'text-foreground', text });
}

export function renderHelp(container: HTMLElement): void {
  clear(container);

  container.appendChild(
    h('div', { class: 'mx-auto grid max-w-[860px] gap-3 pb-6' },

      // ---- intro ----
      h('div', { class: cx(C.card, 'px-5 py-4') },
        h('h2', { class: 'mb-2 flex items-center gap-2 text-[17px] font-semibold' }, Ic(BookOpen, 'size-5'), 'Help'),
        p('I made this viewer because I was annoyed that my banking app wasn’t showing my spendings, and I like to keep an overview. ',
          b('Transaction Viewer'),
          ' lets you upload multiple CSV statements from multiple banks and explore them: categorize transactions with your own rules, see spending per category and month, and print clean reports.'),
        p(b('No data is sent to a server.') , ' Everything is saved locally in your browser (IndexedDB + localStorage) — there is no backend, no account and no tracking. You can use it fully offline once it has loaded.'),
        p('The viewer is ', b('100% open source'), ' (MIT): ',
          h('a', { class: C.link, attrs: { href: 'https://github.com/rajmondx/transaction-viewer', target: '_blank', rel: 'noopener noreferrer' }, text: 'github.com/rajmondx/transaction-viewer' }),
          ' — every line of it, including what happens with your data, is readable there.')),

      // ---- FAQ ----
      h('h3', { class: 'mb-1 mt-2 flex items-center gap-2 text-[15px] font-semibold' }, Ic(HelpCircle, 'size-4'), 'FAQ'),

      faq('Where is my data saved?',
        p('Uploaded transactions live in ', b('IndexedDB'), '; your category settings, filters, table layout and theme in ', b('localStorage'), ' — both are browser storage on this device only. Nothing is ever uploaded.'),
        p('Caveat: clearing the site data in your browser deletes the transactions as well. Keep a backup of your category settings via ', b('Categories → Export JSON'), ', and you can always re-import the same CSV files.')),

      faq('Which CSV files can I upload?',
        p('The export layout of Alternative Bank Schweiz (and similar Swiss bank exports) is built in. Add statements with the ', b('Add CSV'), ' button (top right, or on the CSV page) — or just drop one or more files anywhere on the page, on any tab. A page without data shows a ', b('Upload first a CSV'), ' box: clicking it opens the same file picker. Multiple files and multiple banks at once are fine, they are merged into one list.'),
        p('No statement at hand? The same box has ', b('Load demo data'), ' — an anonymized, English sample statement (common Swiss, German and online shops) that is stored and removed like any other file, so you can try everything before your real data goes in.'),
        p('For other formats, open ', b('Mappers…'), ' on the CSV page: map the columns of your header row once (booking date, description, credit/debit or a signed amount, optional transaction ID, IBAN, value date). The mapper is saved locally and applied to every future upload of that format.'),
        p(b('Automatic de-duplication:'), ' upload several statements that share transactions — the same month twice, a monthly plus a yearly export, or overlapping statements from different banks — and each transaction is still counted ', b('once'), '. Rows are matched by transaction ID + IBAN + amount (by exact content when a file has no ID), so re-uploading never creates duplicates, while the two legs of an internal transfer stay visible as two rows.')),

      faq('Can I drop JSON files too?',
        p('Yes — drop a ', b('.json'), ' anywhere on the page and the app recognizes what it is: a ', b('category settings'), ' file (it has a ', b('categories'), ' list) goes straight into your settings files and opens in the Categories page, a ', b('CSV schema'), ' (it has a ', b('columns'), ' mapping) goes into the mapper registry and is offered on the next upload. A settings export with several bundles inside is imported bundle by bundle. Existing names are only replaced after you confirm it.'),
        p('The same two kinds have their own buttons too: ', b('Categories → Import JSON'), ' and ', b('Mappers… → Import mapper JSON'), '.')),

      faq('How does categorization work?',
        p('Open the ', b('Categories'), ' page. Each category has rules that match against the description text, optionally also against IBANs, plus an optional date range. Rules can be case-sensitive (Aa), fuzzy (≈) or regex (.*).'),
        p('The order in the flat list is the ', b('priority'), ': a transaction is assigned to the first matching category. Categories can have sub-categories (indentation = parent/child); in the Spending view, sub-category amounts roll up into the parent.'),
        p('Two categories claiming the same transaction is never an error — the one listed first simply takes it, and a category that only groups other categories can even be empty on purpose. Because that is invisible otherwise (a losing category just shows ', b('0 tx'), ' like a broken one would), the sidebar ', b('Conflicts'), ' list and an amber note on the card spell it out: how many loaded transactions this category ', b('would'), ' match, how many stay, and which category higher up took the rest. A rule identical to one already decided above gets a ⚠ in its own row, and a ', b('tag'), ' used twice is called out in red, since those merge into one row in the tree. Nothing is reordered or changed for you — use the ↑ ↓ arrows when the rows should go to the other category.'),
        p('Click a conflict — the amber note, the ⚠ on a rule, or the line in the sidebar — and the card expands to the transactions behind it. Each one lists every rule that claims it: the rule that ', b('decided'), ' the row in green, the ones that matched but were ', b('overruled'), ' in red, so it is obvious which line to move up (or delete).'),
        p('Everything that matches no rule lands in ', b('Uncategorized'), ' — the Spending footer shows the share of expenses that is categorized.'),
        p(b('Auto Colorize'), ' colors the whole bundle in one click: top-level categories get a basic palette color, every sub-category a slightly lighter shade of its parent, so the charts and the legend stay readable.')),

      faq('What does “Let AI write the categories” do?',
        p('It writes a ', b('prompt'), ' for you — the app never contacts an AI itself. Copy the prompt into ChatGPT, Claude, Gemini or a local model, add your CSV (or the most important lines of it) to that chat, and paste what the model returns back here as ', b('Raw JSON'), ' — then ', b('Save'), '.'),
        p('The prompt describes the exact format and the matching rules (first match wins, case-insensitive contains, parent/child, colors), lists your current categories so the AI extends them instead of replacing them, and asks for JSON only.'),
        p(b('Add CSV into prompt'), ' puts your transactions into the prompt; the dialog notes that a model provider may train on what you share — at your own discretion. With it on and more than 150 rows, the app shrinks the list first: rows of the same IBAN whose text is at least 50 % identical become one line with a count and a sum, and only the 150 most frequent lines go in.'),
        p('With the toggle off, the prompt carries only your current categories, so add a few real booking texts to the chat yourself.')),

      faq('How do I see where my money went? (Spending page)',
        p('The ', b('Spending'), ' page is a matrix of category × month. Pick which settings file to apply, limit the date range, toggle months on/off, hide categories with their checkboxes, and switch the numbers between ', b('Expenses'), ', ', b('Income'), ' and ', b('Net'), '.'),
        p('Under ', b('Average'), ' (below the month toggles), ', b('Average Column'), ' adds a column next to Total with the row Total ÷ the selected months, and ', b('Only Averages'), ' hides the month columns entirely, leaving Category with Total and Average. The two are mutually exclusive — each turns the other off; clicking the active one again turns it off.'),
        p('Click the ▸ arrow of a row to expand the individual transactions of that category (striped list). Column widths are resizable — drag the right edge of any header cell, double-click the handle to let it size itself again.'),
        p('Below the table, the ', b('Monthly'), ' chart and the ', b('Share'), ' chart each take a full row of their own (the monthly one scrolls sideways when you have many months, so it can never squeeze the share chart away). In the Share chart every category name is fully readable: from tablet width up it gets its own column, on a phone it is written inside the bar (in a color that contrasts with the fill) or right after it when the bar is too short. The ', b('Sub-categories'), ' toggle adds each sub-category as its own row, in a lighter shade, directly under its top-level category — percentages stay relative to the top level, so nothing counts twice. The cards at the bottom summarize income, expenses, net, transaction count and categorized share for the current view.'),
        p('The row numbers end with ', b('Total'), ', and when an average mode is on the ', b('Average'), ' column sits just before it.')),

      faq('How can I create printer-friendly PDFs?',
        p('Use the ', b('print icon'), ' in the header (top right). On the CSV page you choose columns, merges (e.g. one signed Amount column), row scope, sort order, landscape, page numbers and font; on the Spending page you choose whether to include the graphs, which summary values to print, and — independently of the screen — ', b('Add Average Column'), ' or ', b('Only Averages'), '.'),
        p('Both dialogs remember what you last printed: reopen them and the same options are already ticked (stored in ', b('localStorage'), ', per page). Fonts and sizes are shared between the two.'),
        p('The document opens in a print dialog — pick ', b('Save as PDF'), ' as the destination to keep it as a file. Output is black-on-white, hidden categories and months are left out.')),

      faq('How to export my categories?',
        p('On the ', b('Categories'), ' page use ', b('Export JSON'), ' — it downloads the currently open settings file (all categories, rules, colors). ', b('Import JSON'), ' loads such a file back, ', b('New'), ' / ', b('Duplicate'), ' create additional settings files you can switch between, and ', b('Set as default'), ' picks the one used on startup. This is also your backup when switching browser or device.')),

      faq('How do I copy values out of a table?',
        p(b('One click'), ' on a cell selects exactly that cell — ', b('Ctrl+C'), ' copies the single value you picked (works on the ', b('CSV'), ' and the ', b('Spending'), ' table). Clicking a checkbox, a category chip or the ▸ arrow keeps its normal meaning.'),
        p(b('Double-click'), ' a cell on the ', b('CSV'), ' page and the whole column is marked instead, with all its values selected so ', b('Ctrl+C'), ' copies one value per line (handy for pasting into Excel). A single click afterwards clears the marked column. Both are mouse-only on purpose, so tapping on a phone never triggers them.')),

      faq('Can I install it? Does it work offline?',
        p('Yes — it is a PWA. In Chrome/Edge open the browser menu and choose ', b('Install app'), ' (or the install icon in the address bar); on iPhone use ', b('Share → Add to Home Screen'), '. It then opens as its own app window.'),
        p('After the first load, the app shell is cached, so it keeps working without internet — all processing and storage happen on your hardware anyway.')),

      faq('Any suggestions — can you please support my bank?',
        p('Very welcome! Write to ', mailLink(), ', or open an issue on ', b('GitHub'), ': ',
          h('a', { class: C.link, attrs: { href: 'https://github.com/rajmondx/transaction-viewer', target: '_blank', rel: 'noopener noreferrer' }, text: 'rajmondx/transaction-viewer' }),
          ' — the whole viewer is 100% open source.'),
        p('For a ', b('new bank format'), ': please attach only the ', b('header row'), ' of your CSV export (the very first line with the column names) — no transaction data is needed, and please don’t send any.'),
        p('For ', b('features and suggestions'), ': describe what you are missing; this viewer is built around everyday personal-finance use, so most small ideas are quick to add.'),
        h('p', { class: 'flex flex-wrap items-center gap-x-4 gap-y-1 pt-1' },
          Ic(Mail, 'size-3.5'), h('span', {}, 'Email: ', mailLink()),
          Ic(Phone, 'size-3.5'), h('span', {}, 'Phone: ', h('a', { class: C.link, attrs: { href: 'tel:0041787900677' }, text: '0041 78 790 06 77' }))),
      )),
  );
}
