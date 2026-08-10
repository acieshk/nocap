/**
 * One nav for every page.
 *
 * Kept here rather than copied into every page so a new one cannot end up
 * missing from the rest. Each page ships the shell markup and an empty
 * `<aside class="side">`, and this fills it in. It writes chrome only, and
 * never touches anything to do with a secret.
 *
 * Grouped by what the visitor is trying to do, because a flat list stopped
 * scanning at about eight entries and there are thirteen. The groups also say
 * what each page IS: a reference, a design tool, or an attack on the claim.
 */
const GROUPS = [
  ['Start', [
    ['index.html', 'Overview'],
    // The reel is the thirty seconds that sells the rest, so it sits second
    // in the rail rather than hidden in the footer, which is where it was:
    // display:none on desktop left the tiny .foot link as the only route.
    ['promo.html', 'Promo reel'],
    ['sandbox.html', 'Sandbox'],
    ['scenarios.html', 'Examples'],
  ]],
  ['Reference', [
    ['api.html', 'API'],
    ['styling.html', 'Styling'],
    ['algorithms.html', 'Algorithms & comfort'],
  ]],
  ['Design', [
    ['pairing.html', 'Background pairing'],
    ['contrast.html', 'Contrast'],
  ]],
  ['Verify it', [
    ['security.html', 'Security check'],
    ['challenge.html', 'Scraping challenge'],
  ]],
  ['Experimental', [
    ['motion.html', 'Motion vs averaging'],
    ['scratch.html', 'Scratch to reveal'],
    ['fake.html', 'Fake value'],
  ]],
];

// A bare directory URL serves index.html, so an empty last segment is the home
// page rather than no match.
const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

document.querySelector('.side').innerHTML = `
  <a class="brand" href="index.html">nocap<small>Unreadable to scrapers, and to a single capture.</small></a>
  <nav>${GROUPS.map(([label, pages]) =>
    `<span class="grp">${label}</span>` + pages.map(([href, text]) =>
      `<a href="${href}"${href.toLowerCase() === here ? ' aria-current="page"' : ''}>${text}</a>`
    ).join('')
  ).join('')
  }</nav>
  <div class="foot">
    <a href="promo.html">Promo reel</a> &middot;
    <a href="https://github.com/acieshk/nocap">GitHub</a> &middot;
    <a href="https://github.com/acieshk/nocap#readme">Docs</a>
  </div>`;
