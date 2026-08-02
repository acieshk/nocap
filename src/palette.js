import { maxAmplitudeFor } from './splitter.js';

/**
 * Fitting a secret into an existing design.
 *
 * The hard constraint: a pixel at value v can only carry ±min(v, 255-v) of noise
 * before it clips, and clipping breaks the zero-sum property that makes the mean
 * come out right. So the perceived palette has to live inside
 * [amplitude, 255-amplitude] — a band centred on mid-grey that *narrows as
 * masking gets stronger*.
 *
 * Two consequences worth stating plainly, because they surprise people:
 *
 *   1. The secret's background cannot equal a near-black or near-white page
 *      background. At amplitude 96 the band is [96, 159]; a #0a0a0c page simply
 *      is not in it. Style the secret as an inset field — a chip that reads as a
 *      form input rather than as body text — and the difference looks deliberate.
 *
 *   2. Masking needs the noise to exceed the text/background separation. White
 *      on black gives 255 of separation and 0 of headroom, so it is unmaskable.
 *      Lower perceived contrast is not a cosmetic compromise here; it is the
 *      thing that makes the technique work.
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
  const span = (band.hi - band.lo) / 255;
  const perceive = (c) => toRgb(c).map((v) => band.lo + v * span);
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
  if (pageBgLuma < 40 || pageBgLuma > 215) {
    notes.push(
      `The secret's background cannot match a very dark or very light page — the ` +
        `perceived palette has to sit inside [${band.lo}, ${band.hi}]. Give the ` +
        `wrapper the page background and let the chip sit on top of it.`
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
