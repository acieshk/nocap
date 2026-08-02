import { maxAmplitudeFor } from './splitter.js';

/**
 * Fitting a secret into an existing design.
 *
 * Under the default linear-light split there is no band and no compression:
 * authored colours are reproduced exactly, so the secret's background can equal
 * the page background and the two become indistinguishable. The earlier advice
 * that it could not is obsolete — that was a consequence of compressing into
 * [amplitude, 255-amplitude], which linear light removed.
 *
 * What survives is the real constraint, and it is about protection rather than
 * appearance: a colour can only carry noise up to min(L, 1-L) of its own emitted
 * light. Light is heavily compressed at the dark end, so #101014 has under 1% of
 * headroom while a mid-tone has nearly all of it. Exact colours are free; the
 * masking that comes with them is not.
 *
 * Practical consequence: put the secret on a mid-tone panel. It then matches its
 * surroundings exactly AND has room to be protected. A near-black page chrome is
 * fine — just not directly behind the secret.
 */

const LUMA = [0.2126, 0.7152, 0.0722];

export function luma(rgb) {
  return rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
}

export function toRgb(color) {
  if (Array.isArray(color)) return color;
  const hex = String(color).trim().replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
}

export function toHex(rgb) {
  return '#' + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}

/**
 * Move a colour to a target luminance while keeping its hue.
 *
 * Works in luma + chroma rather than scaling RGB: scaling would blow out a
 * near-black colour (multiplying (10,12,20) up to mid-grey amplifies its chroma
 * 11x into a garish cast). Here the chroma vector is added back at whatever
 * scale still fits inside the band, so hue direction survives and nothing clips.
 */
export function placeInBand(color, targetLuma, band) {
  const rgb = toRgb(color);
  const base = luma(rgb);
  const chroma = rgb.map((c) => c - base);

  let scale = 1;
  for (const c of chroma) {
    if (c > 0.001) scale = Math.min(scale, (band.hi - targetLuma) / c);
    else if (c < -0.001) scale = Math.min(scale, (targetLuma - band.lo) / -c);
  }
  scale = Math.max(0, scale);
  return chroma.map((c) => clamp(targetLuma + c * scale, band.lo, band.hi));
}

/**
 * Suggest a <nocap-secret> configuration that sits inside a given design.
 *
 * @param {object} design
 * @param {string} design.background   the page background
 * @param {string} design.color        the page text colour
 * @param {number} [design.fontSize=26]  rendered glyph size in device px; sets
 *                                       the noise block, since noise must be at
 *                                       least as coarse as the stroke width
 * @param {number} [design.minContrast=42]  perceived luma separation to preserve
 * @returns {{amplitude:number, noiseScale:number, color:string, background:string,
 *            band:{lo:number,hi:number}, contrast:number, adaptiveCeiling:number,
 *            notes:string[]}}
 */
export function suggestConfig(design) {
  const { background, color, fontSize = 26, minContrast = 42 } = design;

  // Amplitude can be pinned, or solved for from the contrast you want to keep.
  //
  // Both perceived contrast AND surviving chroma come out of the same
  // 255 - 2A budget, so they compete: at amplitude 98 the band is 59 wide and a
  // saturated brand blue retains about a tenth of its chroma. There is no
  // setting that gives strong masking and vivid colour — this is the same
  // masking-versus-appearance trade-off as amplitude itself, seen in colour.
  const usable = 1 - 2 * 0.14;
  const amplitude =
    design.amplitude != null
      ? clamp(Math.round(design.amplitude), 0, 127)
      : clamp(Math.floor((255 - minContrast / usable) / 2), 24, 127);
  const band = { lo: amplitude, hi: 255 - amplitude };

  // Author the colours as-is and let the splitter do the band compression.
  //
  // This used to place them inside the band here, which double-compressed them:
  // the splitter remaps every source pixel into [amp, 255-amp] anyway, so a
  // pre-banded colour got squeezed a second time. Red on white came out at
  // rgb(130,120,120) — saturation 8, perceived contrast 11, i.e. grey on grey.
  // Passing the authored colours straight through lands red at rgb(159,96,96):
  // saturation 53, contrast 50.
  //
  // The band cube [lo, hi]^3 is the whole achievable gamut, and a linear remap
  // puts a fully saturated input on its corner. Nothing here can beat that.
  const outFgHex = toHex(toRgb(color));
  const outBgHex = toHex(toRgb(background));
  // Under linearLight (the component default) the planes are offset in light,
  // so nothing is compressed and the perceived colour is the authored one.
  const linear = design.linearLight ?? true;
  const span = (band.hi - band.lo) / 255;
  const perceive = (c) => (linear ? toRgb(c) : toRgb(c).map((v) => band.lo + v * span));
  const outFg = perceive(outFgHex);
  const outBg = perceive(outBgHex);

  // A stroke is roughly an eighth of the glyph size at weight 600. Coarser noise
  // resists a blur better but stops fusing below 120Hz, so this stays modest.
  const noiseScale = clamp(Math.round(fontSize / 10), 2, 6);

  const pageBgLuma = luma(toRgb(background));
  const pageFgLuma = luma(toRgb(color));

  const notes = [];
  if (Math.abs(luma(outFg) - luma(outBg)) < 30) {
    notes.push(
      'Perceived contrast is low here. Lower the masking strength, or pick a ' +
        'page pair further apart in lightness.'
    );
  }
  const weakest = Math.min(swingFor(color), swingFor(background));
  if (weakest < 0.08) {
    notes.push(
      `The secret's background now matches your page exactly — linear light removed ` +
        `the old restriction — but at ${(weakest * 200).toFixed(0)}% noise headroom it ` +
        `is barely masked. Put the secret on a mid-tone panel inside the page and it ` +
        `both blends and protects.`
    );
  } else if (weakest < 0.2) {
    notes.push(
      `Colours reproduce exactly and masking here is fair (${(weakest * 200).toFixed(0)}% ` +
        `headroom). A slightly more mid-tone panel would protect it better.`
    );
  }
  if (Math.abs(pageFgLuma - pageBgLuma) > 150) {
    notes.push(
      'Your page contrast is high, so the secret will look softer than surrounding ' +
        'text. Styled as an inset field, that reads as intentional.'
    );
  }
  notes.push(
    `Adaptive mode would reproduce these colours exactly but cap amplitude at ` +
      `${maxAmplitudeFor([color, background])}, which leaks badly. Not recommended here.`
  );

  return {
    amplitude,
    noiseScale,
    // Grey noise masks better than per-channel and looks far calmer; 0.5
    // hardness keeps deviations near the background instead of at the extremes.
    chroma: design.chroma ?? 0,
    hardness: design.hardness ?? 0.5,
    linearLight: linear,
    // What to author — full range. The splitter compresses these.
    color: outFgHex,
    background: outBgHex,
    // What they will actually look like once compressed into the band.
    perceivedColor: toHex(outFg),
    perceivedBackground: toHex(outBg),
    band,
    contrast: Math.round(Math.abs(luma(outFg) - luma(outBg))),
    chromaRetained: chromaRetained([color, background], [outFg, outBg]),
    adaptiveCeiling: maxAmplitudeFor([color, background]),
    notes,
  };
}

/**
 * Fraction of the original colourfulness that survived the band, 0..1.
 *
 * Surfacing this stops the recommendation from quietly turning a brand palette
 * grey and calling it a match.
 */
function chromaRetained(before, after) {
  const mag = (color) => {
    const rgb = toRgb(color);
    const base = luma(rgb);
    return Math.hypot(...rgb.map((c) => c - base));
  };
  const from = before.reduce((a, c) => a + mag(c), 0);
  const to = after.reduce((a, c) => a + mag(c), 0);
  return from < 1 ? 1 : clamp(to / from, 0, 1);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/* -------------------------------------------------------------------------- */

/** sRGB EOTF: code value -> emitted light. Piecewise, linear near black. */
export function toLight(v) {
  const s = clamp(v, 0, 255) / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * How much noise a colour can carry, 0..1, once the split runs in linear light.
 *
 * This is the number that decides whether a palette can be protected at all,
 * and it is not visible from the hex. Light is heavily compressed at the dark
 * end, so #101014 sits at under 1% of full output and has almost no room either
 * side — you get exactly the colour you asked for and almost no masking with it.
 * A mid-tone sits near 0.5 and has the most room in both directions.
 */
export function swingFor(color) {
  const L = Math.max(...toRgb(color).map(toLight));
  return Math.min(L, 1 - L);
}

/**
 * Check a palette before shipping it.
 *
 * The library cannot buy headroom that a colour does not have, so rather than
 * silently under-protecting a dark palette this reports what is achievable and
 * says so plainly.
 *
 * @returns {{fgSwing:number, backgroundSwing:number, weakest:number,
 *            grade:'good'|'fair'|'weak', warnings:string[]}}
 */
export function checkPalette({ color, background }) {
  const fgSwing = swingFor(color);
  const backgroundSwing = swingFor(background);
  const weakest = Math.min(fgSwing, backgroundSwing);
  const grade = weakest >= 0.2 ? 'good' : weakest >= 0.08 ? 'fair' : 'weak';

  const warnings = [];
  if (grade !== 'good') {
    const which = fgSwing < backgroundSwing ? 'text' : 'background';
    warnings.push(
      `The ${which} colour sits at ${(Math.min(fgSwing, backgroundSwing) * 200).toFixed(0)}% ` +
        `of the available noise headroom. Colours are reproduced exactly, but masking ` +
        `here is ${grade}. Move it toward the mid-tones to protect it properly.`
    );
  }
  return { fgSwing, backgroundSwing, weakest, grade, warnings };
}
