/**
 * Find a secret that has leaked into the page.
 *
 * nocap keeps a value out of the DOM, but an integration puts it in plenty of
 * other places without meaning to: an `<input>` you kept for editing, an
 * `aria-label` added for accessibility, a `title` attribute, a debug line in
 * localStorage. Every one of those is read instantly by the same scrapers and
 * DOM-reading agents the canvas defeats, and none of them show up in View
 * Source, so they are easy to miss.
 *
 * This is the same idea as shipping `averageFrames()` and `denoisedLeak()`: the
 * attack, in the public API, so a claim can be checked rather than believed.
 * Those two attack the pixels; this attacks the page around them.
 *
 * ⚠️ It takes the plaintext, because it has to search for it. That means the
 * value exists in one more place while the call runs. Use it in development and
 * in tests, not in a production render path.
 */

/**
 * @param {string} secret  the value that should not be findable
 * @param {object} [opts]
 * @param {Document} [opts.document]  defaults to the global document
 * @param {boolean} [opts.fetchSource=true]  re-fetch the URL to see what a
 *        scraper or `curl` receives. Set false to skip the network round trip.
 * @returns {Promise<{
 *   clean: boolean, found: string[], surfaces: Record<string, boolean|string>,
 *   report: string
 * }>}
 */
export async function auditPage(secret, opts = {}) {
  const doc = opts.document ?? globalThis.document;
  if (!doc) throw new Error('auditPage: no document (browser only)');
  const needle = String(secret ?? '');
  if (!needle) throw new Error('auditPage: nothing to search for');

  const surfaces = {};

  // What a scraper, curl, or View Source receives. Distinct from the live DOM:
  // anything injected by JS is absent here and present there.
  if (opts.fetchSource !== false) {
    try {
      const res = await fetch(location.href, { cache: 'reload' });
      surfaces.htmlSource = (await res.text()).includes(needle);
    } catch {
      surfaces.htmlSource = 'unavailable';
    }
  }

  surfaces.dom = doc.documentElement.outerHTML.includes(needle);
  surfaces.innerText = (doc.body?.innerText ?? '').includes(needle);
  surfaces.selection = selectionText(doc).includes(needle);

  // Form control values live in none of the surfaces above, so a page can look
  // clean everywhere else and still hand the value to querySelectorAll('input').
  surfaces.formValues = [...doc.querySelectorAll('input, textarea, select')]
    .some((el) => String(el.value ?? '').includes(needle));

  // What a screen reader and most browser agents actually consume.
  surfaces.a11yTree = [...doc.querySelectorAll('*')].some((el) =>
    ['aria-label', 'aria-description', 'aria-valuetext', 'title', 'alt', 'placeholder']
      .some((attr) => (el.getAttribute?.(attr) ?? '').includes(needle))
  );

  // Open shadow roots are ordinary DOM to anything that walks them.
  surfaces.shadowDom = [...doc.querySelectorAll('*')]
    .some((el) => el.shadowRoot?.innerHTML?.includes(needle));

  surfaces.storage = ['localStorage', 'sessionStorage'].some((store) => {
    try {
      const s = globalThis[store];
      return Object.keys(s).some((k) => `${k}${s.getItem(k)}`.includes(needle));
    } catch {
      return false;
    }
  });

  // Not a search — a statement. The canvas has to hold the arranged image or
  // nobody could read it, so a run of frames averaged together is the plaintext.
  // No mode changes this, and reporting it as clean would be a lie.
  surfaces.canvas = 'recoverable';

  const found = Object.entries(surfaces)
    .filter(([, hit]) => hit === true)
    .map(([name]) => name);

  return { clean: found.length === 0, found, surfaces, report: format(surfaces, found) };
}

/**
 * Reads the current selection without disturbing it.
 *
 * Select-All + Copy is one of the cheapest ways to lift a page, so it is worth
 * checking — but doing so clobbers whatever the user had selected, which is why
 * the ranges are saved and put back.
 */
function selectionText(doc) {
  const sel = doc.defaultView?.getSelection?.();
  if (!sel || !doc.body) return '';
  const saved = [];
  for (let i = 0; i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i));
  try {
    sel.removeAllRanges();
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    sel.addRange(range);
    return sel.toString();
  } finally {
    sel.removeAllRanges();
    for (const r of saved) sel.addRange(r);
  }
}

function format(surfaces, found) {
  const label = {
    htmlSource: 'HTML source (View Source, curl, scrapers)',
    dom: 'Live DOM (DevTools, most agents)',
    innerText: 'Rendered text (Reader mode, innerText)',
    selection: 'Select All + Copy',
    formValues: 'Form control values',
    a11yTree: 'Accessible name (aria-label, title, alt)',
    shadowDom: 'Open shadow roots',
    storage: 'localStorage / sessionStorage',
    canvas: 'Canvas pixels (average a run of frames)',
  };
  const lines = Object.entries(surfaces).map(([key, hit]) => {
    const mark = hit === true ? '✗' : hit === 'recoverable' ? '!' : hit === 'unavailable' ? '?' : '✓';
    const note = hit === true ? 'CONTAINS IT'
      : hit === 'recoverable' ? 'recoverable with DevTools — inherent'
      : hit === 'unavailable' ? 'could not check'
      : 'not found';
    return `  ${mark} ${(label[key] ?? key).padEnd(42)} ${note}`;
  });
  const head = found.length
    ? `nocap audit: LEAKED in ${found.length} surface${found.length > 1 ? 's' : ''} — ${found.join(', ')}`
    : 'nocap audit: not found in any DOM surface';
  return [head, ...lines].join('\n');
}
