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
 * Move a colour to a target luminance while keeping its hue, inside bounds.
 *
 * `bounds` is no longer the old [amplitude, 255-amplitude] compression band —
 * linear light removed that. It is now just a channel range, used to keep
 * suggested colours off the 0 and 255 rails, since a channel at either extreme
 * has zero swing and cannot be masked at all.
 *
 * Works in luma + chroma rather than scaling RGB: scaling would blow out a
 * near-black colour, multiplying (10,12,20) up to mid-grey amplifies its chroma
 * 11x into a garish cast. Here the chroma vector is added back at whatever scale
 * still fits, so hue direction survives and nothing clips.
 */
export function placeInBand(color, targetLuma, bounds) {
  const rgb = toRgb(color);
  const base = luma(rgb);
  const chroma = rgb.map((c) => c - base);

  let scale = 1;
  for (const c of chroma) {
    if (c > 0.001) scale = Math.min(scale, (bounds.hi - targetLuma) / c);
    else if (c < -0.001) scale = Math.min(scale, (targetLuma - bounds.lo) / -c);
  }
  scale = Math.max(0, scale);
  return chroma.map((c) => clamp(targetLuma + c * scale, bounds.lo, bounds.hi));
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
  // Derive a maskable pair from the page's colours, keeping their hues.
  //
  // Passing the page colours through unchanged gives exact colour and no
  // protection: a typical #d8d8e0-on-#08080a page scores a masking ratio of
  // 0.04, where anything under 0.5 stays legible in a single frame. Code swing
  // peaks around mid-tones, so the panel is pulled into that region and the
  // text is placed a distance the panel can actually hide.
  //
  // Channels are also held off the rails. A channel sitting at 0 or 255 has
  // zero swing, so a fully saturated colour cannot be masked at any lightness:
  // #ff3131 scores 0.00 however it is placed. Bounding the channels caps
  // saturation, which is the real price of protecting a vivid brand colour.
  const SAFE = { lo: 40, hi: 214 };
  const panelLuma = clamp(luma(toRgb(background)), 96, 176);
  const outBg = placeInBand(background, panelLuma, SAFE);
  // 0.8 of the available swing targets a ratio near 1.25 — comfortably inside
  // "good" without collapsing the contrast to nothing.
  const reach = 0.7 * codeSwing(toHex(outBg));
  const fgIsLighter = luma(toRgb(color)) >= luma(toRgb(background));
  const fgLuma = clamp(panelLuma + (fgIsLighter ? reach : -reach), SAFE.lo, SAFE.hi);
  const outFg = placeInBand(color, fgLuma, SAFE);

  const outBgHex = toHex(outBg);
  const outFgHex = toHex(outFg);

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
  const { ratio, grade } = checkPalette({ color, background });
  if (grade === 'weak') {
    notes.push(
      `The secret's background now matches your page exactly — linear light removed ` +
        `the old restriction — but at a masking ratio of ${ratio.toFixed(2)} it is not ` +
        `protected. Put the secret on a mid-tone panel and lower its text contrast.`
    );
  } else if (grade === 'fair') {
    notes.push(
      `Colours reproduce exactly and masking is fair (ratio ${ratio.toFixed(2)}); 1.0 or ` +
        `more is where a single frame stops being readable.`
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
    linearLight: design.linearLight ?? true,
    // What to author — full range. The splitter compresses these.
    color: outFgHex,
    background: outBgHex,
    // What they will actually look like once compressed into the band.
    // Linear light reproduces authored colours exactly, so these are the same.
    perceivedColor: outFgHex,
    perceivedBackground: outBgHex,
    masking: checkPalette({ color: outFgHex, background: outBgHex }),
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

/** sRGB OETF: emitted light -> code value. Inverse of toLight. */
export function toCode(x) {
  const v = clamp(x, 0, 1);
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
}

/**
 * How far a colour's pixels actually travel, in code values, under a full-swing
 * linear-light split.
 *
 * Measuring this in light was a mistake: light is expansive near white, so a
 * large swing in light is a small swing in code. #f0f0f0 has 26% of its light
 * headroom free and still leaks 0.76, because that headroom is worth only a few
 * code levels. Code space is what both the eye and leakScore key on.
 *
 * Peaks at 127.5 where light is 0.5 (around #bcbcbc) and falls off in both
 * directions — far faster toward white than toward black.
 */
export function codeSwing(color) {
  const swings = toRgb(color).map((v) => {
    const L = toLight(v);
    const s = Math.min(L, 1 - L);
    return (toCode(L + s) - toCode(L - s)) / 2;
  });
  return Math.min(...swings);
}

/**
 * Check a palette before shipping it.
 *
 * Masking works when the noise a pixel can carry exceeds the text-to-background
 * separation it has to hide. Both measured in code values:
 *
 *   ratio = min(codeSwing(text), codeSwing(background)) / |text - background|
 *
 * Measured against denoised leak across 28 palettes, this correlates -0.73.
 * Raw light headroom, which this used to use, correlates -0.06 — no better than
 * chance, and it graded #f0f0f0 as usable when it leaks 0.76.
 *
 * @returns {{ratio:number, grade:'good'|'fair'|'weak', textSwing:number,
 *            backgroundSwing:number, separation:number, warnings:string[]}}
 */
export function checkPalette({ color, background }) {
  const textSwing = codeSwing(color);
  const backgroundSwing = codeSwing(background);
  const separation = Math.max(
    1,
    Math.abs(luma(toRgb(color)) - luma(toRgb(background)))
  );
  const ratio = Math.min(textSwing, backgroundSwing) / separation;
  const grade = ratio >= 1 ? 'good' : ratio >= 0.5 ? 'fair' : 'weak';

  const warnings = [];
  if (grade === 'weak') {
    warnings.push(
      `This palette cannot be masked: the noise it can carry is ${ratio.toFixed(2)}x ` +
        `the text-to-background separation, and below 0.5 a single captured frame ` +
        `stays legible. Colours are still exact — reduce the contrast between them, ` +
        `or move both toward the mid-tones.`
    );
  } else if (grade === 'fair') {
    warnings.push(
      `Masking here is fair (ratio ${ratio.toFixed(2)}); a ratio of 1.0 or more is ` +
        `where a single frame stops being readable.`
    );
  }
  return { ratio, grade, textSwing, backgroundSwing, separation, warnings };
}
