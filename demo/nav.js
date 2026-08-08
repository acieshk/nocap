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
  ['Attack it', [
    ['security.html', 'Security check'],
    ['challenge.html', 'Scraping challenge'],
  ]],
  ['Experimental', [
    ['scratch.html', 'Scratch to reveal'],
    ['fake.html', 'Fake value'],
  ]],
];

// A bare directory URL serves index.html, so an empty last segment is the home
// page rather than no match.
const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

document.querySelector('.side').innerHTML = `
  <a class="brand" href="index.html">nocap<small>Unreadable to scrapers. Defeats a still, not a recording.</small></a>
  <nav>${GROUPS.map(([label, pages]) =>
    `<span class="grp">${label}</span>` + pages.map(([href, text]) =>
      `<a href="${href}"${href.toLowerCase() === here ? ' aria-current="page"' : ''}>${text}</a>`
    ).join('')
  ).join('')}</nav>
  <div class="foot">
    <a href="promo.html">Promo reel</a> &middot;
    <a href="https://github.com/acieshk/nocap">GitHub</a> &middot;
    <a href="https://github.com/acieshk/nocap#readme">Docs</a>
  </div>`;
