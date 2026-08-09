import { Flicker } from './flicker.js';
import { leakScore, planeRange, averageFrames, perceivedMean } from './splitter.js';
import { checkPalette, toLight, toCode, isoluminantPartner, fitToBand, codeSwing,
         isoluminantPair, toRgb, luma } from './palette.js';
import { fakeLike } from './fake.js';
import { splitFrames } from './splitter.js';

/**
 * Text-tuned defaults.
 *
 * Text tolerates far more amplitude than a photograph does: it is essentially
 * two-tone, so crushing it into [110, 145] costs almost nothing legibility-wise
 * while a painting would turn to mush. Measured single-plane leak at these
 * settings is near zero, where amplitude 64 leaves ~0.39.
 */
/**
 * Named strengths, so nobody has to discover good numbers by experiment.
 *
 * `medium` is the default and matches the tuning the demo calls "Balanced".
 * Each is a tested point on the same curve: more masking costs visual calm and
 * needs a faster display, less masking is easier to read at 60Hz. Setting any
 * individual attribute overrides that part of the preset.
 */
export const STRENGTHS = {
  // Easiest to read, and the only one that fuses comfortably on a slow 60Hz
  // panel. Its block sits BELOW the saturation point on purpose, so a blur has
  // a radius worth trying. That is the trade the name is making.
  weak: { amplitude: 80, blockRatio: 1.33, hardness: 0.5 },
  medium: { amplitude: 110, blockRatio: 2, hardness: 1 },
  // Coarser noise resists a blur best but sits at a low spatial frequency,
  // where the eye's temporal sensitivity peaks.
  //
  // This said "wants 120Hz+ to fuse", which was reasoning rather than a
  // reading. Looked at on a 60Hz panel at the default size it fuses fine, so
  // the claim is gone. It remains the most visually active of the three, and
  // the open question is LARGE text: the block is twice the stroke, so a 96px
  // face gets 24px where the default gets 6, and coarse blocks are exactly what
  // shimmers. Nobody has looked at that size.
  strong: { amplitude: 127, blockRatio: 2.67, hardness: 1 },
};

const TEXT_DEFAULTS = {
  mode: 'amplitude',
  frames: 2,
  // Matches STRENGTHS.medium and the demo's "Balanced" preset. It used to be
  // 96, on reasoning about a [96, 159] compression band that linear light
  // removed. There is no band now, so the contrast argument for the lower
  // value no longer applies and 96 was simply weaker than every preset.
  amplitude: 110,
  // Split in light, not in code values. This is what makes `color` and
  // `background` mean what they say: the planes are offset in linear light, so
  // the mean the eye integrates is exactly the authored colour. Averaging in
  // sRGB instead reads far too bright. #ff0000 arrives as #be8c8c.
  linearLight: true,
  gamma: 2.4,
  // No band compression under linearLight, so no pre-emphasis to claw back.
  contrast: 1,
  // 1 puts every pixel at full amplitude. This was 0.5, on a claim that it gave
  // the same leak for less visual noise, and that claim does not reproduce.
  // Measured on
  // the default palette at amplitude 110, stroke 5, worst plane over 6 seeds:
  //
  //   hardness 0.5   raw 0.278   after a blur 0.398
  //   hardness 1     raw 0.232   after a blur 0.339
  //
  // About 20% less leak both ways, so 1 is right and the old comment argued for
  // the worse value.
  hardness: 1,
  // Grey noise, not per-channel. This is a free win rather than a compromise:
  // sharing one sign across R/G/B puts the whole noise budget into luminance,
  // which is what leakScore and the eye both key on for text. Measured 0.262
  // denoised leak versus 0.346 for independent per-channel noise, at identical
  // visual loudness. And it looks like grey static instead of rainbow static.
  chroma: 0,
  // The block is derived from the stroke, so this is a RATIO rather than a
  // pixel count. 2 is where a blur stops gaining, measured on rasterised glyphs
  // at five sizes. See the derivation in resolveOptions.
  //
  // The cost of a coarser block is fusion, not legibility: coarse noise sits at
  // a low spatial frequency, which is where the eye's temporal sensitivity
  // peaks, so it shimmers more at 30Hz than a fine block does. strength="weak"
  // deliberately sits under 2 for that reason and accepts the blur exposure.
  blockRatio: 2,
  // White ships. 'blue' high-passes the lattice and removes about a third of the
  // low-frequency energy, measured as the spread of the block average: 0.63 of
  // white's at an 8px window. It is NOT blue noise in the proper sense, which
  // means a locally balanced binary pattern from void-and-cluster, and the name
  // is kept only because it is the axis people recognise.
  //
  // Security is unchanged. Any leak difference between the two is inside seed
  // variance and should not be quoted as a result. Whether it reads better is
  // unverified on a real panel, which no measurement here can settle.
  noiseProfile: 'white',
  // 0, and the measurements are why. Leaning amplitude toward the ink is the
  // largest comfort win available and it buys that comfort directly out of the
  // protection, because where the noise is, is where the text is:
  //
  //   bias 0.0   leak 0.263   modulation 96.5
  //   bias 0.2   leak 0.304   modulation 81.4   <- the usable end
  //   bias 0.4   leak 0.361   modulation 66.4
  //   bias 1.0   leak 0.732   modulation 21.4   <- the value is legible again
  //
  // 6 seeds, shipped palette. Blurring the map and keeping a floor stop it
  // tracing an outline, but nothing stops the trade itself, so this is opt-in
  // and anything past about 0.3 wants measuring on your own content first.
  inkBias: 0,
  // Off, since an element on its own panel wants a crisp edge. Set it when
  // blocks sit next to each other or the background matches the page.
  edgeFade: 0,
  bankSize: 6,
};

/**
 * <nocap-secret>. Show a short secret as flickered text.
 *
 * The plaintext is rendered straight to a canvas and never enters the DOM. That
 * is worth more than it sounds: View Source never had it (it is set from JS),
 * and unlike JS-injected text nodes it is also absent from the DOM inspector,
 * the accessibility tree, Select-All + Copy, Reader mode, "Save Page As", and
 * every text-scraping extension. The inspector shows a <canvas> and nothing else.
 *
 * What it does NOT do: hide from anyone with DevTools and intent. The string is
 * a live JS value, so a breakpoint, a heap snapshot, or one canvas.toDataURL()
 * in the console retrieves it. Nothing running in a browser can prevent that,
 * because the client belongs to the user. Treat this as raising the cost of a
 * casual look, in the same spirit as the flicker itself.
 *
 *   <nocap-secret strength="medium"></nocap-secret>
 *   el.secret = await fetchAccountNumber();
 *
 * Prefer the `.secret` property. Putting the text in the element's markup works,
 * since it is read once and then erased from the DOM, but it was in the HTML
 * source on the way there, which defeats the point.
 */
/**
 * Extending HTMLElement directly makes this module unimportable outside a
 * browser, which breaks `import 'nocap'` under SSR. Next, Astro and Remix all
 * evaluate module top-level on the server. Falling back to a plain base keeps
 * the barrel importable there. `customElements.define` is already guarded below,
 * so nothing registers and nothing renders until it reaches a browser.
 */
const ElementBase = typeof HTMLElement === 'function' ? HTMLElement : class {};

/**
 * Fraction of a scratch trail still standing after `dt` seconds.
 *
 * `linger` is how long a fresh stroke takes to fade to 1% of its opening
 * strength, so it is a number you can hold a stopwatch to. It replaced a
 * per-frame multiplier, which cleared a stroke in about a second at 60Hz and
 * about half that at 120Hz: the same setting meant different things on
 * different displays, and none of them meant seconds.
 *
 * Exponential rather than linear, because the product of the per-step factors
 * across an interval then depends only on the total time and not on how the
 * interval was cut into frames. That is what makes the setting hold.
 *
 * @param {number} dt      seconds since the previous frame
 * @param {number} linger  seconds for a stroke to reach 1%
 */
export function scratchLingerKeep(dt, linger) {
  if (!(dt > 0)) return 1;
  // Zero means "gone at once". NaN from a malformed attribute lands here too,
  // and clearing is the right way to fail: the other branch would leave the
  // value standing on screen forever.
  if (!(linger > 0)) return 0;
  return Math.exp(-dt / (linger / Math.log(100)));
}

/**
 * Merge defaults, a strength preset and explicit attributes into split options.
 *
 * Pure and exported so it can be tested. It was inline and private, and the
 * first version silently dropped two thirds of every preset: the explicit keys
 * sat after a `...base` spread and their fallbacks still read TEXT_DEFAULTS, so
 * `strength` moved amplitude and nothing else. That is not a bug you can catch
 * by reading, and it was invisible to a test suite that could only check the
 * STRENGTHS table itself.
 *
 * @param {Record<string,string>} attrs  attributes that are actually present
 * @param {number} [dpr=1]  a preset's block is authored at dpr 1 and scaled here
 */
/**
 * Attributes arrive as strings, and a malformed one used to reach the canvas.
 *
 * `padding-y="qq"` became NaN, and a non-finite coordinate makes fillText skip
 * the draw entirely without throwing, so the element rendered a blank noise
 * field and nothing said why. `font-size="abc"` produced `600 NaNpx monospace`,
 * an invalid font string, and assigning one of those is a silent no-op that
 * leaves whatever font happened to be set before.
 *
 * Both are the same failure: garbage in, nothing drawn, no error. Every numeric
 * attribute goes through here instead — coerce, check, fall back to the
 * documented default, and say so once.
 */
/** Deliberately odd so a real font string cannot collide with it. */
const FONT_SENTINEL = '7.31px serif';

/**
 * Every scratch element currently running, so revealing one can clear the rest.
 *
 * This does NOT slow an extraction attack down, and it should not be sold as if
 * it does. Timed on the live challenge, taking one cell costs 3.4s of dragging a
 * pointer and 0.3s of capture. An attacker finishes a cell and moves on long
 * before any reset matters, and sequential is the natural way to write that
 * attack anyway.
 *
 * What it does do is stop a single frame ever containing two revealed values,
 * which is the still capture and the person behind you, and that is the case
 * this library is actually for. Worth having, worth describing accurately.
 */
const liveScratch = new Set();

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[nocap-secret] ${message}`);
}

function num(attrs, name, fallback) {
  if (!(name in attrs)) return fallback;
  const v = +attrs[name];
  if (Number.isFinite(v)) return v;
  warnOnce(`${name}=${attrs[name]}`,
    `${name}="${attrs[name]}" is not a number. Using ${fallback}.`);
  return fallback;
}

/**
 * A length that has to be positive. Zero or less is not a smaller font, it is
 * no font at all.
 *
 * `num` cannot cover this. `+''` is 0 and `+'-5'` is -5, so both are finite,
 * both pass a finite check, and both then land on the 6px floor and render the
 * secret at a size nobody can read without a word being said. That is the same
 * silent wrong output the finite check exists to stop, one step further along.
 *
 * The empty case is the one that matters: a bare `<nocap-secret font-size>` is
 * an easy attribute to write by accident, and it coerces straight to 0.
 */
function positive(attrs, name, fallback) {
  if (!(name in attrs)) return fallback;
  const v = +attrs[name];
  if (Number.isFinite(v) && v > 0) return v;
  warnOnce(`${name}=${attrs[name]}`,
    `${name}="${attrs[name]}" is not a positive number. Using ${fallback}.`);
  return fallback;
}

/**
 * Canvas letterSpacing wants a CSS length. A bare number and an unparseable
 * string are both silent no-ops, so the unit is added when missing and anything
 * that is not a length falls back rather than being passed through.
 */
function spacing(raw) {
  if (raw == null) return '0px';
  // No space between the number and the unit: CSS does not allow one, and
  // quietly repairing `10 px` would be guessing at intent rather than checking.
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)\s*$/i.exec(raw);
  if (!m) {
    warnOnce(`letter-spacing=${raw}`,
      `letter-spacing="${raw}" is not a CSS length. Using 0px.`);
    return '0px';
  }
  return m[2] ? `${m[1]}${m[2]}` : `${m[1]}px`;
}

/**
 * Resolve the text styling attributes into everything the draw paths need.
 *
 * Pure and exported so it can be tested without a DOM, same reason
 * resolveOptions is.
 *
 * The size matters beyond appearance. The noise block ceiling is derived from
 * the stroke width, and the stroke is derived from the font, so a configurable
 * font that did not feed back into resolveOptions would leave the ceiling
 * tracking a size the element is no longer drawing at. Small text with a block
 * sized for large text is the case where a blur wins, and nothing would have
 * said so.
 *
 * @param {Record<string,string>} attrs  attributes that are present
 * @param {number} height  canvas height in device px
 */
export function resolveText(attrs = {}, height = 56) {
  // 0.46 of the height is the long-standing default and stays the default.
  const scale = positive(attrs, 'font-scale', 0.46);
  // The 6px floor cannot double as the guard here. Math.max(6, NaN) is NaN, and
  // Math.max(6, 0) is a readable-looking 6 that nobody can actually read. The
  // value has to be a real positive size before it gets this far.
  const sizePx = Math.max(6, Math.round(positive(attrs, 'font-size', height * scale)));
  const weight = attrs['font-weight'] ?? '600';
  const family = attrs['font-family'] ?? 'ui-monospace, monospace';
  return {
    font: `${weight} ${sizePx}px ${family}`,
    sizePx,
    letterSpacing: spacing(attrs['letter-spacing']),
    align: ['left', 'center', 'right'].includes(attrs['text-align'])
      ? attrs['text-align'] : 'center',
    padX: Math.max(0, num(attrs, 'padding-x', 0)),
    padY: num(attrs, 'padding-y', 0),
  };
}

/**
 * Resolve the fake-mode attributes.
 *
 * Pure and exported for the reason resolveText and resolveOptions are: the
 * clamps are not reachable through the element without a DOM, and the previous
 * version of this shipped with `fake-size` observed nowhere and clamped
 * nowhere, which nothing could have caught.
 *
 * @param {Record<string,string>} attrs  attributes that are present
 */
/**
 * The largest half-excursion that can still hit a given target, per code value.
 *
 * A pair at +/-half can only reach light means between
 * (toLight(2*half) + toLight(0)) / 2 and (toLight(255) + toLight(255-2*half)) / 2,
 * and that band narrows as half grows. A FIXED budget therefore becomes
 * infeasible for dark pixels. Capping per pixel keeps the decoy at uniform
 * contrast wherever physics allows and backs off only where it must.
 *
 * Exported and memoised because it is the invariant fake mode rests on, and
 * the reason the old `decoyPush` could not work: at the element's own default
 * background this ceiling is 78.4 while the base split already asks for 110,
 * so a push added on top and clamped to the same ceiling returns the value it
 * started from. That was true at every setting and nothing tested it.
 *
 * 256 entries, solved once per gamma.
 */
const feasibleCache = new Map();
export function feasibleHalfTable(gamma = 2.4) {
  const hit = feasibleCache.get(gamma);
  if (hit) return hit;
  const table = new Float64Array(256);
  for (let v = 0; v < 256; v++) {
    const want = toLight(v, gamma);
    let lo = 0;
    let hi = 127;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const min = (toLight(2 * mid, gamma) + toLight(0, gamma)) / 2;
      const max = (toLight(255, gamma) + toLight(255 - 2 * mid, gamma)) / 2;
      if (want >= min && want <= max) lo = mid;
      else hi = mid;
    }
    table[v] = lo;
  }
  feasibleCache.set(gamma, table);
  return table;
}

/**
 * Split one pixel's whole budget between masking it and marking it.
 *
 * Exported so the conserved-budget behaviour can be asserted directly. The
 * sign has to come from the excursion AFTER the decoy is in, not from the
 * noise that was there before: widening symmetrically about whichever way the
 * noise already pointed modulates its AMPLITUDE rather than biasing it, and
 * amplitude modulation of random-sign noise reads as more noise.
 *
 * @param {number} cap     this pixel's feasible half
 * @param {number} share   fraction of the budget the decoy may take
 * @param {number} amount  the decoy's coverage here, 0..1
 * @param {number} b0      base plane 0 value
 * @param {number} b1      base plane 1 value
 * @returns {{half: number, signed: number, forDecoy: number, forNoise: number}}
 */
export function decoySplit(cap, share, amount, b0, b1) {
  const forDecoy = cap * share * amount;
  const forNoise = cap - forDecoy;
  const noise = (b0 >= b1 ? 1 : -1) * Math.min(Math.abs(b0 - b1) / 2, forNoise);
  const excursion = noise + forDecoy;
  const half = Math.min(Math.abs(excursion), cap);
  return { half, signed: excursion < 0 ? -half : half, forDecoy, forNoise };
}

export function resolveFake(attrs = {}) {
  return {
    // How much of a pixel's excursion budget the decoy may take. 0.9 rather
    // than 1 because at 1 the noise where the decoy falls is gone entirely.
    //
    // 0.8, and the size below is 1.0, because those are the settings at which
    // the mode does its job. The old 0.35/0.55 pair was measured and the decoy
    // came out QUIETER in a captured frame than the secret it covers (0.068
    // against 0.101 on synthetic glyphs, 0.175 against 0.217 in the browser),
    // which is why 0.1 shipped with the mode disabled. At 0.8/1.0 the decoy
    // reads at 0.212 against the real value's 0.121 raw, 0.174 against 0.102
    // through a blur, with the viewer-visible ghost still at most one code
    // level. The decoy only wins at full size with most of the budget, so
    // that is the default rather than the compromise nobody measured.
    share: Math.max(0, Math.min(0.9, num(attrs, 'fake-share', 0.8))),
    // The decoy's font size relative to the real text.
    sizeRatio: Math.max(0.1, Math.min(1, num(attrs, 'fake-size', 1))),
  };
}

export function resolveOptions(attrs = {}, dpr = 1, height = 56, fontSizePx = null) {
  const preset = STRENGTHS[attrs.strength] ?? {};
  const base = { ...TEXT_DEFAULTS, ...preset };

  // The block is a multiple of the STROKE, and that is the whole rule.
  //
  // Its only job is closing the blur gap. Measured on rasterised glyphs at five
  // sizes, 8 seeds each, the raw leak barely moves with the block (0.17 to 0.22
  // everywhere) while the useful blur radius collapses at a fixed ratio:
  //
  //   stroke 3   block 6    <- radius 0
  //   stroke 4   block 8    <- radius 0
  //   stroke 6   block 12   <- radius 0
  //   stroke 8   block 16   <- radius 0
  //
  // Twice the stroke, at every size. Below it the attacker gains: stroke 8 with
  // a 6px block goes 0.187 raw to 0.266 blurred, and with a 3px block to 0.441.
  //
  // An earlier version of this used 1.25x, measured on synthetic vertical bars.
  // Bars are the easy case. Real glyphs carry curves and diagonals whose local
  // stroke runs wider than the nominal one, and they need the full 2x. That is
  // worth stating because the bar measurement looked clean and was wrong.
  //
  // This used to be an absolute px value per preset, floored so it could only
  // ever trim a dpr-scaled number and never raise it. At dpr 1 the preset value
  // was therefore the answer at every font size, so a 96px font got the same
  // 6px block as a 12px one, at half its stroke. A ratio cannot drift that way,
  // because dpr already moves the stroke.
  const sizePx = fontSizePx ?? height * dpr * 0.46;
  const strokePx = Math.max(2, Math.round(sizePx / 8));
  // CALIBRATED PAIR: this 2 and the /8 above are matched to each other, not
  // independently correct. The /8 underestimates the real stem of the default
  // 600-weight face (a 48px face measures 7, not 6; 96px measures 14, not 12),
  // so the shipped block is about 1.7x the TRUE stroke rather than 2x. Both the
  // radius sweep and an independent gap measurement agree that is enough.
  //
  // So do not "fix" the /8 to match a rasterised measurement on its own. Doing
  // that silently moves every block about 17% coarser, with more shimmer and
  // nothing behind it. Either change both together or neither.
  const SATURATES = 2;
  // Capped, and the ceiling is chosen for LOOKS rather than for security.
  //
  // Measured at stroke 11 over 30 seeds, worst of raw and blurred: block 11
  // 0.285, 16 0.267, 20 0.282, 24 0.271, 30 0.266, all with confidence
  // intervals of about 0.014. Every one overlaps every other. Once the block
  // clears the saturation point, going further buys nothing measurable.
  //
  // What it does buy is 24 to 30px tiles on large type, which read as broken.
  // So the cap exists, it is honest about being an aesthetic choice, and it is
  // set well above the point where the blur radius collapses.
  // num() directly, not the attr() helper: that is declared further down and
  // reading it here is a temporal dead zone error, which is the second time this
  // file has caught me that way.
  const cap = Math.max(4, num(attrs, 'noise-scale-max', 16));
  base.noiseScale = Math.min(cap,
    Math.max(2, Math.round(strokePx * (base.blockRatio ?? SATURATES))));
  // blockRatio is how a preset is authored. It is not a split option, and
  // leaving it in would hand splitFrames a key it does not know.
  delete base.blockRatio;

  if (base.noiseScale < strokePx * SATURATES) {
    const capped = base.noiseScale === cap;
    warnOnce(`block:${base.noiseScale}:${strokePx}`,
      `noise block ${base.noiseScale}px is under ${SATURATES}x the ${strokePx}px stroke, ` +
      `so a blur may recover some of the value. ${Math.round(strokePx * SATURATES)}px closes it.` +
      (capped
        ? ` This is the noise-scale-max ceiling of ${cap}px binding, which exists because`
          + ' larger blocks read as tiles rather than noise. Raise noise-scale-max if the'
          + ' capture matters more than the look at this size.'
        : ''));
  }

  // NOT a local `num`. There was one here, with the same name and the same
  // shape as the validating helper above, and it shadowed it: every attribute
  // resolved in this function got a bare `+attrs[name]` while everything in
  // resolveText was guarded. A malformed value became NaN, `clamp` could not
  // catch it because NaN fails both comparisons, and the element rendered
  // completely black with no warning at all.
  //
  // #12 fixed the half of the surface it touched. The two halves had different
  // helpers under one name, which is exactly the kind of thing a reader skims
  // past. Use the validating one, and do not reintroduce a local.
  const attr = (name, fallback) => num(attrs, name, fallback);

  // 'aperture' and 'interleave' carry each pixel in ONE plane and show a fill in
  // the others. That IS their mechanism, and stacking the default amplitude on
  // top buries it: the noise swamps the structure and the element renders
  // something visually identical to amplitude mode, so selecting either mode
  // appeared to do nothing at all.
  //
  // Exactly the error the algorithms page made and diagnosed, where every mode
  // got amplitude 110 and interleave scored best because it was being credited
  // for amplitude's work. It was fixed there and not carried back to here.
  //
  // So these modes default to no stacked noise and show their own mechanism.
  // Setting `amplitude` explicitly still stacks it, which is a real thing to
  // want: interleave plus noise is a genuine configuration, it is just not what
  // `mode="interleave"` alone should silently mean.
  // Resolve the mode BEFORE deciding the amplitude. base.mode is always the
  // default here, since the attribute is applied in the returned object rather
  // than merged into base, so testing base.mode never sees an override.
  const mode = attrs.mode ?? base.mode;
  // Drop it from base too, or the `...base` spread in the returned object puts
  // TEXT_DEFAULTS.frames back and the omission below achieves nothing.
  if (!('frames' in attrs)) delete base.frames;

  const carrier = mode === 'aperture' || mode === 'interleave';
  const amplitude = attr('amplitude', carrier ? 0 : base.amplitude);

  return {
    ...base,
    amplitude,
    // Omitted rather than defaulted, so the splitter can pick per mode. Emitting
    // a concrete 2 here meant aperture came out at 3 frames instead of 6, since
    // its floor is max(3, opts.frames), and 3 frames shows a third of the image
    // per capture: leak 0.870 against 0.629 at six. The mode looked broken
    // because it was being handed a frame count chosen for a different one.
    ...('frames' in attrs ? { frames: attr('frames', base.frames) } : {}),
    contrast: attr('contrast', base.contrast),
    noiseScale: attr('noise-scale', base.noiseScale),
    // Switchable so the algorithms can be compared on the same content.
    mode,
    noiseProfile: attrs['noise-profile'] ?? base.noiseProfile,
    inkBias: attr('ink-bias', base.inkBias),
    edgeFade: attr('edge-fade', base.edgeFade),
    chroma: attr('chroma', base.chroma),
    gamma: attr('gamma', base.gamma),
    hardness: attr('hardness', base.hardness),
    adaptive: 'adaptive' in attrs,
  };
}

export class NocapSecret extends ElementBase {
  static observedAttributes = [
    'amplitude',
    'frames',
    'contrast',
    'strength',
    'mode',
    'watermark',
    'watermark-swing',
    'watermark-repeat',
    // `scratch` is observed because it builds or tears down the mask. Its two
    // settings are not: the animation loop reads them with getAttribute every
    // frame, so they already take effect on the next one. Observing them would
    // put a full re-split behind every tick of a drag, and re-noise the element
    // while you are trying to look at it.
    'font-family',
    'font-weight',
    'font-size',
    'font-scale',
    'letter-spacing',
    'text-align',
    'padding-x',
    'padding-y',
    'scratch',
    'scratch-hint',
    'scratch-exclusive',
    'chroma-decoy',
    'chroma-block',
    'noise-scale',
    'noise-scale-max',
    'pattern',
    'pattern-strength',
    'pattern-offset-x',
    'pattern-offset-y',
    'pattern-layer',
    'pattern-enter',
    'pattern-playing',
    'paused',
    'max-dpr',
    'noise-profile',
    'ink-bias',
    'edge-fade',
    'chroma',
    'hardness',
    'gamma',
    'color',
    'background',
    'fit',
    'adaptive',
    'scramble',
    'fake',
    'fake-share',
    'fake-size',
    'width',
    'height',
  ];

  #secret = '';
  #chars = null;   // scramble mode: glyphs in shuffled order
  #slots = null;   // where each of #chars belongs on screen
  #flicker = null;
  #canvas = null;
  #revealed = false;
  #paletteWarned = false;
  #lastDecoy = null;
  #decoys = null;
  #fakeWarned = false;
  #adapted = false;
  #motionWarned = false;
  #chromaWarned = false;
  #spacingWarned = false;
  #watermarkSwing = null;
  #watermarkWarned = false;
  #scratch = null;      // { mask, ctx, raf, pointer }
  #hint = null;         // the scratch affordance, an overlay rather than canvas
  #fg = null;           // pattern-layer="front": texture over the canvas, free

  connectedCallback() {
    if (this.#canvas) return;

    // Read inline text once, then remove it so it does not sit in the DOM.
    const inline = this.textContent.trim();
    if (inline) {
      this.#secret = inline;
      this.textContent = '';
    }

    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host { display: inline-block; position: relative; line-height: 0;
              user-select: none; -webkit-user-select: none; }
      /* Custom properties cross a closed shadow boundary where a selector
         cannot, so this is the one hook a page gets on the canvas itself.
         Stacked elements need 0 or the rounded corners cut notches at every
         seam and a wall of text reads as separate strips. */
      canvas { display: block; image-rendering: pixelated;
               border-radius: var(--nocap-radius, 4px); }
      /* The scratch affordance. With scratch on and nothing scratched yet the
         element is a flat rectangle, which tells a first-time user nothing at
         all. It sits over the canvas rather than in it: painted into the canvas
         it would be split and masked along with the value, and the one thing it
         must never be is hidden. pointer-events stays off so it cannot swallow
         the gesture it is asking for. */
      /* The texture, composited OVER the canvas rather than drawn into it.
         Free, because the split never carries it: it is added identically to
         every frame, so the planes still average to the target plus a constant.
         An attacker who knows the pattern can subtract it, which is why it adds
         no protection either, and neither does it take any away.
         The cost is legibility, not security. A texture stronger than the
         text-to-background separation will fight the glyphs. */
      .fg { position: absolute; inset: 0; pointer-events: none; }
      /* The texture wipes in from the direction the words travel from, so the
         two read as one movement rather than a panel arriving already dressed.
         Runs while [pattern-playing] is set; removing and re-adding it replays.

         clip-path rather than an animated mask driven by a custom property.
         That was the first design and it does not work: a transition on a
         registered custom property never advanced here -- measured at 0 well
         past its own duration, and 1 the moment the transition was removed --
         so the mask stayed shut and the texture was simply invisible. It also
         had the failure backwards, defaulting to hidden. Without the attribute
         the texture is fully shown, so the worst case is no animation rather
         than no texture. */
      @keyframes nocap-wipe-left   { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0) } }
      @keyframes nocap-wipe-right  { from { clip-path: inset(0 0 0 100%) } to { clip-path: inset(0) } }
      @keyframes nocap-wipe-up     { from { clip-path: inset(100% 0 0 0) } to { clip-path: inset(0) } }
      @keyframes nocap-wipe-down   { from { clip-path: inset(0 0 100% 0) } to { clip-path: inset(0) } }
      @keyframes nocap-wipe-center { from { clip-path: circle(0% at 50% 50%) }
                                     to   { clip-path: circle(78% at 50% 50%) } }
      :host([pattern-enter][pattern-playing]) .fg {
        animation: var(--nocap-enter-dur, .62s) cubic-bezier(.16, .9, .3, 1)
                   var(--nocap-enter-delay, .1s) both; }
      :host([pattern-enter="left"][pattern-playing])   .fg { animation-name: nocap-wipe-left }
      :host([pattern-enter="right"][pattern-playing])  .fg { animation-name: nocap-wipe-right }
      :host([pattern-enter="up"][pattern-playing])     .fg { animation-name: nocap-wipe-up }
      :host([pattern-enter="down"][pattern-playing])   .fg { animation-name: nocap-wipe-down }
      :host([pattern-enter="center"][pattern-playing]) .fg { animation-name: nocap-wipe-center }
      @media (prefers-reduced-motion: reduce) {
        :host([pattern-enter][pattern-playing]) .fg { animation: none }
      }
      .hint { position: absolute; inset: 0; display: grid; place-items: center;
              font: 500 12px/1.3 ui-sans-serif, system-ui, sans-serif;
              letter-spacing: .04em; text-align: center; padding: 0 10px;
              pointer-events: none; opacity: 0; transition: opacity .28s ease; }
      .hint.on { opacity: .82; }
      @media (prefers-reduced-motion: reduce) { .hint { transition: none; } }
    </style>`;

    this.#canvas = document.createElement('canvas');
    root.append(this.#canvas);

    this.#fg = document.createElement('div');
    this.#fg.className = 'fg';
    root.append(this.#fg);

    this.#hint = document.createElement('div');
    this.#hint.className = 'hint';
    root.append(this.#hint);

    this.#flicker = new Flicker(this.#canvas, this.#options()).resize(
      +(this.getAttribute('width') ?? 260),
      +(this.getAttribute('height') ?? 56),
      this.#dpr()
    );

    // A value can be set before the element is in the document, and on re-attach
    // #secret survives while the flicker does not. Without this both cases leave
    // a blank canvas and no warning.
    if (this.#secret || this.#chars?.length) this.render();

  }

  disconnectedCallback() {
    if (this.#scratch) {
      cancelAnimationFrame(this.#scratch.raf);
      this.#scratch = null;
    }
    this.#flicker?.destroy();
    this.#flicker = null;
    this.#canvas = null;
  }

  attributeChangedCallback(name) {
    if (!this.#flicker) return;
    // An element that is not being looked at has no reason to burn a frame.
    // Thirty-nine of them animating at once dragged the whole page to ~41Hz,
    // which puts the two-plane cycle at 21Hz -- inside the band the flicker
    // warning exists to complain about. Pausing the ones that are not on
    // screen is what keeps the visible ones at full rate.
    if (name === 'paused') {
      if (this.hasAttribute('paused')) this.#flicker.stop();
      else this.#flicker.start();
      return;
    }
    if (name === 'max-dpr' || name === 'width' || name === 'height') {
      // All three change the device size of the canvas, which resize owns.
      // width and height were observed but used to fall through to a bare
      // reconfigure, so the split rebuilt at the old size and the element
      // never actually changed dimensions.
      this.#flicker.resize(
        +(this.getAttribute('width') ?? 260),
        +(this.getAttribute('height') ?? 56),
        this.#dpr()
      );
    }
    // Presentational only: these drive CSS inside the shadow root and change
    // nothing about the split, so reconfiguring and repainting for them is
    // pure waste.
    if (name === 'pattern-enter' || name === 'pattern-playing') return;
    this.#flicker.configure(this.#options());
    if (this.#revealed) this.render();
  }

  /** Write-only by design: reading it back would put the secret in reach again. */
  set secret(value) {
    const str = String(value ?? '');
    if (this.hasAttribute('scramble')) {
      // Keep the glyphs, drop the arrangement. Nothing in this object is ever
      // the plaintext in order, so a heap snapshot search for it finds nothing.
      const pairs = [...str].map((ch, i) => [ch, i]);
      // Still obfuscation, not encryption. But a CSPRNG is free here and
      // removes the question of whether the shuffle is predictable.
      const rand = (n) => {
        if (typeof crypto?.getRandomValues === 'function') {
          const buf = new Uint32Array(1);
          crypto.getRandomValues(buf);
          return buf[0] % n;
        }
        return Math.floor(Math.random() * n);
      };
      for (let i = pairs.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
      }
      this.#chars = pairs.map((p) => p[0]);
      this.#slots = pairs.map((p) => p[1]);
      this.#secret = '';
    } else {
      this.#secret = str;
      this.#chars = this.#slots = null;
    }
    this.render();
  }

  get revealed() {
    return this.#revealed;
  }

  /**
   * Measured display refresh, or 0 before the first few frames land. Worth
   * surfacing: below ~120Hz the two-plane cycle runs at 30Hz and shimmers, and
   * a viewer should be told that rather than concluding the technique looks bad.
   */
  get refreshHz() {
    return this.#flicker?.stats.refreshHz ?? 0;
  }

  render = async () => {
    if (!this.#flicker || !(this.#secret || this.#chars?.length)) return;

    const { color, background } = this.#palette;
    const style = this.#textStyle();
    const font = style.font;
    const fakeMode = this.getAttribute('fake');
    // Scramble empties #secret and keeps the glyphs in #chars, so fake mode has
    // to reassemble to know what shape to imitate. Guarding on #secret alone
    // meant enabling both silently dropped the decoy. The mode looked on and
    // did nothing.
    const plain = this.#secret || this.#reassemble();
    // The mark is composited under whichever mode draws the value, rather than
    // being a fourth branch. It was one, and an if/else made `watermark` with
    // `fake` drop the decoys and `watermark` with `scramble` drop the mark, both
    // silently. Same shape as the fake/scramble clash fixed earlier: modes that
    // add to each other cannot be selected between.
    //
    // Fake mode was inert in 0.1 because at the old defaults (share 0.35, size
    // 0.55) the decoy read FAINTER in a capture than the secret it covers,
    // 0.175 against 0.217, so it misled nobody. The defaults moved to the
    // measured working point instead: at share 0.8 and full size the decoy
    // reads at roughly twice the real value's correlation in a captured frame,
    // raw and blurred both, with the viewer-visible ghost at most one code
    // level. See resolveFake for the numbers.
    //
    // fake and scramble are genuinely alternative draw paths for the value
    // (one canvas draw against per-cell blits), so fake wins and says so,
    // rather than one of them silently dropping.
    if (fakeMode && fakeMode !== 'off') {
      if (this.#chars) {
        warnOnce('fake-scramble',
          'fake and scramble are both set. Fake mode draws the value in a ' +
          'single fillText, so scramble\'s per-cell draw (and its protection ' +
          'against fillText hooks) does not apply while fake is on.');
      }
      await this.#drawFake(font, color, background, fakeMode, plain);
    } else if (this.#chars) {
      await this.#drawScrambled(font, color, background);
    } else {
      await this.#drawPlain(font, color, background, plain);
    }
    this.#warnPalette();
    this.#syncScratch();
    this.#revealed = true;
    // Paused means paused, including on first render. This line used to start
    // the cycle unconditionally, and the attribute could not intervene: set
    // before connect it found no flicker to stop, and setting the value then
    // triggered render, which started it anyway. On the promo that meant all
    // thirty-seven canvases animated from load until their beat had played
    // once, and the paused/running counts looked right the whole time because
    // they were counts of the attribute, not of the animation.
    // Held on plane 0 instead: one plane is what paused shows by definition.
    if (this.hasAttribute('paused')) this.#flicker.showPlane(0);
    else this.#flicker.start();
    this.#adaptBlock();
    this.dispatchEvent(new CustomEvent('render'));
  };

  /** Stop the alternation and clear the canvas. Call render() to resume. */
  stop = () => {
    if (!this.#flicker || !this.#revealed) return;
    this.#flicker.stop();
    // Overwrite: a stopped Flicker leaves its last plane on screen, and one
    // plane is exactly what a screenshot should not be able to sit and read.
    const { ctx, canvas } = this.#flicker;
    ctx.fillStyle = this.#perceived(this.#palette.background);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.#revealed = false;
    this.dispatchEvent(new CustomEvent('stop'));
  };

  /**
   * Scratch-to-reveal: the planes show only where the pointer has been.
   *
   * Everything else in this library leaves the value on screen for as long as
   * it is revealed, which is why two captured frames average to it exactly.
   * There is no arrangement of noise that changes that, because the pixel is
   * there the whole time.
   *
   * This changes the thing the arithmetic depends on. A pixel carries content
   * only while it is inside the trail, so over a capture of any length it
   * averages to roughly `duty * content + (1 - duty) * background`, while the
   * noise keeps its amplitude throughout. Signal falls with the duty cycle and
   * noise does not, so the attacker's SNR falls with it.
   *
   * It is still a cost rather than a defence. Sweep the whole value and a long
   * enough recording holds the whole value, just faint; contrast normalisation
   * brings it back with more noise on it. Lower duty is safer and harder to
   * read, which is the same single knob as everything else here.
   *
   * Three costs that are not negotiable, so they are stated rather than
   * discovered:
   *
   *   Accessibility. It needs a pointer. Keyboard and screen reader users
   *   cannot scrub, so an integration MUST offer them another route. This is a
   *   hard blocker, not a rough edge.
   *
   *   Touch. There is no hover, so a drag is required, and a drag competes with
   *   scrolling.
   *
   *   Reading a long value by sweeping is slow. Opt in, never a default.
   */
  #syncScratch() {
    const on = this.hasAttribute('scratch');
    if (!on) {
      if (this.#scratch) {
        cancelAnimationFrame(this.#scratch.raf);
        this.#flicker?.setRevealMask(null);
        // Undo both of the things turning it on did to the element. Leaving the
        // listeners attached leaked a set on every toggle, and leaving
        // touchAction pinned kept the page unscrollable over an element that is
        // no longer scratchable.
        for (const [type, fn] of this.#scratch.listeners ?? []) {
          this.removeEventListener(type, fn);
        }
        this.style.touchAction = '';
        if (this.#hint) this.#hint.classList.remove('on');
        liveScratch.delete(this.#scratch);
        this.#scratch = null;
      }
      return;
    }
    if (this.#scratch) return;

    const { width: w, height: h } = this.#flicker.canvas;
    const mask = makeCanvas(w, h);
    const ctx = mask.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    this.#flicker.setRevealMask(mask, this.#perceived(this.#palette.background));

    const state = { mask, ctx, raf: 0, x: -1, y: -1, down: false };
    this.#scratch = state;

    const dpr = this.#dpr();

    // Brush size in CSS pixels, so it looks the same on every display. The mask
    // is a device-pixel buffer, hence the scale. Without it the same number drew
    // a brush half as wide on a 2x screen as on a 1x one.
    // A fingertip covers far more than a mouse cursor points at, and worse, it
    // sits on top of the thing it is revealing. A wider default brush puts some
    // of the trail outside the contact patch where it can actually be read.
    const coarse = typeof matchMedia === 'function'
      && matchMedia('(pointer: coarse)').matches;
    const radius = () =>
      Math.max(1, +(this.getAttribute('scratch-radius') ?? (coarse ? 52 : 34))) * dpr;
    // Seconds a stroke stays readable. See scratchLingerKeep for what that means.
    const linger = () => +(this.getAttribute('scratch-linger') ?? 30);

    // Shown until the first scratch, then again once the trail has faded, so it
    // reappears exactly when the element has gone blank and needs explaining
    // again. Tied to `linger` rather than a constant for that reason.
    const HINT_DEFAULT = 'Scratch to reveal';
    let lastActivity = 0;
    let hintText = '';
    const syncHint = (now) => {
      if (!this.#hint) return;
      const raw = this.getAttribute('scratch-hint');
      const off = raw === 'off' || raw === '';
      const text = off ? '' : (raw ?? HINT_DEFAULT);
      // Assigning textContent every frame would be wasteful and would fight a
      // screen reader, so only on a real change.
      if (text !== hintText) {
        hintText = text;
        this.#hint.textContent = text;
      }
      this.#hint.style.color = this.#perceived(this.#palette.color);
      const faded = !lastActivity || (now - lastActivity) > linger() * 1000;
      this.#hint.classList.toggle('on', !off && faded);
    };

    let last = 0;
    const step = (now) => {
      state.raf = requestAnimationFrame(step);
      syncHint(now);
      // Decay by elapsed time rather than per frame. A constant per-frame factor
      // cleared the trail twice as fast on a 120Hz display as on a 60Hz one, so
      // no setting could honestly say how long a stroke lasts.
      //
      // The gap is deliberately not clamped. A backgrounded tab stops firing
      // rAF, so the first frame back carries the whole absent interval and the
      // trail is already gone, which is the direction to err in for a reveal.
      const dt = last ? (now - last) / 1000 : 0;
      last = now;

      // Punch the existing mask down. Painting translucent black with
      // destination-out multiplies alpha, the cheap way to get exponential decay.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${1 - scratchLingerKeep(dt, linger())})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      if (state.x >= 0) {
        const r = radius();
        const g = ctx.createRadialGradient(state.x, state.y, 0, state.x, state.y, r);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(state.x, state.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    state.raf = requestAnimationFrame(step);

    // Touch has no hover, so the gesture is a drag, and a drag over an element
    // is a scroll unless the element says otherwise. Without this, pointermove
    // never fires on a phone and scratch mode silently does nothing at all.
    this.style.touchAction = 'none';

    // Only one at a time. See liveScratch: this is about what a single frame can
    // contain, not about what an attacker can extract.
    const clearOthers = () => {
      if (this.getAttribute('scratch-exclusive') === 'off') return;
      for (const other of liveScratch) {
        if (other !== state && other.ctx) {
          other.ctx.save();
          other.ctx.globalCompositeOperation = 'destination-out';
          other.ctx.fillStyle = 'rgba(0,0,0,1)';
          other.ctx.fillRect(0, 0, other.mask.width, other.mask.height);
          other.ctx.restore();
          other.x = other.y = -1;
        }
      }
    };

    const track = (e) => {
      lastActivity = performance.now();
      clearOthers();
      const rect = this.getBoundingClientRect();
      state.x = (e.clientX - rect.left) * dpr;
      state.y = (e.clientY - rect.top) * dpr;
    };
    const lift = () => { state.x = state.y = -1; };

    const onDown = (e) => {
      // Keep receiving moves when the finger strays outside the element, which
      // it will: the target is small and a fingertip is not precise. Without
      // capture the trail stops at the edge mid-stroke.
      try { this.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      track(e);
    };
    const onUp = (e) => {
      try { this.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      lift();
    };

    // pointerleave alone was enough for a mouse and wrong for touch: lifting a
    // finger fires pointerup, not pointerleave, so the last position stayed live
    // and every frame kept repainting the trail there. It never faded.
    const listeners = [
      ['pointermove', track], ['pointerdown', onDown],
      ['pointerup', onUp], ['pointercancel', onUp], ['pointerleave', lift],
    ];
    for (const [type, fn] of listeners) this.addEventListener(type, fn);
    state.listeners = listeners;
    liveScratch.add(state);
  }

  /** Measured single-plane leak for the current settings, for tuning. */
  measureLeak() {
    const planes = this.#flicker?.planes ?? [];
    if (!planes.length) return null;
    // Against the MEAN, not plane 0. Scoring plane 0 against itself is a
    // correlation of a vector with itself, so Math.max always returned 1.0 and
    // the method carried no information at any setting.
    const target = averageFrames(planes);
    return Math.max(...planes.map((p) => leakScore(p, target)));
  }

  /**
   * Draw scrambled glyphs back into their real positions.
   *
   * Each character is rendered alone into a scratch canvas at a fixed point and
   * then blitted to its slot. That split matters: a hook on
   * `CanvasRenderingContext2D.prototype.fillText`. The one-liner that otherwise
   * defeats this component outright, sees single characters in shuffled order,
   * every one drawn at the same coordinates. It recovers the multiset of
   * characters and the length, not the arrangement. Position lives in the
   * drawImage calls instead, so an attacker now has to hook two APIs and
   * correlate them rather than dump one log.
   *
   * Be clear about the level: this is obfuscation, not encryption. #chars and
   * #slots are both live fields on the element, so anyone who reads both
   * reconstructs the value immediately. It raises the cost of a casual console
   * poke. It does not withstand someone who has decided to extract the value.
   */
  /**
   * Decoy lines that survive frame averaging, carried in chrominance.
   *
   * EXPERIMENTAL, and narrower than it looks. Read the whole of this before
   * enabling it.
   *
   * Every other decoy in this library cancels between the two planes, so the
   * viewer never resolves one and averaging a run of frames removes them. That
   * is the point there, and it is also the limit: an attacker who averages ends
   * up with the clean real value.
   *
   * These do not cancel. They are composited into the source BEFORE the split,
   * so they are part of what the pair averages to and they are still there
   * after any number of frames. What keeps them off the viewer is not time, it
   * is colour: they are isoluminant with the background, and the eye resolves
   * chrominance far more coarsely than luminance.
   *
   * What this does NOT do, and cannot:
   *
   *   The real value lives in luminance, because that is what a person reads.
   *   One greyscale conversion therefore strips every decoy and leaves the real
   *   value untouched. Measured: decoy correlation 0.996 in colour, 0.020 after
   *   `-vf format=gray`. There is no version of this that survives that, and
   *   claiming otherwise would be a lie.
   *
   * So the honest description is: an attacker who does not think to drop colour
   * comes away with a plausible wrong value. That covers automated capture,
   * paste-into-chat, and anything fed to a model as an image. It does not cover
   * anyone who has read this comment.
   *
   * Two more things measured rather than assumed: the decoys survive H.264 at
   * 4:2:0 (0.917 at screen-share bitrates, so a recording keeps them), and they
   * do not raise the real value's single-plane leak (0.132 either way).
   *
   * Verified in a browser, not only on the arrays: in the averaged frame the
   * decoy band carries 16.6 of chrominance variation against 6.0 elsewhere,
   * and 5.1 of luminance variation against 16.1 elsewhere. The decoys are in
   * chroma, the value is in luma, measured end to end.
   *
   * Isoluminant is not invisible. Equiluminant text is a well-known case of
   * something visible but hard to localise and hard to focus. Expect to see a
   * faint tint and decide whether it is tolerable on your own content.
   */
  /**
   * Paint the isoluminant mark, if one is set. Called by every path that draws
   * the value, so it composes with all of them instead of replacing one.
   */
  #paintWatermark(ctx, font, background, w, h) {
    const mark = this.getAttribute('watermark');
    if (!mark || mark === 'off') return;
    this.#warnWatermark();

    const swing = this.hasAttribute('watermark-swing')
      ? +this.getAttribute('watermark-swing')
      : 60;
    // Pick the direction with room in it, so a blue-heavy background moves
    // toward yellow instead of quietly getting a reduced swing.
    const up = isoluminantPartner(background, swing);
    const down = isoluminantPartner(background, -swing);
    const pick = Math.abs(up.swing) >= Math.abs(down.swing) ? up : down;
    this.#watermarkSwing = pick.swing;

    const repeat = Math.max(1, Math.min(8, +(this.getAttribute('watermark-repeat') ?? 3)));
    const rand = () => {
      if (typeof crypto?.getRandomValues === 'function') {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return buf[0] / 2 ** 32;
      }
      return Math.random();
    };
    ctx.save();
    ctx.font = font;
    ctx.fillStyle = pick.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < repeat; i++) {
      // Scattered and overlaid rather than on a clear row: a mark on its own
      // row is trivially cropped out, and cropping is the cheapest removal.
      const spread = 0.35;
      ctx.fillText(mark, w / 2 + (rand() - 0.5) * w * spread,
                   h / 2 + (rand() - 0.5) * h * spread);
    }
    ctx.restore();
  }

  #warnWatermark() {
    if (this.#watermarkWarned) return;
    this.#watermarkWarned = true;
    console.warn(
      '[nocap-secret] watermark marks a capture for attribution, it does not ' +
        'protect the value. It survives frame averaging, but one greyscale ' +
        'conversion removes it: 0.996 correlation with colour, 0.020 after ' +
        '`-vf format=gray`. Casual leaks, not a determined one.'
    );
  }

  /** Achieved chroma swing of the mark, 0 if none is set. */
  get watermarkSwing() {
    return this.#watermarkSwing ?? 0;
  }

  /** The value on its own, with the mark under it if one is set. */
  async #drawPlain(font, color, background, plain) {
    const { width: w, height: h } = this.#flicker.canvas;
    const cv = makeCanvas(w, h);
    const ctx = cv.getContext('2d', { alpha: false });
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    this.#paintPattern(ctx, background, w, h);
    this.#paintWatermark(ctx, font, background, w, h);
    const style = this.#textStyle();
    this.#applyTextStyle(ctx, style);
    ctx.fillStyle = color;
    ctx.textAlign = style.align;
    ctx.textBaseline = 'middle';
    // Canvas draws what fits and drops the rest without a word, so a cell sized
    // slightly too small ships a value nobody can read, viewer included, and
    // nothing anywhere says so. Same shape as the other silent failures already
    // fixed here: an unsupported letterSpacing, a forced-off linearLight.
    const needs = ctx.measureText(plain).width + style.padX * 2;
    if (needs > w) {
      warnOnce(`clip:${w}:${Math.round(needs)}`,
        `the value needs ${Math.round(needs / (w / this.offsetWidth || 1))}px and the ` +
        `element is ${this.offsetWidth}px, so about ` +
        `${Math.ceil((needs - w) / (needs / plain.length))} character(s) are cut off ` +
        'and never drawn. Widen it, lower font-scale, or set a smaller font-size.');
    }
    ctx.fillText(plain, this.#anchorX(style, w), h / 2 + style.padY);
    this.#paintChromaDecoy(ctx, font, background, w, h);
    // cv is exactly the target size, so setSource's contain-fit is identity.
    await this.#flicker.setSource(cv, { background });
  }

  async #drawScrambled(font, color, background) {
    // The font reaches this path, baked into the string. The rest of the
    // styling has nothing here to act on: every glyph is drawn alone into its
    // own cell and the cells are placed below, so there is no run of text to
    // space out and no single fillText to align or pad. That is a consequence
    // of how scrambling works rather than an oversight, but an attribute that
    // is honoured everywhere else and quietly ignored here is exactly the kind
    // of silence the value checks were added to remove.
    const inert = ['letter-spacing', 'text-align', 'padding-x', 'padding-y']
      .filter((a) => this.hasAttribute(a));
    if (inert.length) {
      warnOnce(`scramble-inert:${inert.join()}`,
        `${inert.join(', ')} ${inert.length > 1 ? 'have' : 'has'} no effect while ` +
        'scramble is on, because each glyph is drawn into its own cell. The font ' +
        'attributes do apply. See issue #14.');
    }

    const { width: w, height: h } = this.#flicker.canvas;
    const scratch = makeCanvas(w, h);
    const ctx = scratch.getContext('2d', { alpha: false });
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    ctx.font = font;

    // Monospace, so one advance width covers every glyph.
    const advance = ctx.measureText('0').width;
    const originX = (w - advance * this.#chars.length) / 2;

    const cell = makeCanvas(Math.ceil(advance) + 4, h);
    const cellCtx = cell.getContext('2d', { alpha: false });

    for (let i = 0; i < this.#chars.length; i++) {
      cellCtx.fillStyle = background;
      cellCtx.fillRect(0, 0, cell.width, cell.height);
      cellCtx.font = font;
      cellCtx.fillStyle = color;
      cellCtx.textAlign = 'center';
      cellCtx.textBaseline = 'middle';
      cellCtx.fillText(this.#chars[i], cell.width / 2, h / 2);
      ctx.drawImage(cell, originX + this.#slots[i] * advance - cell.width / 2 + advance / 2, 0);
    }

    // After the glyphs, not before: each glyph is blitted as an opaque cell
    // filled with the background, so a mark painted first is erased by them.
    // Isoluminant either way, so sitting on top costs nothing.
    this.#paintWatermark(ctx, font, background, w, h);

    // scratch is exactly the target size, so setSource's contain-fit is identity
    // and the noise is never resampled.
    await this.#flicker.setSource(scratch, { background });
  }

  /**
   * Linear light reproduces colours exactly but cannot invent headroom, so a
   * near-black or near-white palette is protected far less than it looks.
   * Say so once rather than under-protecting silently.
   */
  #warnPalette() {
    if (this.#paletteWarned) return;
    this.#paletteWarned = true;
    const { warnings } = checkPalette(this.#palette);
    for (const w of warnings) console.warn(`[nocap-secret] ${w}`);
  }

  /**
   * Decoy planes: one frame carries a plausible wrong value, the other carries
   * whatever makes the pair average back to the truth.
   *
   * EXPERIMENTAL. Sound in mechanism, narrow in useful range: see the warning
   * emitted on first use, and the README.
   *
   * Noise announces failure and invites another screenshot. A value in the right
   * shape does not.
   *
   * Every frame carries a DIFFERENT decoy, and every decoy appears exactly twice
   * across the rotation. Once added, once subtracted, one cycle apart. So they
   * cancel exactly in the mean and the viewer never resolves any of them, while
   * a capture, which cannot average, freezes one at full contrast.
   *
   * An earlier version placed a single decoy in the gaps between the real glyphs
   * to protect readability. Per-frame cancellation removes the need: the decoy
   * is never seen at all, so it no longer has to keep out of the way.
   */
  /**
   * A decoy written in chrominance only, at zero luminance contrast.
   *
   * Every other mechanism here hides in TIME and is therefore defeated by
   * capturing more than one frame. This one is spatial: it is in the pixels
   * rather than in their sequence, so it is still there after a thousand frames
   * averaged. That makes it the first thing in this library aimed at the case
   * nocap loses rather than the case it already wins.
   *
   * Two colours of equal luminance whose mean is exactly the background,
   * alternating in fine blocks inside the decoy's glyphs. The eye resolves
   * chrominance at about a third of the acuity it resolves luminance with, so
   * below that limit the pattern greys out into the background. A sensor records
   * the pixels and sees a word.
   *
   * BLOCK SIZE IS THE WHOLE QUESTION, and it is bounded on both sides. At 1px a
   * 4:2:0 codec annihilates it, averaging exactly the 2x2 it alternates over:
   * measured 54.0 in PNG against 1.3 through JPEG 4:2:0. At 2px and above it
   * survives both JPEG and H.264. The ceiling is chromatic acuity, somewhere
   * near 4px at normal viewing distance, above which a viewer sees coloured
   * speckle and the whole thing gives itself away.
   *
   * So the usable window is roughly 2 to 4px and it may not exist at all. That
   * is a judgement about a real screen rather than a measurement, which is why
   * this is opt-in and why the block is a knob rather than a constant.
   */
  #paintChromaDecoy(ctx, font, background, w, h) {
    const text = this.getAttribute('chroma-decoy');
    if (!text) return;
    const block = Math.max(1, Math.round(+(this.getAttribute('chroma-block') ?? 2)));
    const { a, b, swing } = isoluminantPair(background);
    if (swing < 8) {
      warnOnce('chroma-decoy-flat',
        `${background} leaves only ${swing.toFixed(1)} of chroma swing, so a chroma ` +
        'decoy drawn on it is invisible to a sensor as well as to you. It needs a ' +
        'background away from the gamut edge.');
      return;
    }

    // The glyph shape as a coverage mask, so the pattern is painted only where
    // the decoy's ink falls and the background is left exactly alone.
    const mask = makeCanvas(w, h);
    const mc = mask.getContext('2d', { alpha: false, willReadFrequently: true });
    mc.fillStyle = '#000';
    mc.fillRect(0, 0, w, h);
    mc.font = font;
    mc.fillStyle = '#fff';
    mc.textAlign = 'center';
    mc.textBaseline = 'middle';
    mc.fillText(text, w / 2, h / 2);
    const cov = mc.getImageData(0, 0, w, h).data;

    // ADD a zero-luminance offset, never overwrite the pixel.
    //
    // The first version wrote the pair's colours straight in, which discarded
    // whatever the real value had drawn there. The pair averages to the
    // background across the checkerboard, so those pixels became background: the
    // real strokes were erased rather than masked, and since two centred strings
    // of similar length overlap almost entirely, the decoy covered 85% of the
    // real ink. The viewer read the decoy. The design was inverted.
    //
    // Adding instead of replacing is what makes both true at once. The offset
    // has zero luminance by construction, so the real value's brightness is
    // untouched and it stays exactly as readable. The offset flips sign per
    // block, so it averages to nothing for an eye that cannot resolve chroma
    // that finely, while a sensor records the individual pixels and sees the
    // decoy's shape.
    const bg = toRgb(background);
    const d = toRgb(a).map((v, i) => v - bg[i]);
    const img = ctx.getImageData(0, 0, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (cov[i] < 40) continue;
        const sign = (((x / block) | 0) + ((y / block) | 0)) % 2 ? 1 : -1;
        for (let c = 0; c < 3; c++) {
          img.data[i + c] = Math.max(0, Math.min(255, img.data[i + c] + sign * d[c]));
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /**
   * A texture in the element's own background, so it can match the page it sits
   * on instead of being a flat rectangle inside a patterned design.
   *
   * This is the one place a pattern is NOT free, and the difference is worth
   * stating precisely. On the page it costs nothing, because the split never
   * carries it. In here the split has to reproduce it as content, and its darker
   * parts leave those pixels less headroom to be displaced into. Measured:
   *
   *   flat        raw 0.197   blurred 0.224
   *    6 levels   raw 0.200   blurred 0.222   free, and invisible
   *   16 levels   raw 0.225   blurred 0.261   the default
   *   34 levels   raw 0.285   blurred 0.380   a third of the margin gone
   *
   * The default is 16 rather than the free 6, which was the wrong number for a
   * reason worth recording. 6 costs nothing and cannot be seen, so it bought
   * exactly nothing: a texture that is not visible is not a texture. 16 is where
   * it reads in the perceived mean, and it costs about 15% of the leak margin.
   *
   * Judge it LIVE rather than from a screenshot. The pattern survives into the
   * mean at full strength, spread 20 at 20 levels whether the amplitude is 0 or
   * 110, but one captured frame spans 117 levels and buries it completely. A
   * screenshot will show no texture at any setting, and that is not a bug.
   *
   * Strength is in CODE LEVELS rather than a vague 0..1, so the numbers above
   * are directly comparable to it.
   */
  #paintPattern(ctx, background, w, h) {
    const kind = this.getAttribute('pattern');
    if (this.#fg) this.#fg.style.cssText = '';
    if (!kind || kind === 'none') return;
    // In front, the texture is a CSS layer over the canvas rather than content
    // the split has to carry, so it is free and can run at any strength the
    // design wants. Behind, it is in the image and costs what the numbers say.
    if (this.getAttribute('pattern-layer') === 'front') {
      this.#paintForeground(kind, background);
      return;
    }
    // pattern-strength is in levels, and the number means the same thing here
    // as it does in the CSS on the page around it.
    //
    // It carries intact: measured with geometry cancelled (RMS of textured minus
    // flat, before the split over after it), the ratio is 1.00 at every
    // amplitude from 0 to 110 and on every ground from #1a1a1a to #f0f0f0.
    // That is what linearLight is for -- it makes the perceived mean equal the
    // authored image, so a texture in the image survives to the eye whole.
    //
    // An earlier revision divided this by 0.40 to "compensate" for an
    // attenuation that does not exist. That figure came from a harness passing
    // `strength` to splitFrames, which takes `amplitude`, so the option was
    // dropped and every run silently used the defaults -- including
    // linearLight: false, which the element never uses and which really does
    // attenuate (0.71 at amplitude 32, 0.40 at 64, 0.11 at 110). The constant
    // was measured off a configuration the element does not run.
    const levels = Math.max(0, num({ s: this.getAttribute('pattern-strength') }, 's', 16));
    // Past the ground's own swing the texture clips and bands instead of getting
    // stronger, so a large request degrades to the strongest honest version.
    const headroom = Math.floor(codeSwing(background));
    if (levels <= 0) return;
    if (levels > headroom) {
      warnOnce(`pattern:${levels}`,
        `pattern-strength ${levels} is past what this ground can carry (${headroom}), ` +
        'its cost. Raw leak goes 0.197 flat, 0.225 at 16 levels and 0.285 at 34, ' +
        'and blurred 0.224, 0.261 and 0.380. 16 is the default and reads clearly.');
    }

    const bg = toRgb(background);
    // Lighter where the ground is dark and darker where it is light, so the
    // texture reads at either end instead of vanishing into one of them.
    const dir = luma(bg) < 128 ? 1 : -1;
    const ink = `rgb(${bg.map((v) => Math.max(0, Math.min(255, v + dir * levels))).join(',')})`;
    // Scaled by density, so a 16px CSS pattern on the page and this one line up.
    const dpr = this.#dpr();
    // EXACT pitches, matching the CSS the demo pages use. These were 16, 13.12
    // and 46.4 against the page's 16, 13 and 46, and a 0.12px error per stripe
    // accumulates into a visible drift across a 300px block: the two patterns
    // start aligned at one edge and are half a stripe out by the other.
    const unit = Math.max(6, Math.round(16 * dpr));   // dots
    // 13px is the PERPENDICULAR spacing, which is what a CSS
    // repeating-linear-gradient(45deg, ... 13px) means -- its stops run along
    // the gradient axis, at right angles to the stripes.
    //
    // These lines are stepped along x instead, and two parallel 45deg lines
    // offset horizontally by D sit only D/sqrt(2) apart. Stepping by 13 put them
    // 9.2px apart against the page's 13, so the canvas hatch came out 1.41x too
    // dense: measured by FFT across the boundary, 12.94px horizontal period
    // inside against 18.42px outside. Same angle, same ink, visibly finer mesh.
    const hatchPitch = Math.max(5, Math.round(13 * dpr));
    const hatchStepX = hatchPitch * Math.SQRT2;
    const gridPitch = Math.max(12, Math.round(46 * dpr));

    // Phase, so the texture CONTINUES the page's rather than restarting.
    //
    // Pitch alone is not enough and this is the part that looks wrong without
    // it: the element draws from its own top-left while the page draws from the
    // page's, so two patterns at identical spacing still meet out of step at the
    // boundary and read as a patch rather than a continuation.
    //
    // The offset is the element's position within whatever the page texture is
    // anchored to, in CSS px, which only the caller knows. Given here rather
    // than guessed, because the element cannot see its own surroundings.
    const ox = num({ v: this.getAttribute('pattern-offset-x') }, 'v', 0) * dpr;
    const oy = num({ v: this.getAttribute('pattern-offset-y') }, 'v', 0) * dpr;

    const wrap = (v, m) => ((v % m) + m) % m;
    const period = kind === 'hatch' ? hatchStepX : kind === 'grid' ? gridPitch : unit;
    ctx.save();
    ctx.translate(-wrap(ox, period), -wrap(oy, period));
    // NOTE: this phases the separable patterns (dots, grid) but NOT the hatch.
    //
    // Measured by FFT across the boundary, with the element placed at five
    // different positions, the hatch's residual phase error swings 15px out of
    // an 18.38px period -- it varies with position, so it is the phase model
    // that is wrong and not a missing constant. Two attempts at deriving it
    // (a (ox - oy) single phase variable, and a half-stripe centring term) both
    // failed to reduce it, and the stripes were confirmed to run the same
    // diagonal on both sides, so it is not a direction error either.
    //
    // What IS fixed here is the pitch: 18.33px against the page's 18.42px,
    // where it used to be 12.94px. Same angle, same spacing, free phase.
    //
    // pattern-layer="front" phase-locks properly (1.13px residual, ~6% of a
    // period, consistent with rounding the offset to whole pixels) because it
    // is the same CSS gradient on the same pinned tile as the page. Use front
    // when the texture has to line up with the page's.
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    if (kind === 'dots') {
      const r = Math.max(1, unit / 9);
      for (let y = unit / 2; y < h + unit; y += unit) {
        for (let x = unit / 2; x < w + unit; x += unit) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (kind === 'hatch') {
      ctx.lineWidth = Math.max(1, Math.round(3 * dpr));
      for (let d = -h - hatchStepX; d < w + h + hatchStepX; d += hatchStepX) {
        ctx.beginPath();
        ctx.moveTo(d, 0);
        ctx.lineTo(d + h, h);
        ctx.stroke();
      }
    } else if (kind === 'grid') {
      ctx.lineWidth = 1;
      const g = gridPitch;
      for (let x = 0; x < w + g; x += g) { ctx.fillRect(x, 0, 1, h + unit); }
      for (let y = 0; y < h + g; y += g) { ctx.fillRect(0, y, w + unit, 1); }
    } else if (kind === 'grain') {
      // Deterministic, so the texture does not crawl between renders.
      let s = 20261;
      const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const px = Math.max(1, Math.round(dpr));
      for (let y = 0; y < h + px; y += px) {
        for (let x = 0; x < w + px; x += px) {
          if (rnd() < 0.5) continue;
          ctx.globalAlpha = rnd() * 0.9;
          ctx.fillRect(x, y, px, px);
        }
      }
    }
    ctx.restore();
  }

  /**
   * The same texture, over the canvas instead of inside it.
   *
   * This is the version that can actually match a page: it is composited after
   * the split, so it costs nothing and runs at whatever strength the design
   * uses. The in-canvas version is capped by what the split can afford to carry,
   * which is why it can never be as strong as the texture around it.
   *
   * The trade moves rather than disappearing. A texture over the glyphs competes
   * with them, and the default palette separates text from ground by 45 levels,
   * so anything approaching that makes the value harder for a VIEWER to read
   * while doing nothing to an attacker. Legibility, not security.
   */
  #paintForeground(kind, background) {
    if (!this.#fg) return;
    const levels = Math.max(0, num({ s: this.getAttribute('pattern-strength') }, 's', 16));
    if (levels <= 0) return;
    const bg = toRgb(background);
    const V = luma(bg);
    const dir = V < 128 ? 1 : -1;
    // Solve the alpha that moves the ground by exactly `levels`, rather than
    // guessing a coefficient. Compositing c over V gives V + a*(c - V), so for
    // black ink a = levels/V and for white a = levels/(255 - V).
    //
    // The earlier levels/255*3.2 was fitted by eye and is not a calibration: on
    // the promo's #b0b0b0 it turned a request for 20 into about 64 levels of
    // darkening, which is why the element's hatch read three times heavier than
    // the page's instead of continuing it.
    const span = dir > 0 ? 255 - V : V;
    const a = Math.min(0.9, span > 0 ? levels / span : 0);
    const ink = dir > 0 ? `rgba(255,255,255,${a.toFixed(4)})`
                        : `rgba(0,0,0,${a.toFixed(4)})`;
    // Phase comes from CSS custom properties, not from the attributes.
    //
    // attributeChangedCallback only repaints when the element is revealed, so
    // an offset set after the first render silently did nothing -- which is how
    // the promo ended up with pattern-layer="front" and no texture at all.
    // A custom property needs no repaint: the page writes it whenever layout
    // settles and this layer picks it up live.
    //
    // The canvas path still reads the attributes, because it has to repaint to
    // apply them regardless.
    const pos = 'calc(-1 * var(--nocap-pattern-ox, 0px)) '
              + 'calc(-1 * var(--nocap-pattern-oy, 0px))';
    // Grid lines need weight to survive over noise. At the page's 1px they are
    // ~4% coverage in one-pixel features and vanish entirely; swept over real
    // noise at 1/2/3px, 2px is where they read. Tied to strength so the page's
    // thin version and the element's thick one come from one number.
    const linePx = Math.max(1, Math.round(levels / 25));

    const css = {
      dots: `background-image:radial-gradient(${ink} 1.7px, transparent 1.8px);
             background-size:16px 16px; background-position:${pos}`,
      // background-size PINS the tile.
      //
      // Without it a linear-gradient computes its axis from its own box: the
      // line runs through the box centre and its length is (w+h)/sqrt(2), so
      // two boxes of different sizes start their stripes at different places
      // and background-position cannot reconcile them. Measured across the
      // boundary, the element sat 6.87px out of a 18.38px period -- right pitch,
      // wrong phase, which is the exact failure this whole exercise started on.
      //
      // 13*sqrt(2) = 18.3848 is the square lattice a 45deg hatch of
      // perpendicular spacing 13 repeats on. The gradient line across that tile
      // is 26px, exactly two 13px periods, so it tiles seamlessly and phase
      // then depends only on background-position. The page must set the same
      // background-size for its side, or it is comparing tiles to a stretched
      // gradient again.
      hatch: `background-image:repeating-linear-gradient(45deg,
              ${ink} 0 3px, transparent 3px 13px);
              background-size:18.3848px 18.3848px; background-position:${pos}`,
      grid: `background-image:repeating-linear-gradient(${ink} 0 ${linePx}px, transparent ${linePx}px 46px),
             repeating-linear-gradient(90deg, ${ink} 0 ${linePx}px, transparent ${linePx}px 46px);
             background-size:46px 46px; background-position:${pos}`,
      grain: `background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.7' numOctaves='4'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='${Math.min(0.9, a * 1.6).toFixed(2)}'/%3E%3C/svg%3E");
              background-position:${pos}`,
    }[kind];
    if (css) this.#fg.style.cssText = css;
  }

  /** Put the scrambled glyphs back in order. Only for deriving a decoy shape. */
  #reassemble() {
    if (!this.#chars) return '';
    const out = [];
    this.#chars.forEach((ch, i) => { out[this.#slots[i]] = ch; });
    return out.join('');
  }

  /**
   * Decoy planes: each cycle's pair carries a plausible wrong value, added on
   * one frame and subtracted on the other, so a capture freezes a decoy at
   * full contrast and the viewer never resolves any of them.
   *
   * Reinstated in 0.2 with the defaults moved to the measured working point
   * (share 0.8, full size; see resolveFake). At the 0.1 defaults the decoy
   * read fainter in a capture than the value it covered, which is why the 0.1
   * dispatch ignored the attribute.
   */
  async #drawFake(font, color, background, mode, plain) {
    if (!this.#fakeWarned) {
      this.#fakeWarned = true;
      console.warn(
        '[nocap-secret] fake mode is EXPERIMENTAL. At the defaults a captured ' +
          'frame reads the decoy at roughly twice the correlation of the real ' +
          'value, and the viewer sees none of it. But it has had far less use ' +
          'than the rest of the library, and it needs a maskable palette ' +
          '(checkPalette ratio 1.0+). Verify it on your own content before ' +
          'relying on it. Note the value is drawn centred: text-align, ' +
          'letter-spacing and padding do not apply while fake is on.'
      );
    }
    const { width: w, height: h } = this.#flicker.canvas;
    const cycles = 8;
    // How much of each pixel's excursion budget the decoy may take, where its
    // ink falls. The rest stays with the noise, because it is ONE budget:
    // feasibleHalf is the most a pixel can swing and still average, in light,
    // to its target, and the base split is already sitting on it. That is why
    // the old fixed decoyPush did nothing whatever it was set to.
    //
    // Measured on the shipped palette, 20 seeds, decoy at fake-size 0.55
    // (analysis/fake_share_sweep.mjs in the audit repo):
    //
    //   share   decoy in a plane   noise swing left   real secret   ghost
    //    0.00        0.035               82.3            0.205       0.00
    //    0.20        0.112               66.5            0.201       0.01
    //    0.35        0.179               54.0            0.211       0.25
    //    0.50        0.218               41.6            0.216       0.00
    //    0.70        0.266               24.9            0.218       0.03
    //    0.90        0.288                8.3            0.215       0.03
    //
    // Two things that table says, and the second one is not comfortable.
    //
    // The re-solve holds. Ghost is the change in what the VIEWER sees against
    // share 0 on the same seed, and it stays at noise level, so raising the
    // share costs nothing on screen. The real secret's own leak does not rise
    // either, because the budget is only touched where the decoy's ink falls.
    //
    // But at THIS default the decoy is quieter in a capture than the secret it
    // is meant to distract from: 0.175 against 0.217, size held equal. An
    // attacker has no reason to believe it. The decoy only wins at full size,
    // or at a share high enough that the noise where it falls is nearly gone.
    // Fake mode is experimental for this reason and not merely for lack of use.
    const fakeAttrs = {};
    for (const n of ['fake-share', 'fake-size'])
      if (this.hasAttribute(n)) fakeAttrs[n] = this.getAttribute(n);
    const { share, sizeRatio } = resolveFake(fakeAttrs);

    /**
     * The centre whose planes at ±half average, in light, to `want`.
     *
     * The same solve linearMeanTable() performs for the base split, applied
     * again after the decoy widens the pair. Light-mean is monotonic in the
     * centre, so a binary search converges.
     *
     * toLight through a 257-entry table with linear interpolation, not the
     * piecewise curve directly: the search runs 22 iterations for every ink
     * pixel of every channel of every cycle, and the pow() calls made that
     * 530ms of main thread for a typical element. The lerp error is under
     * 1e-5 in light, far below the one-code-level quantisation of the write.
     * Built at the element's gamma; the old direct calls silently used 2.4
     * whatever the gamma attribute said.
     */
    const gamma = this.#options().gamma;
    const L = new Float64Array(257);
    for (let v = 0; v <= 256; v++) L[v] = toLight(Math.min(255, v), gamma);
    const lightAt = (x) => {
      const cl = x < 0 ? 0 : x > 255 ? 255 : x;
      const f = cl | 0;
      return L[f] + (L[f + 1] - L[f]) * (cl - f);
    };
    const centreFor = (want, half) => {
      let lo = half;
      let hi = 255 - half;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if ((lightAt(mid + half) + lightAt(mid - half)) / 2 < want) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };

    const feasibleHalf = feasibleHalfTable(gamma);
    // Full headroom. At half, the decoy competed with the noise and read as a
    // ghost behind the real text. A capture is supposed to come away with the
    // decoy as the most legible thing in the frame.

    const paintOn = (bg, draw) => {
      const cv = makeCanvas(w, h);
      const ctx = cv.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      draw(ctx);
      return ctx.getImageData(0, 0, w, h);
    };
    const paint = (draw) => paintOn(background, draw);

    // The real value, split normally: its mean is what the eye resolves. The
    // mark goes in here rather than into the decoy planes, so it lands in the
    // mean and survives averaging, which is the point of it. The pattern too,
    // for parity with #drawPlain: enabling fake must not silently strip a
    // texture the element was showing.
    const base = splitFrames(paint((ctx) => {
      this.#paintPattern(ctx, background, w, h);
      this.#paintWatermark(ctx, font, background, w, h);
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(plain, w / 2, h / 2);
    }), { ...this.#options(), decoy: null });

    const decoys = [];
    const sets = [];
    const small = font.replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${Math.round(+n * sizeRatio)}px`);
    const blank = paint(() => {});

    // Ink on BLACK, so the red channel IS the coverage, 0 to 1. Differencing
    // white text against a blank of `background` capped it at
    // (255 - background.r) / 255. 0.58 on the default palette, worse on a
    // redder one, so the decoy could never reach full strength.
    const inkFor = (text, dx, dy, size) =>
      paintOn('#000', (ctx) => {
        ctx.font = small.replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${Math.round(+n * size)}px`);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, w / 2 + dx, h / 2 + dy);
      });

    // Each decoy is added on one plane of a cycle and subtracted on the other,
    // so it cancels within a single 2-frame cycle. About 16ms at 60Hz.
    //
    // Pairing them one cycle apart instead was wrong, and wrong in a way that
    // inverted the whole effect. The eye integrates roughly 50-100ms, i.e. 3-6
    // frames, so a pair 16 frames apart never cancels inside the window you
    // actually see: the decoys stayed visible and the noise averaged away,
    // exactly backwards. Variety comes from the eight cycles in the rotation,
    // not from splitting a pair across them.
    for (let k = 0; k < cycles; k++) decoys.push(fakeLike(plain, { mode }));

    const blankInk = blank.data;
    // A random spot and size per decoy, not two fixed lines. The position is a
    // property of the decoy rather than of the appearance, so the added and
    // subtracted copies still land on exactly the same pixels and cancel. It
    // just scatters them across the field instead of stacking two rows.
    // Ranges keep the text inside the canvas at the smallest size.
    const inks = decoys.map((d) =>
      inkFor(d, (Math.random() - 0.5) * w * 0.26,
                (Math.random() - 0.5) * h * 0.62,
                0.8 + Math.random() * 0.45));

    for (let k = 0; k < cycles; k++) {
      const set = base.map((pl) => ({ width: w, height: h, data: new Uint8ClampedArray(pl.data) }));
      const ink = inks[k];
      for (let i = 0; i < blankInk.length; i += 4) {
        const amount = ink.data[i] / 255;
        if (amount <= 0.02) continue;
        for (let c = 0; c < 3; c++) {
          const b0 = base[0].data[i + c];
          const b1 = base[1].data[i + c];

          // Widen the pair by a budget, then re-solve the centre so it still
          // averages IN LIGHT to what it did before.
          //
          // Adding +push / -push around a fixed centre preserves the mean in
          // code space but not in light, because light is convex. Widening a
          // pair raises its mean light even with nothing clipping. That is the
          // exact error linearMeanTable() cancels for the base split, and doing
          // it here reintroduced it wherever the decoy's ink fell.
          //
          // The budget is capped by what this pixel can actually reach, which
          // is the part a constant push gets wrong.
          // Two things were wrong here, and the second one is why nothing
          // showed up at all.
          //
          // THE BUDGET. `feasibleHalf` is the largest half-excursion a pixel can
          // take and still average, in light, to its target. At the default
          // palette that ceiling is 78.4, and TEXT_DEFAULTS already asks for
          // 110, so the base split is ALREADY sitting on the ceiling. Adding a
          // push and clamping to the same ceiling returns the same number. The
          // decoy had exactly zero room, and no amount of pushing harder could
          // have given it any.
          //
          // The budget is conserved. Anything the decoy gets has to come out of
          // the noise, so the noise is reduced where the ink falls and the
          // freed excursion is spent on the decoy. Both halves are still
          // zero-sum, so the perceived value stays exact: measured 0.00 error
          // at every ratio.
          //
          // THE SIGN. It has to come from the excursion after the decoy is in,
          // not from the noise that was there before.
          //
          // Taking `Math.abs(b0 - b1) / 2 + push` and then restoring the noise's
          // own sign widens the pair symmetrically about whichever way that
          // pixel's noise already pointed. The decoy then modulates the noise's
          // AMPLITUDE rather than biasing it, and amplitude modulation of
          // random-sign noise reads as more noise. A captured plane showed the
          // decoy at a correlation of 0.10, which is to say not at all.
          //
          // Adding the push to the signed excursion first biases plane 0 the
          // same way everywhere the ink falls, which is what makes a glyph.
          // Measured on the same simulation: 0.54. The re-solved centre keeps
          // the perceived value exact either way, 0.00 error in both.
          // b0 and b1 are integer code values, so the table hits exactly.
          const want = (L[b0] + L[b1]) / 2;
          const cap = feasibleHalf[Math.round(Math.max(0, Math.min(255, toCode(want, gamma))))];
          // Split the pixel's whole budget between masking it and marking it.
          const { half, signed } = decoySplit(cap, share, amount, b0, b1);
          const centre = centreFor(want, half);
          set[0].data[i + c] = centre + signed;
          set[1].data[i + c] = centre - signed;
        }
      }
      sets.push(set);
    }

    this.#lastDecoy = decoys[0];
    this.#decoys = decoys;
    await this.#flicker.setBank(sets);
  }

  /** Current planes, for demos that show what a capture lands on. */
  get planes() {
    return this.#flicker?.planes ?? [];
  }

  /** The decoys in rotation, for demos. Never exposes the real value. */
  get decoys() {
    return this.#decoys ?? [];
  }

  get lastDecoy() {
    return this.#lastDecoy;
  }

  /**
   * Coarser noise on a fast display.
   *
   * Block size trades blur resistance against flicker fusion: block 5 resists a
   * denoise far better (0.31 leak against 0.60 at block 1) but sits at a low
   * spatial frequency, which is where the eye's temporal sensitivity peaks. At
   * 30Hz that strobes, so the default is a conservative 3. Above ~100Hz the
   * cycle is fast enough to fuse and the stronger setting becomes free.
   *
   * Only applies when noise-scale was not set explicitly, and only once.
   */
  #adaptBlock() {
    if (this.#adapted || this.hasAttribute('noise-scale')) return;
    setTimeout(() => {
      const hz = this.#flicker?.stats.refreshHz ?? 0;
      if (this.#adapted || !hz || hz < 100 || !this.#revealed) return;
      this.#adapted = true;
      // Scaled the same way #defaultBlock is, so this is always an increase.
      // Hardcoding 5 meant that on a 2x display, which is most high-refresh
      // hardware, the default was already higher and this LOWERED it, running
      // the logic backwards on exactly the machines the branch exists for.
      this.#flicker.configure({ noiseScale: Math.round(this.#defaultBlock() * 5 / 3) }).then(() => {
        if (this.#revealed) this.render();
      });
    }, 800);
  }

  /**
   * Block size follows the stroke, which follows devicePixelRatio.
   *
   * The font is derived from the canvas height in DEVICE pixels, so stroke width
   * doubles on a 2x display. A block pinned at 3 device px therefore halves the
   * block-to-stroke ratio there. And that ratio is what decides whether a blur
   * helps the attacker. Measured on the default palette: stroke 3 leaks 0.30
   * under a blur, stroke 8 with the same block leaks 0.58, same settings.
   */
  #reducedMotion() {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** The perceived image, drawn once. No alternation, and no masking with it. */
  #showStill() {
    const planes = this.#flicker.planes;
    if (!planes.length) return;
    // In light, not in code: averageFrames would render this about 19 levels
    // too dark, which is the whole point of the static fallback looking right.
    const mean = perceivedMean(planes, this.#options().gamma);
    this.#flicker.ctx.putImageData(
      new ImageData(mean.data, mean.width, mean.height), 0, 0);
    if (this.#motionWarned) return;
    this.#motionWarned = true;
    console.warn(
      '[nocap-secret] prefers-reduced-motion is set, so the value is shown ' +
        'statically. There is no masking in this mode, so a screenshot reads it.'
    );
  }

  #defaultBlock() {
    return this.#options().noiseScale;
  }

  #textStyle() {
    const attrs = {};
    for (const name of NocapSecret.observedAttributes) {
      if (this.hasAttribute(name)) attrs[name] = this.getAttribute(name);
    }
    return resolveText(attrs, this.#flicker?.canvas.height ?? 56);
  }

  /**
   * Apply the styling a canvas context can carry directly.
   *
   * letterSpacing is not universal: Chrome has had it since 99, Safari since
   * 17.4. Assigning it where it is unsupported is a silent no-op rather than an
   * error, so the element warns once instead of quietly ignoring the attribute.
   */
  #applyTextStyle(ctx, style) {
    // An invalid font string is a silent no-op, and font-family and font-weight
    // are free text that resolveText cannot check without a DOM. Assigning over
    // a sentinel makes the rejection observable: if the string was refused, the
    // sentinel is still there afterwards.
    ctx.font = FONT_SENTINEL;
    ctx.font = style.font;
    if (ctx.font === FONT_SENTINEL && style.font !== FONT_SENTINEL) {
      warnOnce(`font=${style.font}`,
        `font "${style.font}" was rejected by the canvas, so the text is drawn ` +
        'in the default font. Check font-family and font-weight.');
      ctx.font = resolveText({}, style.sizePx / 0.46).font;
    }
    if (style.letterSpacing !== '0px') {
      if ('letterSpacing' in ctx) ctx.letterSpacing = style.letterSpacing;
      else if (!this.#spacingWarned) {
        this.#spacingWarned = true;
        console.warn('[nocap-secret] letter-spacing is not supported by this ' +
          'browser\'s canvas, so the attribute has no effect here.');
      }
    }
  }

  /** Where text starts, given alignment and horizontal padding. */
  #anchorX(style, w) {
    if (style.align === 'left') return style.padX;
    if (style.align === 'right') return w - style.padX;
    return w / 2;
  }

  /**
   * The dpr everything renders at, capped by `max-dpr`.
   *
   * Noise gains nothing from a 3x display: the blocks are deliberately chunky
   * and the canvas is image-rendering:pixelated, but the split, the bitmap
   * bank and every per-frame draw all scale with dpr squared, so a dpr-3 phone
   * does 2.25x the work of dpr-2 for the same look. A page with many elements
   * caps it; a page with one showing small type probably should not, which is
   * why the default is uncapped rather than 2.
   */
  #dpr() {
    const raw = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const cap = parseFloat(this.getAttribute('max-dpr') ?? '');
    return Number.isFinite(cap) && cap > 0 ? Math.min(raw, Math.max(1, cap)) : raw;
  }

  #options() {
    const attrs = {};
    for (const name of NocapSecret.observedAttributes) {
      if (this.hasAttribute(name)) attrs[name] = this.getAttribute(name);
    }
    return resolveOptions(attrs, this.#dpr(), +(this.getAttribute('height') ?? 56));
  }

  /**
   * Authored colours. Under the default (non-adaptive) split these are pulled
   * into [amplitude, 255-amplitude], so what you see is a hue-preserved, lower
   * contrast version. Tinted rather than grey, but never the literal values.
   * `adaptive` reproduces them exactly and caps amplitude to their headroom
   * instead. See maxAmplitudeFor().
   */
  /**
   * What an authored colour will actually look like: the splitter compresses
   * every source pixel into [amplitude, 255-amplitude]. The cover has to use
   * this, not the authored value, or the placeholder and the revealed canvas
   * are visibly different colours.
   */
  #perceived(hex) {
    const { lo, hi } = planeRange(this.#options());
    // linearLight and adaptive both return the full range, i.e. no compression,
    // so the authored colour is already what you see.
    if (lo === 0 && hi === 255) return hex;
    const span = (hi - lo) / 255;
    const s = String(hex).replace('#', '');
    const full = s.length === 3 ? [...s].map((c) => c + c).join('') : s;
    const out = [0, 2, 4]
      .map((i) => Math.round(lo + (parseInt(full.slice(i, i + 2), 16) || 0) * span))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    return `#${out}`;
  }

  get #palette() {
    const asked = {
      // Defaults must be maskable, not merely handsome. #e8e8f0 on #14141a is
      // the obvious dark-UI pairing and it leaks 0.951. A screenshot reads it
      // outright. This pair scores a masking ratio of 1.42 and leaks 0.180.
      // Anything you override with should be checked against checkPalette().
      color: this.getAttribute('color') ?? '#9ea6b4',
      background: this.getAttribute('background') ?? '#6b7280',
    };

    // Protection wins over the exact hex, unless you say otherwise.
    //
    // A pair that cannot carry noise is not a weaker version of this technique,
    // it is none of it: white has a swing of exactly 0, so a captured frame
    // shows the value as plainly as a screenshot of ordinary text. The old
    // behaviour was to render it anyway and put a line in the console, which is
    // invisible in production, so the failure mode was a secret on screen and
    // no signal anyone would see.
    //
    // What made it unmaskable was never the colour. It was this split insisting
    // the frames average to the authored hex, which is a choice about fidelity
    // rather than a law. Giving up the exact hex buys back the headroom and the
    // noise does what it always could.
    if (this.getAttribute('fit') === 'off') return asked;
    const fitted = fitToBand(asked);
    if (fitted.moved) {
      warnOnce(`fit:${asked.color}:${asked.background}`,
        `${asked.color} on ${asked.background} cannot carry noise (masking ratio ` +
        `${checkPalette(asked).ratio.toFixed(2)}), so a single frame would show the ` +
        `value. Rendered ${fitted.color} on ${fitted.background} instead, which ` +
        `masks at ${fitted.ratio.toFixed(2)} and keeps the hue. Contrast drops to ` +
        `${fitted.contrast.toFixed(2)}:1. Set fit="off" to keep your exact colours ` +
        'and lose the protection.');
    }
    return { color: fitted.color, background: fitted.background };
  }

  /** What the palette was moved to, or null if it was already maskable. */
  get fitted() {
    if (this.getAttribute('fit') === 'off') return null;
    const r = fitToBand({
      color: this.getAttribute('color') ?? '#9ea6b4',
      background: this.getAttribute('background') ?? '#6b7280',
    });
    return r.moved ? r : null;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('nocap-secret')) {
  customElements.define('nocap-secret', NocapSecret);
}

function makeCanvas(w, h) {
  return typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
}
