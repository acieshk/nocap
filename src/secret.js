import { Flicker } from './flicker.js';
import { leakScore, planeRange, averageFrames, perceivedMean } from './splitter.js';
import { checkPalette, toLight, toCode, isoluminantPartner, fitToBand } from './palette.js';
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
  // where the eye's temporal sensitivity peaks. Wants 120Hz+ to fuse.
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
  // White ships. Blue costs nothing on security (0.254 against 0.252 raw, and
  // identical after the best blur, over 12 seeds) and moves the noise energy
  // away from the low spatial frequencies where temporal sensitivity peaks. It
  // is not the default only because the comfort win is unverified on a real
  // panel, which is the one thing no measurement here can settle.
  noiseProfile: 'white',
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
    share: Math.max(0, Math.min(0.9, num(attrs, 'fake-share', 0.35))),
    // The decoy's font size relative to the real text.
    sizeRatio: Math.max(0.1, Math.min(1, num(attrs, 'fake-size', 0.55))),
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
  base.noiseScale = Math.max(2, Math.round(strokePx * (base.blockRatio ?? SATURATES)));
  // blockRatio is how a preset is authored. It is not a split option, and
  // leaving it in would hand splitFrames a key it does not know.
  delete base.blockRatio;

  if (base.noiseScale < strokePx * SATURATES) {
    warnOnce(`block:${base.noiseScale}:${strokePx}`,
      `noise block ${base.noiseScale}px is under ${SATURATES}x the ${strokePx}px stroke, ` +
      `so a blur can recover some of the value. Use ${Math.round(strokePx * SATURATES)}px ` +
      'to close it, at the cost of more visible shimmer.');
  }

  const num = (name, fallback) => (name in attrs ? +attrs[name] : fallback);
  return {
    ...base,
    amplitude: num('amplitude', base.amplitude),
    frames: num('frames', base.frames),
    contrast: num('contrast', base.contrast),
    noiseScale: num('noise-scale', base.noiseScale),
    // Switchable so the algorithms can be compared on the same content. Only
    // 'amplitude' masks. The others are here because a claim that the obvious
    // alternatives fail is worth being able to run rather than read.
    mode: attrs.mode ?? base.mode,
    noiseProfile: attrs['noise-profile'] ?? base.noiseProfile,
    chroma: num('chroma', base.chroma),
    gamma: num('gamma', base.gamma),
    hardness: num('hardness', base.hardness),
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
    'noise-scale',
    'noise-profile',
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
      .hint { position: absolute; inset: 0; display: grid; place-items: center;
              font: 500 12px/1.3 ui-sans-serif, system-ui, sans-serif;
              letter-spacing: .04em; text-align: center; padding: 0 10px;
              pointer-events: none; opacity: 0; transition: opacity .28s ease; }
      .hint.on { opacity: .82; }
      @media (prefers-reduced-motion: reduce) { .hint { transition: none; } }
    </style>`;

    this.#canvas = document.createElement('canvas');
    root.append(this.#canvas);

    this.#hint = document.createElement('div');
    this.#hint.className = 'hint';
    root.append(this.#hint);

    this.#flicker = new Flicker(this.#canvas, this.#options()).resize(
      +(this.getAttribute('width') ?? 260),
      +(this.getAttribute('height') ?? 56)
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

  attributeChangedCallback() {
    if (!this.#flicker) return;
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
    if (fakeMode && fakeMode !== 'off' && plain) {
      await this.#drawFake(font, color, background, fakeMode, plain);
    } else if (this.#chars) {
      await this.#drawScrambled(font, color, background);
    } else {
      await this.#drawPlain(font, color, background, plain);
    }
    this.#warnPalette();
    this.#syncScratch();
    this.#revealed = true;
    this.#flicker.start();
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

    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;

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

    const track = (e) => {
      lastActivity = performance.now();
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
    this.#paintWatermark(ctx, font, background, w, h);
    const style = this.#textStyle();
    this.#applyTextStyle(ctx, style);
    ctx.fillStyle = color;
    ctx.textAlign = style.align;
    ctx.textBaseline = 'middle';
    ctx.fillText(plain, this.#anchorX(style, w), h / 2 + style.padY);
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
  /** Put the scrambled glyphs back in order. Only for deriving a decoy shape. */
  #reassemble() {
    if (!this.#chars) return '';
    const out = [];
    this.#chars.forEach((ch, i) => { out[this.#slots[i]] = ch; });
    return out.join('');
  }

  async #drawFake(font, color, background, mode, plain) {
    if (!this.#fakeWarned) {
      this.#fakeWarned = true;
      console.warn(
        '[nocap-secret] fake mode is EXPERIMENTAL. It works. A capture reads a ' +
          'plausible wrong value and the viewer sees none of them. But it has ' +
          'had far less use than the rest of the library. Verify it on your own ' +
          'content before relying on it.'
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
     */
    const centreFor = (want, half) => {
      let lo = half;
      let hi = 255 - half;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if ((toLight(mid + half) + toLight(mid - half)) / 2 < want) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };

    const feasibleHalf = feasibleHalfTable(this.#options().gamma);
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
    // mean and survives averaging, which is the point of it.
    const base = splitFrames(paint((ctx) => {
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
          const want = (toLight(b0) + toLight(b1)) / 2;
          const cap = feasibleHalf[Math.round(Math.max(0, Math.min(255, toCode(want))))];
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

  #options() {
    const attrs = {};
    for (const name of NocapSecret.observedAttributes) {
      if (this.hasAttribute(name)) attrs[name] = this.getAttribute(name);
    }
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    return resolveOptions(attrs, dpr, +(this.getAttribute('height') ?? 56));
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
