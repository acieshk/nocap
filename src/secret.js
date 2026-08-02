import { Flicker } from './flicker.js';
import { leakScore, planeRange, averageFrames, perceivedMean } from './splitter.js';
import { checkPalette, toLight, toCode } from './palette.js';
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
  // panel. A single frame still leaks noticeably more.
  weak: { amplitude: 80, noiseScale: 4, hardness: 0.5 },
  medium: { amplitude: 110, noiseScale: 6, hardness: 1 },
  // Coarser noise resists a blur best but sits at a low spatial frequency,
  // where the eye's temporal sensitivity peaks. Wants 120Hz+ to fuse.
  strong: { amplitude: 127, noiseScale: 8, hardness: 1 },
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
  // the same leak for less visual noise. Which does not reproduce. Measured on
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
  // Deliberately small, and this is a real trade-off rather than an oversight.
  //
  // Coarse noise resists a blur attack far better: per-pixel noise is white, so
  // it sits above the frequencies strokes occupy and a radius-4 blur lifts the
  // leak from 0.13 to 0.46, while a block at the stroke width leaves no radius
  // that helps. Purely on masking, block >= stroke width wins.
  //
  // But coarse noise is low spatial frequency, and that is exactly where the
  // eye's temporal contrast sensitivity peaks. At 30Hz. Any 60Hz display, two
  // planes. Big blocks strobe instead of fusing and the text is unreadable.
  // Fine noise sits near the eye's spatial limit and fuses.
  //
  // 6. Block size is the single biggest lever against a blur, because a block
  // at or above the stroke width leaves the attacker no radius that helps, and
  // at the sizes text is actually rendered a 6px block is close to that.
  //
  // The cost is fusion, not legibility: coarse noise sits at a low spatial
  // frequency, which is where the eye's temporal sensitivity peaks, so it
  // shimmers more at 30Hz than a fine block does. Use strength="weak" if a
  // 60Hz display is the priority.
  //
  // Legibility still wins over going coarser: raise noise-scale toward the full
  // stroke width only if you know the display runs at 120Hz+.
  noiseScale: 6,
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
 * in the console retrieves it. Nothing running in a browser can prevent that.
 * The client belongs to the user. Treat this as raising the cost of a casual
 * look, in the same spirit as the flicker itself.
 *
 *   <nocap-secret hold auto-hide="6"></nocap-secret>
 *   el.secret = '4471-0092-8834';
 *
 * Prefer the `.secret` property. Putting the text in the element's markup works
 *. It is read once and then erased from the DOM. But it was in the HTML source
 * on the way there, which defeats the point.
 */
/**
 * Extending HTMLElement directly makes this module unimportable outside a
 * browser, which breaks `import 'nocap'` under SSR. Next, Astro and Remix all
 * evaluate module top-level on the server. Falling back to a plain base keeps
 * the barrel importable there. CustomElements.define is already guarded below,
 * so nothing registers and nothing renders until it reaches a browser.
 */
const ElementBase = typeof HTMLElement === 'function' ? HTMLElement : class {};

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
export function resolveOptions(attrs = {}, dpr = 1) {
  const preset = STRENGTHS[attrs.strength] ?? {};
  const base = { ...TEXT_DEFAULTS, ...preset };
  // Block size follows the stroke, which follows devicePixelRatio.
  base.noiseScale = Math.max(base.noiseScale, Math.round(base.noiseScale * dpr));

  const num = (name, fallback) => (name in attrs ? +attrs[name] : fallback);
  return {
    ...base,
    amplitude: num('amplitude', base.amplitude),
    frames: num('frames', base.frames),
    contrast: num('contrast', base.contrast),
    noiseScale: num('noise-scale', base.noiseScale),
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
    'noise-scale',
    'chroma',
    'hardness',
    'gamma',
    'color',
    'background',
    'adaptive',
    'scramble',
    'fake',
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
      canvas { display: block; image-rendering: pixelated; border-radius: 4px; }
    </style>`;

    this.#canvas = document.createElement('canvas');
    root.append(this.#canvas);

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
    const font = `600 ${Math.round(this.#flicker.canvas.height * 0.46)}px ui-monospace, monospace`;
    const fakeMode = this.getAttribute('fake');
    // Scramble empties #secret and keeps the glyphs in #chars, so fake mode has
    // to reassemble to know what shape to imitate. Guarding on #secret alone
    // meant enabling both silently dropped the decoy. The mode looked on and
    // did nothing.
    const plain = this.#secret || this.#reassemble();
    if (fakeMode && fakeMode !== 'off' && plain) {
      await this.#drawFake(font, color, background, fakeMode, plain);
    } else if (this.#chars) {
      await this.#drawScrambled(font, color, background);
    } else {
      await this.#flicker.setText(this.#secret, { font, color, background });
    }
    this.#warnPalette();
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
   * defeats this component outright. Sees single characters, in shuffled order,
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
  async #drawScrambled(font, color, background) {
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
    // How far the decoy widens the pair, in code levels, before feasibility.
    const decoyPush = 110;

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

    /**
     * The largest half that can still hit a given target, per target value.
     *
     * This is what makes the re-solve work. A pair at ±half can only reach light
     * means between (toLight(2·half) + toLight(0)) / 2 and
     * (toLight(255) + toLight(255 - 2·half)) / 2, and that band narrows as half
     * grows. A FIXED budget therefore becomes infeasible for dark pixels. The
     * search clamps and the shortfall surfaces as a lift in the perceived value.
     * Measured at a constant 110: 53 levels of lift, worse than no re-solve.
     *
     * Capping half per pixel keeps the decoy at uniform contrast wherever
     * physics allows and backs off only where it must. 256 entries, solved once.
     */
    const feasibleHalf = (() => {
      const table = new Float64Array(256);
      for (let v = 0; v < 256; v++) {
        const want = toLight(v);
        let lo = 0;
        let hi = 127;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          const min = (toLight(2 * mid) + toLight(0)) / 2;
          const max = (toLight(255) + toLight(255 - 2 * mid)) / 2;
          if (want >= min && want <= max) lo = mid;
          else hi = mid;
        }
        table[v] = lo;
      }
      return table;
    })();
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

    // The real value, split normally: its mean is what the eye resolves.
    const base = splitFrames(paint((ctx) => {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(plain, w / 2, h / 2);
    }), { ...this.#options(), decoy: null });

    const decoys = [];
    const sets = [];
    const small = font.replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${Math.round(+n * 0.55)}px`);
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
          const want = (toLight(b0) + toLight(b1)) / 2;
          const half = Math.min(
            Math.abs(b0 - b1) / 2 + amount * decoyPush,
            feasibleHalf[Math.round(Math.max(0, Math.min(255, toCode(want))))]
          );
          const centre = centreFor(want, half);
          const up = b0 >= b1;
          set[0].data[i + c] = centre + (up ? half : -half);
          set[1].data[i + c] = centre + (up ? -half : half);
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
      // Hardcoding 5 meant that on a 2x display. Which is most high-refresh
      // hardware. The default was already 6 and this LOWERED it, running the
      // logic backwards on exactly the machines the branch exists for.
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

  #options() {
    const attrs = {};
    for (const name of NocapSecret.observedAttributes) {
      if (this.hasAttribute(name)) attrs[name] = this.getAttribute(name);
    }
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    return resolveOptions(attrs, dpr);
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
    return {
      // Defaults must be maskable, not merely handsome. #e8e8f0 on #14141a is
      // the obvious dark-UI pairing and it leaks 0.951. A screenshot reads it
      // outright. This pair scores a masking ratio of 1.42 and leaks 0.180.
      // Anything you override with should be checked against checkPalette().
      color: this.getAttribute('color') ?? '#9ea6b4',
      background: this.getAttribute('background') ?? '#6b7280',
    };
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
