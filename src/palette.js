import { maxAmplitudeFor } from './splitter.js';

/**
 * Fitting a secret into an existing design.
 *
 * Under the default linear-light split there is no band and no compression:
 * authored colours are reproduced exactly, so the secret's background can equal
 * the page background and the two become indistinguishable. The earlier advice
 * that it could not is obsolete. That was a consequence of compressing into
 * [amplitude, 255-amplitude], which linear light removed.
 *
 * What survives is the real constraint, and it is about protection rather than
 * appearance: a colour can only carry noise up to min(L, 1-L) of its own emitted
 * light. Light is heavily compressed at the dark end, so #101014 has under 1% of
 * headroom while a mid-tone has nearly all of it. Exact colours are free. The
 * masking that comes with them is not.
 *
 * Practical consequence: put the secret on a mid-tone panel. It then matches its
 * surroundings exactly AND has room to be protected. A near-black page chrome is
 * fine. Just not directly behind the secret.
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
 * `bounds` is no longer the old [amplitude, 255-amplitude] compression band.
 * Linear light removed that. It is now just a channel range, used to keep
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
 * @param {number} [design.fontSize=26]  rendered glyph size in device px. Sets
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
  // setting that gives strong masking and vivid colour. This is the same
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
  // rgb(130,120,120). Saturation 8, perceived contrast 11, i.e. grey on grey.
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
  // 0.8 of the available swing targets a ratio near 1.25. Comfortably inside
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
  const { ratio, grade } = checkPalette({ color, background, gamma: design.gamma });
  if (grade === 'weak') {
    notes.push(
      `The secret's background now matches your page exactly, because linear light ` +
        `removed the old restriction. But at a masking ratio of ${ratio.toFixed(2)} it is not ` +
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
    // What to author. Full range. The splitter compresses these.
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
export function toLight(v, gamma = 2.4) {
  const s = clamp(v, 0, 255) / 255;
  // Matches splitter.js: 2.4 selects the real piecewise sRGB curve, anything
  // else falls back to a pure power so a measured display can be graded on the
  // same curve it is split with. Grading at 2.4 while splitting at a measured
  // gamma silently compares two different things.
  if (gamma !== 2.4) return Math.pow(s, gamma);
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** sRGB OETF: emitted light -> code value. Inverse of toLight. */
export function toCode(x, gamma = 2.4) {
  const v = clamp(x, 0, 1);
  if (gamma !== 2.4) return 255 * Math.pow(v, 1 / gamma);
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
 * directions. Far faster toward white than toward black.
 */
export function codeSwing(color, gamma = 2.4) {
  const swings = toRgb(color).map((v) => {
    const L = toLight(v, gamma);
    const s = Math.min(L, 1 - L);
    return (toCode(L + s, gamma) - toCode(L - s, gamma)) / 2;
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
 * Raw light headroom, which this used to use, correlates -0.06. No better than
 * chance, and it graded #f0f0f0 as usable when it leaks 0.76.
 *
 * @returns {{ratio:number, grade:'good'|'fair'|'weak', textSwing:number,
 *            backgroundSwing:number, separation:number, warnings:string[]}}
 */
export function checkPalette({ color, background, gamma = 2.4 }) {
  const textSwing = codeSwing(color, gamma);
  const backgroundSwing = codeSwing(background, gamma);
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
        `stays legible. Colours are still exact. Reduce the contrast between them, ` +
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

/**
 * A colour that differs from `base` in chrominance only, along blue-yellow.
 *
 * The eye resolves chrominance far more coarsely than luminance, and worst of
 * all on the blue-yellow axis, where the S-cones are sparse and absent from the
 * foveal centre. Every video codec exploits this when it subsamples chroma. A
 * mark painted in this colour carries almost no luminance signal, so it is weak
 * to look at and strong in the pixel data.
 *
 * Blue is the cheap channel: it contributes 0.0722 of luma against green's
 * 0.7152. Red and green are pushed the other way by exactly the amount that
 * cancels the luma change, so isoluminance is a construction rather than a hope.
 *
 * The swing is REDUCED, never clipped. Clipping a channel breaks the one
 * property this function exists to provide, and breaks it silently, which is
 * the same failure the decoy push had before it was bounded by what each pixel
 * could actually reach.
 *
 * `swing` may be negative to move toward yellow, which is what a background
 * that is already blue-heavy needs.
 *
 * @returns {{color: string, swing: number, deltaLuma: number}} the achieved
 *   swing, which is smaller than requested near the edge of the gamut
 */
export function isoluminantPartner(base, swing = 60) {
  const rgb = toRgb(base);
  const [r, g, b] = rgb;
  const compensation = (s) => -(LUMA[2] * s) / (LUMA[0] + LUMA[1]);
  const fits = (s) => {
    const k = compensation(s);
    return b + s >= 0 && b + s <= 255
      && r + k >= 0 && r + k <= 255
      && g + k >= 0 && g + k <= 255;
  };

  const step = swing < 0 ? 1 : -1;
  let s = swing;
  while (s !== 0 && !fits(s)) s += step;

  const k = compensation(s);
  const out = [r + k, g + k, b + s];
  return {
    color: toHex(out),
    swing: s,
    // Rounding to 8 bits leaves a fraction of a code level. Reported rather
    // than assumed, so a caller can check instead of trusting the name.
    deltaLuma: luma(toRgb(toHex(out))) - luma(rgb),
  };
}

/**
 * Move a palette that cannot carry noise into one that can.
 *
 * The masking ratio is `min(swing) / |text - background|`, so a pair fails for
 * one of two reasons: the colours sit where there is no headroom (white has a
 * swing of exactly 0, being already at the ceiling), or they are simply too far
 * apart. Both are fixed by the same move, which is to bring them together.
 *
 * This exists because "white on black cannot be masked" was the wrong lesson to
 * draw. Nothing physical stops it. What stopped it was the split insisting the
 * frames average to the authored hex, and that is a choice about colour
 * fidelity, not a law. Give up the exact hex and the noise works as expected.
 *
 * The midpoint is preserved where it can be, so a light design stays light and a
 * dark one stays dark, and only the separation shrinks. Only when the midpoint
 * itself has no headroom does it get pulled toward mid-grey, because that is
 * where a colour can travel furthest in either direction.
 *
 * Hue survives: placeInBand keeps the chroma and moves only the luma.
 *
 * @param {{color: string, background: string, minRatio?: number, gamma?: number}} design
 * @returns {{color: string, background: string, ratio: number, moved: boolean,
 *            contrast: number}}
 */
export function fitToBand({ color, background, minRatio = 1, gamma = 2.4 }) {
  const already = checkPalette({ color, background, gamma });
  if (already.ratio >= minRatio) {
    return { color, background, ratio: already.ratio, moved: false,
             contrast: contrastRatio(color, background, gamma) };
  }

  const cL = luma(toRgb(color));
  const bL = luma(toRgb(background));
  const sign = cL >= bL ? 1 : -1;
  const sep0 = Math.abs(cL - bL);

  // The inset desaturates. A saturated hue keeps a channel pinned at an extreme
  // however its luma moves, and a channel at 0 or 255 has no swing, so pure red
  // on black cannot be rescued by luma alone. Narrowing the bounds makes
  // placeInBand scale the chroma down until every channel has room.
  const pairAt = (mid, sep, inset) => {
    const bounds = { lo: inset, hi: 255 - inset };
    return {
      color: toHex(placeInBand(color, mid + (sign * sep) / 2, bounds)),
      background: toHex(placeInBand(background, mid - (sign * sep) / 2, bounds)),
    };
  };

  // Try the original midpoint first, then walk it toward mid-grey. A pure
  // black-on-black-ish design has no headroom at its own midpoint however
  // little separation is left, so shrinking alone cannot rescue it.
  for (const inset of [0, 12, 24, 40, 60]) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const mid = ((cL + bL) / 2) * (1 - t) + 128 * t;
      // A pair with no separation left is not a fit, it is one colour, so the
      // smallest step has to still be legible rather than merely maskable.
      const floor = checkPalette({ ...pairAt(mid, 8, inset), gamma }).ratio;
      if (!(floor >= minRatio)) continue;
      // Wider separation lowers the ratio, so this is monotone and bisects.
      let lo = 8;
      let hi = Math.max(sep0, 9);
      for (let i = 0; i < 24; i++) {
        const sep = (lo + hi) / 2;
        if (checkPalette({ ...pairAt(mid, sep, inset), gamma }).ratio >= minRatio) lo = sep;
        else hi = sep;
      }
      const out = pairAt(mid, lo, inset);
      return { ...out, ratio: checkPalette({ ...out, gamma }).ratio, moved: true,
               contrast: contrastRatio(out.color, out.background, gamma) };
    }
  }

  // Nothing reachable, which needs both colours pinned at an extreme. Report it
  // rather than returning something that quietly does not mask.
  return { color, background, ratio: already.ratio, moved: false,
           contrast: contrastRatio(color, background, gamma) };
}

/** WCAG-style contrast, so the cost of fitting is a number and not a feeling. */
export function contrastRatio(a, b, gamma = 2.4) {
  const la = toLight(luma(toRgb(a)), gamma);
  const lb = toLight(luma(toRgb(b)), gamma);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Two colours of equal luminance whose mean is exactly `background`.
 *
 * The pair for an isoluminant chroma decoy. Alternated in fine blocks inside a
 * glyph they average, for a viewer, to the background itself: the eye resolves
 * chrominance at roughly a third of the acuity it resolves luminance with,
 * which is the same fact that makes 4:2:0 subsampling invisible. A sensor
 * records the individual pixels and sees the shape.
 *
 * Green against magenta, because that axis carries the most chroma for the least
 * luminance. The offset is solved rather than chosen: luma(d) must be 0, so
 * dg = -(0.2126 + 0.0722)/0.7152 * dr with dr = db, and then A = bg + d and
 * B = bg - d have identical luminance and average back exactly.
 *
 * At #404040 this gives (128, 39, 128) and (0, 89, 0), measured at a luminance
 * standard deviation of 0.083 across the image. There is no luminance cue at
 * any block size.
 *
 * @param {string|number[]} background
 * @param {number} [strength=1] 0..1 of the swing the background allows
 */
export function isoluminantPair(background, strength = 1) {
  const bg = toRgb(background);
  const K = (0.2126 + 0.0722) / 0.7152;
  // Largest k where both colours stay in gamut on every channel.
  let k = Math.min(bg[0], 255 - bg[0], bg[2], 255 - bg[2]);
  k = Math.min(k, bg[1] / K, (255 - bg[1]) / K);
  k = Math.max(0, k * Math.max(0, Math.min(1, strength)));
  const d = [k, -k * K, k];
  const clamp01 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return {
    a: toHex(bg.map((v, i) => clamp01(v + d[i]))),
    b: toHex(bg.map((v, i) => clamp01(v - d[i]))),
    swing: k,
  };
}
