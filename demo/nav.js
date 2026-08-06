/**
 * One nav for every page.
 *
 * Kept here rather than copied into every page so a new one cannot end up
 * missing from the rest. Each page ships the shell markup and an empty
 * `<aside class="side">`, and this fills it in. It writes chrome only, and
 * never touches anything to do with a secret.
 */
const PAGES = [
  ['index.html', 'Overview'],
  ['api.html', 'API'],
  ['sandbox.html', 'Sandbox'],
  ['styling.html', 'Styling'],
  ['pairing.html', 'Background pairing'],
  ['contrast.html', 'Contrast'],
  ['scenarios.html', 'Scenarios'],
  ['algorithms.html', 'Algorithms & comfort'],
  ['challenge.html', 'Scraping challenge'],
  ['scratch.html', 'Scratch to reveal'],
  ['fake.html', 'Fake value'],
  ['security.html', 'Security check'],
];

// A bare directory URL serves index.html, so an empty last segment is the home
// page rather than no match.
const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

document.querySelector('.side').innerHTML = `
  <a class="brand" href="index.html">nocap<small>Unreadable to scrapers. Defeats a still, not a recording.</small></a>
  <nav>${PAGES.map(([href, label]) =>
    `<a href="${href}"${href.toLowerCase() === here ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('')}</nav>
  <div class="foot">
    <a href="https://github.com/acieshk/nocap">GitHub</a> &middot;
    <a href="https://github.com/acieshk/nocap#readme">Docs</a>
  </div>`;
