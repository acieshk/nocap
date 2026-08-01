import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitFrames,
  averageFrames,
  expandRange,
  planeRange,
  leakScore,
} from '../src/splitter.js';

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
