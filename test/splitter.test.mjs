import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitFrames,
  averageFrames,
  expandRange,
  planeRange,
  leakScore,
  boxBlur,
  denoisedLeak,
  maxAmplitudeFor,
} from '../src/splitter.js';

/** Digit-like strokes: the feature size that decides legibility. */
function strokeImage(w, h, stroke) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 20;
    data[i + 3] = 255;
  }
  const on = (x, y) => {
    const p = (y * w + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = 235;
  };
  const cell = Math.floor(w / 8);
  const gap = Math.floor(cell * 0.25);
  for (let c = 0; c < 8; c++) {
    const x0 = c * cell + gap;
    const x1 = (c + 1) * cell - gap;
    const y0 = Math.floor(h * 0.2);
    const y1 = Math.floor(h * 0.8);
    const ym = (y0 + y1) >> 1;
    const segs = [[x0, y0, x1, y0], [x0, ym, x1, ym], [x0, y1, x1, y1],
                  [x0, y0, x0, ym], [x1, y0, x1, ym], [x0, ym, x0, y1], [x1, ym, x1, y1]];
    segs.forEach(([ax, ay, bx, by], i) => {
      if ((c + i) % 3 === 0) return;
      for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++)
        for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++)
          for (let dy = 0; dy < stroke; dy++)
            for (let dx = 0; dx < stroke; dx++)
              if (x + dx < w && y + dy < h) on(x + dx, y + dy);
    });
  }
  return { width: w, height: h, data };
}

/**
 * A structured image — noise has no structure to leak, so it cannot show the
 * difference between modes. Soft blobs plus hard edges stand in for a picture.
 */
function sceneImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const blob = 128 + 100 * Math.sin(x / 9) * Math.cos(y / 7);
      const edge = x > w * 0.6 && y > h * 0.5 ? 60 : 0;
      data[p] = blob + edge;
      data[p + 1] = blob * 0.7 + edge;
      data[p + 2] = 255 - blob * 0.5;
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function lcg(seed = 1) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function noiseImage(w, h, seed = 1) {
  const rng = lcg(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rng() * 256;
    data[i + 1] = rng() * 256;
    data[i + 2] = rng() * 256;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** Mean absolute difference over RGB only. */
function mad(a, b) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a.data[i + c] - b.data[i + c]);
      n++;
    }
  }
  return sum / n;
}

const MODES = [
  { mode: 'amplitude', amplitude: 64 },
  { mode: 'interleave', amplitude: 0, fill: 128 },
  { mode: 'interleave', amplitude: 32, fill: 128 },
  { mode: 'interleave', amplitude: 24, fill: 0 },
];

for (const base of MODES) {
  for (const frames of [2, 3, 4]) {
    const cfg = { ...base, frames, rng: lcg(9) };
    const name = `${base.mode}(amp=${base.amplitude},fill=${base.fill ?? '-'}) x${frames}`;

    test(`${name}: planes average back to the source`, () => {
      const src = noiseImage(48, 48);
      const planes = splitFrames(src, cfg);
      assert.equal(planes.length, frames);
      const recovered = expandRange(averageFrames(planes), planeRange(cfg));
      // Only per-plane rounding to uint8 stands between the mean and the source.
      assert.ok(mad(recovered, src) < 2.5, `mean abs error ${mad(recovered, src)}`);
    });

    test(`${name}: no plane leaks the source at full fidelity`, () => {
      const src = noiseImage(48, 48, 7);
      for (const p of splitFrames(src, cfg)) {
        assert.ok(mad(expandRange(p, planeRange(cfg)), src) > 20, 'plane too close to source');
      }
    });
  }
}

test('decoy mode averages back and keeps the decoy out of the mean', () => {
  const src = noiseImage(48, 48, 2);
  const decoy = noiseImage(48, 48, 99);
  const cfg = { mode: 'decoy', frames: 2, amplitude: 64, decoy };
  const planes = splitFrames(src, cfg);
  const recovered = expandRange(averageFrames(planes), planeRange(cfg));
  assert.ok(mad(recovered, src) < 2.5, `mean abs error ${mad(recovered, src)}`);
});

test('no clipping at either extreme, any amplitude', () => {
  const w = 8;
  const h = 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    const v = i < data.length / 2 ? 0 : 255; // solid black row, solid white row
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  const src = { width: w, height: h, data };

  for (const amplitude of [16, 64, 127]) {
    const cfg = { frames: 2, amplitude, rng: lcg(4) };
    const recovered = expandRange(averageFrames(splitFrames(src, cfg)), planeRange(cfg));
    assert.ok(mad(recovered, src) < 2, `amplitude ${amplitude} clipped`);
  }
});

test('chroma=0 shares one noise draw across channels', () => {
  const src = noiseImage(32, 32, 3);
  const cfg = { frames: 2, amplitude: 64, chroma: 0, rng: lcg(5) };
  const [p0] = splitFrames(src, cfg);
  const { lo, hi } = planeRange(cfg);
  const span = (hi - lo) / 255;
  for (let i = 0; i < p0.data.length; i += 4) {
    const d = [0, 1, 2].map((c) => p0.data[i + c] - (lo + src.data[i + c] * span));
    assert.ok(Math.abs(d[0] - d[1]) <= 1 && Math.abs(d[1] - d[2]) <= 1);
  }
});

test('interleave carries each cell in exactly one plane', () => {
  const src = noiseImage(32, 32, 11);
  const cfg = { mode: 'interleave', frames: 3, amplitude: 0, fill: 128, rng: lcg(6) };
  const planes = splitFrames(src, cfg);
  for (let i = 0; i < src.data.length; i += 4) {
    const nonFill = planes.filter((p) => Math.abs(p.data[i] - 128) > 1).length;
    assert.ok(nonFill <= 1, `${nonFill} planes carry pixel ${i / 4}`);
  }
});

test('contrast pre-emphasis steepens the perceived image', () => {
  // The output band is fixed at [lo, hi], so contrast cannot widen it. What it
  // does is push values toward the ends of that band — more local contrast,
  // paid for by clipped highlights and shadows. Measure the spread, not the range.
  const src = noiseImage(32, 32, 13);
  const flat = { frames: 2, amplitude: 96, contrast: 1, rng: lcg(8) };
  const boosted = { ...flat, contrast: 2.5 };

  const stddev = (cfg) => {
    const avg = averageFrames(splitFrames(src, cfg));
    const vals = [];
    for (let i = 0; i < avg.data.length; i += 4) vals.push(avg.data[i]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  };

  assert.ok(stddev(boosted) > stddev(flat) * 1.1, 'contrast boost did not steepen');
});

test('only value randomization actually masks a single plane', () => {
  // The claim under test: splits that partition a dimension the eye does not
  // need for recognition (colour, sampling density) leave the picture legible
  // in one plane. Only randomizing pixel *values* removes it.
  const src = sceneImage(96, 96);
  const worst = (cfg) =>
    Math.max(...splitFrames(src, { rng: lcg(21), ...cfg }).map((p) => leakScore(p, src)));

  const channels = worst({ mode: 'channels', amplitude: 0 });
  const interleave = worst({ mode: 'interleave', frames: 2, amplitude: 0 });
  const amplitude = worst({ mode: 'amplitude', frames: 2, amplitude: 127 });

  // A channel plane keeps full spatial resolution and is a linear function of
  // source luma, so it correlates perfectly. Splitting colour hides nothing.
  assert.ok(channels > 0.95, `channels leak ${channels.toFixed(3)} should be ~1`);
  // Interleaving drops pixels, but the ones that remain are untouched.
  assert.ok(interleave > 0.5, `interleave leak ${interleave.toFixed(3)} should be high`);
  // Value randomization is the only split that actually removes the signal.
  assert.ok(amplitude < 0.05, `amplitude leak ${amplitude.toFixed(3)} should be ~0`);
  assert.ok(amplitude < interleave && interleave < channels, 'ordering should hold');
});

test('amplitude is the only lever that moves the leak', () => {
  // Correlation falls off steeply with amplitude and barely responds to
  // anything else. This is why 96-127 is the usable band and 64 is not:
  // at 64 a plane still correlates ~0.39 with the source.
  const src = sceneImage(96, 96);
  const worst = (cfg) =>
    Math.max(...splitFrames(src, { rng: lcg(23), ...cfg }).map((p) => leakScore(p, src)));

  const curve = [32, 64, 96, 127].map((amplitude) => worst({ amplitude, frames: 2 }));
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i] < curve[i - 1], `leak should fall monotonically: ${curve}`);
  }
  assert.ok(curve[0] > 0.6, `amplitude 32 should leak badly, got ${curve[0].toFixed(3)}`);
  assert.ok(curve[3] < 0.05, `amplitude 127 should not leak, got ${curve[3].toFixed(3)}`);

  // Frame count is not a substitute for amplitude.
  assert.ok(worst({ amplitude: 32, frames: 4 }) > 0.4, 'more planes should not rescue low amplitude');
});

test('stacking noise on interleave is what rescues it', () => {
  const src = sceneImage(96, 96);
  const worst = (amplitude) =>
    Math.max(
      ...splitFrames(src, { mode: 'interleave', frames: 2, amplitude, rng: lcg(22) }).map((p) =>
        leakScore(p, src)
      )
    );
  assert.ok(worst(96) < worst(0) * 0.6, 'stacked noise did not reduce the leak');
});

test('leakScore ignores contrast and brightness shifts', () => {
  // An attacker undoes those for free, so the metric must not credit them.
  const src = sceneImage(64, 64);
  const shifted = { width: 64, height: 64, data: new Uint8ClampedArray(src.data.length) };
  for (let i = 0; i < src.data.length; i += 4) {
    for (let c = 0; c < 3; c++) shifted.data[i + c] = 40 + src.data[i + c] * 0.4;
    shifted.data[i + 3] = 255;
  }
  assert.ok(leakScore(shifted, src) > 0.99, 'contrast/brightness should not lower the score');
});

test('interleave fill is pulled into the noise headroom', () => {
  // Requesting a black fill alongside stacked noise must not clip.
  const cfg = { mode: 'interleave', frames: 2, amplitude: 24, fill: 0, rng: lcg(3) };
  const src = noiseImage(32, 32, 17);
  const recovered = expandRange(averageFrames(splitFrames(src, cfg)), planeRange(cfg));
  assert.ok(mad(recovered, src) < 2.5, `clipped: ${mad(recovered, src)}`);

  // At amplitude 0 there is nothing to protect, so black fill survives intact.
  assert.equal(planeRange({ mode: 'interleave', frames: 2, amplitude: 0, fill: 0 }).lo, 0);
});

/* ---------------------------------------------------------------- colour -- */

test('adaptive mode reproduces authored colours exactly', () => {
  const src = sceneImage(48, 48);
  const planes = splitFrames(src, { amplitude: 110, adaptive: true, rng: lcg(31) });
  // No range compression, so the mean is the source itself, not a remapping.
  assert.ok(mad(averageFrames(planes), src) < 2, 'adaptive drifted from the source');
});

test('adaptive caps amplitude to per-pixel headroom rather than clipping', () => {
  // Solid black and solid white have zero headroom: any noise would clip, and
  // clipping is what breaks the zero-sum property.
  const w = 8;
  const h = 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    const v = i < data.length / 2 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  const src = { width: w, height: h, data };
  const planes = splitFrames(src, { amplitude: 110, adaptive: true, rng: lcg(32) });
  assert.ok(mad(averageFrames(planes), src) < 1, 'adaptive clipped at the extremes');
  // ...and that headroom being zero means those pixels are unmasked. Stated as
  // a test so the trade-off cannot be forgotten.
  assert.ok(leakScore(planes[0], src) > 0.9, 'extremes should be fully exposed');
});

test('maxAmplitudeFor reports the ceiling a palette allows', () => {
  assert.equal(maxAmplitudeFor(['#000000', '#ffffff']), 0);
  assert.equal(maxAmplitudeFor(['#808080']), 127);
  assert.ok(maxAmplitudeFor(['#404a58', '#a8b4c4']) > 30);
  assert.equal(maxAmplitudeFor([[10, 200, 128]]), 10);
});

/* ------------------------------------------------------- denoise attack --- */

test('per-pixel noise is removable by a blur; coarser blocks are not', () => {
  // The finding that sets noiseScale: white noise sits above the frequencies
  // strokes occupy, so a small blur separates them. Coarse noise shares the
  // band with the content, where no radius helps.
  const src = strokeImage(320, 64, 5);
  const worst = (noiseScale) => {
    const [p] = splitFrames(src, { amplitude: 110, contrast: 2.2, noiseScale, rng: lcg(33) });
    return { raw: leakScore(p, src), best: denoisedLeak(p, src, 8) };
  };

  const fine = worst(1);
  const coarse = worst(6);

  // Blurring must actually help the attacker against per-pixel noise...
  assert.ok(fine.best.leak > fine.raw * 1.8, `blur should amplify: ${JSON.stringify(fine)}`);
  assert.ok(fine.best.radius > 0, 'attacker should prefer a non-zero radius');
  // ...and must not help at all once the block reaches the stroke width.
  assert.ok(
    coarse.best.leak < fine.best.leak * 0.5,
    `coarse blocks should resist: ${JSON.stringify(coarse)} vs ${JSON.stringify(fine)}`
  );
  // Raw leak alone cannot see any of this — the reason denoisedLeak exists.
  assert.ok(Math.abs(fine.raw - coarse.raw) < 0.12, 'raw leak is blind to block size');
});

test('boxBlur radius 0 is identity', () => {
  const src = sceneImage(16, 16);
  assert.equal(boxBlur(src, 0), src);
});

/* ------------------------------------------------------------------ fake -- */

test('decoys match the source shape exactly', async () => {
  const { fakeLike } = await import('../src/fake.js');
  const shape = (s) => s.replace(/[0-9]/g, 'D').replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a');
  for (const src of ['4471-0092-8834', 'NKQ2-7T4W-ZP19', '884 201', '+44 20 7946 0958']) {
    for (const mode of ['auto', 'number', 'text', 'random']) {
      const fake = fakeLike(src, { mode, rng: lcg(src.length + mode.length) });
      assert.equal(fake.length, src.length, `${mode} changed the length of ${src}`);
      if (mode === 'auto') {
        // A decoy in the wrong shape reveals the mechanism, which is worse
        // than showing noise.
        assert.equal(shape(fake), shape(src), `${mode} broke the shape of ${src}`);
      }
      // Separators are structure, not content, and must survive every mode.
      assert.equal(fake.replace(/[0-9A-Za-z]/g, ''), src.replace(/[0-9A-Za-z]/g, ''));
      assert.notEqual(fake, src, 'decoy identical to the source protects nothing');
    }
  }
});

test('detectFormat recognises the kinds it generates for', async () => {
  const { detectFormat } = await import('../src/fake.js');
  assert.equal(detectFormat('2026-09-01').kind, 'date-iso');
  assert.equal(detectFormat('01/09/2026').kind, 'date-dmy');
  assert.equal(detectFormat('09/28').kind, 'expiry');
  assert.equal(detectFormat('4539578763621486').kind, 'card');
  assert.equal(detectFormat('NKQ2-7T4W-ZP19').kind, 'alphanumeric');
  assert.equal(detectFormat('hold the line').kind, 'text');
});

test('semantic decoys survive a second look', async () => {
  const { fakeLike, passesLuhn } = await import('../src/fake.js');
  // A month of 83 or a card failing its checksum announces that the value is
  // manufactured, which defeats the point of a decoy.
  for (let i = 0; i < 30; i++) {
    const d = fakeLike('2026-09-01', { rng: lcg(i + 1) });
    const [, mm, dd] = d.split('-').map(Number);
    assert.ok(mm >= 1 && mm <= 12, `bad month in ${d}`);
    assert.ok(dd >= 1 && dd <= 31, `bad day in ${d}`);

    const card = fakeLike('4539578763621486', { rng: lcg(i + 100) });
    assert.ok(passesLuhn(card), `${card} fails Luhn`);
  }
});

/* --------------------------------------------------------------- packaging -- */

test('the package barrel imports outside a browser', async () => {
  // Next, Astro and Remix all evaluate module top-level on the server, so a bare
  // `import 'nocap'` must not throw there. secret.js defines a web component, so
  // this only holds because its base class falls back when HTMLElement is absent.
  const m = await import('../src/index.js');
  for (const name of ['splitFrames', 'checkPalette', 'fakeLike', 'Flicker', 'NocapSecret']) {
    assert.ok(name in m, `missing export ${name}`);
  }
  // The DOM-free half has to actually run server-side, not merely import.
  assert.equal(m.checkPalette({ color: '#9ea6b4', background: '#6b7280' }).grade, 'good');
  assert.equal(m.fakeLike('4471-0092-8834', { rng: lcg(3) }).length, 14);
});

test('linear light keeps colours exact AND masks', async () => {
  // Both properties, because fixing one at the expense of the other is exactly
  // what went wrong: offsetting in light gave exact colour and a +/-13 swing.
  const { checkPalette } = await import('../src/palette.js');
  const solid = (v) => {
    const d = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    return { width: 8, height: 2, data: d };
  };
  const light = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const code = (x) => 255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);

  for (const v of [0x5a, 0x99, 0xbc]) {
    const pl = splitFrames(solid(v), { frames: 2, amplitude: 110, chroma: 0, hardness: 1, linearLight: true });
    const perceived = code((light(pl[0].data[0]) + light(pl[1].data[0])) / 2);
    assert.ok(Math.abs(perceived - v) < 2, `${v} perceived as ${perceived.toFixed(1)}`);
    // A mid-tone must get a swing worth having, not the ~13 the old version gave.
    assert.ok(Math.abs(pl[0].data[0] - pl[1].data[0]) / 2 > 55, `swing too small at ${v}`);
  }

  // The shipped default palette has to be one the library would recommend.
  assert.equal(checkPalette({ color: '#9ea6b4', background: '#6b7280' }).grade, 'good');
});

test('a decoy can be derived from scrambled glyphs', async () => {
  // scramble empties the plaintext and keeps glyphs out of order, so fake mode
  // has to reassemble to know what shape to imitate. Guarding on the plaintext
  // alone meant enabling both silently produced no decoy at all.
  const { fakeLike, detectFormat } = await import('../src/fake.js');
  const secret = '4471-0092-8834';
  const pairs = [...secret].map((ch, i) => [ch, i]);
  const rng = lcg(12);
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const out = [];
  pairs.forEach(([ch, slot]) => { out[slot] = ch; });
  const reassembled = out.join('');

  assert.equal(reassembled, secret, 'reassembly must restore the original order');
  assert.equal(detectFormat(reassembled).kind, detectFormat(secret).kind);
  const decoy = fakeLike(reassembled, { rng: lcg(13) });
  assert.equal(decoy.length, secret.length);
  assert.notEqual(decoy, secret);
});

/* ------------------------------------------------------------ regressions -- */

test('measureLeak scores against the mean, not plane 0', async () => {
  // It compared plane 0 with itself, which is a correlation of 1 by definition,
  // so Math.max returned 1.0 at every setting and the number meant nothing.
  const src = sceneImage(64, 64);
  const planes = splitFrames(src, { frames: 2, amplitude: 96, linearLight: true, rng: lcg(41) });
  const target = averageFrames(planes);
  assert.equal(leakScore(planes[0], planes[0]), 1, 'self-correlation must be 1');
  assert.ok(Math.max(...planes.map((p) => leakScore(p, target))) < 0.9,
    'against the mean the leak must be informative');
});

test('the documented defaults are the shipped defaults', async () => {
  // The README table drifted twice: it published a palette the code rejects as
  // unmaskable, and a contrast value from before linear light removed the band.
  const readme = await (await import('node:fs/promises')).readFile(
    new URL('../README.md', import.meta.url), 'utf8');
  const secret = await (await import('node:fs/promises')).readFile(
    new URL('../src/secret.js', import.meta.url), 'utf8');

  const palette = secret.match(/getAttribute\('color'\) \?\? '(#[0-9a-f]{6})'/)[1];
  const background = secret.match(/getAttribute\('background'\) \?\? '(#[0-9a-f]{6})'/)[1];
  assert.ok(readme.includes(palette), `README does not document color ${palette}`);
  assert.ok(readme.includes(background), `README does not document background ${background}`);

  for (const key of ['amplitude', 'contrast', 'hardness', 'chroma']) {
    const value = secret.match(new RegExp(`^\\s*${key}: ([\\d.]+),`, 'm'))[1];
    assert.ok(readme.includes(`| \`${key}\` | \`${value}\``),
      `README documents a different ${key} than the code's ${value}`);
  }
});

test('the shipped default palette is one checkPalette accepts', async () => {
  const { checkPalette } = await import('../src/palette.js');
  assert.equal(checkPalette({ color: '#9ea6b4', background: '#6b7280' }).grade, 'good');
  // And the pair the README used to document is genuinely unusable.
  assert.equal(checkPalette({ color: '#e8e8f0', background: '#14141a' }).grade, 'weak');
});

test('auditPage finds a secret in every surface it claims to check', async () => {
  // No browser here, so a minimal document stands in. This asserts the search
  // logic, not the DOM integration — the browser path is exercised in the demo.
  const { auditPage } = await import('../src/audit.js');
  const needle = '4471-0092-8834';
  const make = (over = {}) => ({
    documentElement: { outerHTML: over.dom ?? '<html></html>' },
    body: { innerText: over.innerText ?? '' },
    defaultView: null,
    createRange: () => ({ selectNodeContents() {} }),
    querySelectorAll: (sel) =>
      sel.includes('input') ? over.inputs ?? [] : over.all ?? [],
  });

  const clean = await auditPage(needle, { document: make(), fetchSource: false });
  assert.equal(clean.clean, true, `should be clean: ${clean.found}`);
  // Canvas is a statement, not a search: it must never be reported as clean.
  assert.equal(clean.surfaces.canvas, 'recoverable');

  const inInput = await auditPage(needle, {
    document: make({ inputs: [{ value: needle }] }), fetchSource: false });
  assert.deepEqual(inInput.found, ['formValues'], 'form values are invisible to every other check');

  const inLabel = await auditPage(needle, {
    document: make({ all: [{ getAttribute: (a) => (a === 'aria-label' ? needle : null) }] }),
    fetchSource: false });
  assert.deepEqual(inLabel.found, ['a11yTree'], 'an aria-label leaks to every screen reader and agent');

  await assert.rejects(() => auditPage('', { document: make() }), /nothing to search/);
});

test('strength presets are ordered and complete', async () => {
  const { STRENGTHS } = await import('../src/secret.js');
  const order = ['weak', 'medium', 'strong'];
  for (const name of order) {
    for (const key of ['amplitude', 'noiseScale', 'hardness']) {
      assert.ok(STRENGTHS[name][key] > 0, `${name}.${key} missing`);
    }
  }
  // The names have to mean something: each step must actually mask harder.
  for (let i = 1; i < order.length; i++) {
    const lo = STRENGTHS[order[i - 1]];
    const hi = STRENGTHS[order[i]];
    assert.ok(hi.amplitude > lo.amplitude, `${order[i]} must exceed ${order[i - 1]}`);
    assert.ok(hi.noiseScale >= lo.noiseScale, `${order[i]} block must not drop`);
  }
});

test('stronger presets leak less', async () => {
  const { STRENGTHS } = await import('../src/secret.js');
  const src = strokeImage(320, 64, 5);
  const leak = (s) => {
    const planes = splitFrames(src, {
      frames: 2, chroma: 0, linearLight: true, rng: lcg(17), ...STRENGTHS[s] });
    return Math.max(...planes.map((p) => leakScore(p, averageFrames(planes))));
  };
  assert.ok(leak('strong') < leak('weak'), 'strong must beat weak');
});

test('a strength preset applies all of its values, not just amplitude', async () => {
  // The first version dropped two thirds of every preset: explicit keys sat
  // after a spread and their fallbacks still read the defaults, so `strength`
  // moved amplitude and nothing else. Untestable while it was inline.
  const { resolveOptions, STRENGTHS } = await import('../src/secret.js');
  for (const [name, preset] of Object.entries(STRENGTHS)) {
    const got = resolveOptions({ strength: name }, 1);
    assert.equal(got.amplitude, preset.amplitude, `${name} amplitude`);
    assert.equal(got.hardness, preset.hardness, `${name} hardness`);
    assert.equal(got.noiseScale, preset.noiseScale, `${name} noiseScale`);
  }
  // Presets are authored at dpr 1 and scaled like the default.
  assert.equal(resolveOptions({ strength: 'strong' }, 2).noiseScale,
    STRENGTHS.strong.noiseScale * 2, 'preset block must scale with dpr');
  // An explicit attribute still wins over its part of the preset.
  const override = resolveOptions({ strength: 'weak', hardness: '0.9' }, 1);
  assert.equal(override.hardness, 0.9);
  assert.equal(override.amplitude, STRENGTHS.weak.amplitude, 'the rest stays');
  // No strength named: plain defaults, dpr-scaled.
  assert.equal(resolveOptions({}, 2).noiseScale, 6);
});
