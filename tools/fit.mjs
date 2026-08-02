/**
 * Fit a perceptual correction from demo/calibrate.html output.
 *
 *   node tools/fit.mjs nocap-calibration.json
 *
 * The hypothesis under test: the splitter averages in sRGB, but a display emits
 * light proportional to (v/255)^gamma and the eye integrates *light*, not code
 * values. Averaging a convex function overshoots, so a patch alternating
 * v±d should look brighter than v, by more as d grows and most of all at
 * mid-grey. Amplitude 0 is the control — error there is your matching accuracy,
 * not a real effect, and it gets subtracted out as bias.
 *
 * If the residual after fitting is small, the fix is to split in linear light.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/fit.mjs <calibration.json>');
  process.exit(1);
}
const data = JSON.parse(readFileSync(file, 'utf8'));
const trials = data.trials.filter((t) => t.matched != null);

/** Predicted match if the eye averages linear light at a given gamma. */
function predict(base, amp, gamma) {
  const lin = (v) => Math.pow(Math.max(0, Math.min(255, v)) / 255, gamma);
  const mean = (lin(base + amp) + lin(base - amp)) / 2;
  return 255 * Math.pow(mean, 1 / gamma);
}

// The amplitude-0 trials measure the observer, not the display. Remove that bias.
const control = trials.filter((t) => t.amplitude === 0);
const bias = control.length
  ? control.reduce((a, t) => a + t.error, 0) / control.length
  : 0;

const live = trials.filter((t) => t.amplitude > 0);
if (!live.length) {
  console.error('no trials with amplitude > 0');
  process.exit(1);
}

let best = { gamma: null, rms: Infinity };
for (let g = 1.0; g <= 3.2; g += 0.01) {
  let sum = 0;
  for (const t of live) {
    const resid = t.matched - bias - predict(t.base, t.amplitude, g);
    sum += resid * resid;
  }
  const rms = Math.sqrt(sum / live.length);
  if (rms < best.rms) best = { gamma: +g.toFixed(2), rms: +rms.toFixed(2) };
}

const meanErr = live.reduce((a, t) => a + (t.error - bias), 0) / live.length;
const rmsNull = Math.sqrt(live.reduce((a, t) => a + (t.error - bias) ** 2, 0) / live.length);

console.log(`display        ${data.refreshHz}Hz, dpr ${data.devicePixelRatio}`);
console.log(`trials used    ${live.length} (+${control.length} control)`);
console.log(`observer bias  ${bias.toFixed(1)} levels (from the amplitude-0 trials)`);
console.log();
console.log(`mean error     ${meanErr > 0 ? '+' : ''}${meanErr.toFixed(1)} levels  <- positive means the flicker looks LIGHTER`);
console.log(`best-fit gamma ${best.gamma}   residual RMS ${best.rms}`);
console.log(`no-correction  residual RMS ${rmsNull.toFixed(2)}`);
console.log();

if (best.rms < rmsNull * 0.6) {
  console.log(`VERDICT: gamma ${best.gamma} explains the mismatch. Split in linear light:`);
  console.log(`  encode -> v_lin = (v/255)^${best.gamma}; offset there; decode -> 255*x^(1/${best.gamma})`);
} else {
  console.log('VERDICT: gamma alone does not explain it. Per-base residuals:');
}

const hues = [...new Set(live.map((t) => t.hue ?? 'grey'))];
if (hues.length > 1) {
  console.log('per-channel gamma (one shared value means a single gamma fits all three):');
  for (const hue of hues) {
    const rows = live.filter((t) => (t.hue ?? 'grey') === hue);
    let b = { g: null, rms: Infinity };
    for (let g = 1.0; g <= 3.2; g += 0.01) {
      const rms = Math.sqrt(
        rows.reduce((a, t) => a + (t.matched - bias - predict(t.base, t.amplitude, g)) ** 2, 0) / rows.length
      );
      if (rms < b.rms) b = { g: +g.toFixed(2), rms };
    }
    console.log(`  ${hue.padEnd(6)} gamma ${b.g}  (n=${rows.length})`);
  }
  console.log();
}

console.log('hue     base  amp  matched  error  predicted  residual');
for (const t of live.sort((a, b) => a.base - b.base || a.amplitude - b.amplitude)) {
  const pred = predict(t.base, t.amplitude, best.gamma);
  const resid = t.matched - bias - pred;
  console.log(
    (t.hue ?? 'grey').padEnd(6),
    String(t.base).padStart(4),
    String(t.amplitude).padStart(4),
    String(t.matched).padStart(8),
    (t.error > 0 ? '+' : '') + String(t.error).padStart(5),
    pred.toFixed(1).padStart(10),
    (resid > 0 ? '+' : '') + resid.toFixed(1).padStart(8)
  );
}
