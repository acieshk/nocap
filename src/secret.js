import { Flicker } from './flicker.js';
import { leakScore, planeRange } from './splitter.js';
import { checkPalette, toLight, toCode } from './palette.js';
import { fakeLike } from './fake.js';

/**
 * Text-tuned defaults.
 *
 * Text tolerates far more amplitude than a photograph does: it is essentially
 * two-tone, so crushing it into [110, 145] costs almost nothing legibility-wise
 * while a painting would turn to mush. Measured single-plane leak at these
 * settings is near zero, where amplitude 64 leaves ~0.39.
 */
const TEXT_DEFAULTS = {
  mode: 'amplitude',
  frames: 2,
  // 96, not 110. At 110 the band is [110, 145] and the perceived image has only
  // 35 levels of contrast — legible in a still, but far too washed out to read
  // through a live 30Hz alternation. 96 gives 63 levels for a modest leak cost.
  amplitude: 96,
  // Split in light, not in code values. This is what makes `color` and
  // `background` mean what they say: the planes are offset in linear light, so
  // the mean the eye integrates is exactly the authored colour. Averaging in
  // sRGB instead reads far too bright — #ff0000 arrives as #be8c8c.
  linearLight: true,
  gamma: 2.4,
  // No band compression under linearLight, so no pre-emphasis to claw back.
  contrast: 1,
  // Noise magnitude spread. 1 slams every pixel to +/-amplitude, which is the
  // strongest mask but reads as harsh confetti. 0.5 clusters deviations near the
  // background — same measured leak as chroma:1/hardness:1 used to give, about a
  // quarter less visually loud.
  hardness: 0.5,
  // Grey noise, not per-channel. This is a free win rather than a compromise:
  // sharing one sign across R/G/B puts the whole noise budget into luminance,
  // which is what leakScore and the eye both key on for text. Measured 0.262
  // denoised leak versus 0.346 for independent per-channel noise, at identical
  // visual loudness — and it looks like grey static instead of rainbow static.
  chroma: 0,
  // Deliberately small, and this is a real trade-off rather than an oversight.
  //
  // Coarse noise resists a blur attack far better: per-pixel noise is white, so
  // it sits above the frequencies strokes occupy and a radius-4 blur lifts the
  // leak from 0.13 to 0.46, while a block at the stroke width leaves no radius
  // that helps. Purely on masking, block >= stroke width wins.
  //
  // But coarse noise is low spatial frequency, and that is exactly where the
  // eye's temporal contrast sensitivity peaks. At 30Hz — any 60Hz display, two
  // planes — big blocks strobe instead of fusing and the text is unreadable.
  // Fine noise sits near the eye's spatial limit and fuses.
  //
  // Legibility wins by default; raise noise-scale toward the stroke width only
  // if you know the display runs at 120Hz+.
  noiseScale: 3,
  bankSize: 6,
};

/**
 * <nocap-secret> — show a short secret as flickered text.
 *
 * The plaintext is rendered straight to a canvas and never enters the DOM. That
 * is worth more than it sounds: View Source never had it (it is set from JS),
 * and unlike JS-injected text nodes it is also absent from the DOM inspector,
 * the accessibility tree, Select-All + Copy, Reader mode, "Save Page As", and
 * every text-scraping extension. The inspector shows a <canvas> and nothing else.
 *
 * What it does NOT do: hide from anyone with DevTools and intent. The string is
 * a live JS value, so a breakpoint, a heap snapshot, or one canvas.toDataURL()
 * in the console retrieves it. Nothing running in a browser can prevent that —
 * the client belongs to the user. Treat this as raising the cost of a casual
 * look, in the same spirit as the flicker itself.
 *
 *   <nocap-secret hold auto-hide="6"></nocap-secret>
 *   el.secret = '4471-0092-8834';
 *
 * Prefer the `.secret` property. Putting the text in the element's markup works
 * — it is read once and then erased from the DOM — but it was in the HTML source
 * on the way there, which defeats the point.
 */
/**
 * Extending HTMLElement directly makes this module unimportable outside a
 * browser, which breaks `import 'nocap'` under SSR — Next, Astro and Remix all
 * evaluate module top-level on the server. Falling back to a plain base keeps
 * the barrel importable there; customElements.define is already guarded below,
 * so nothing registers and nothing renders until it reaches a browser.
 */
const ElementBase = typeof HTMLElement === 'function' ? HTMLElement : class {};

export class NocapSecret extends ElementBase {
  static observedAttributes = [
    'amplitude',
    'frames',
    'contrast',
    'noise-scale',
    'chroma',
    'hardness',
    'gamma',
    'color',
    'background',
    'adaptive',
    'scramble',
    'fake',
    'fake-placement',
    'width',
    'height',
    'placeholder',
  ];

  #secret = '';
  #chars = null;   // scramble mode: glyphs in shuffled order
  #slots = null;   // where each of #chars belongs on screen
  #flicker = null;
  #canvas = null;
  #cover = null;
  #hideTimer = 0;
  #revealed = false;
  #paletteWarned = false;
  #lastDecoy = null;
  #fakeWarned = false;
  #adapted = false;
  #gapWarned = false;

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
      .cover { position: absolute; inset: 0; display: grid; place-items: center;
               background: var(--cover, #14141a); border-radius: 4px; cursor: pointer;
               font: 500 13px/1 ui-sans-serif, system-ui, sans-serif; color: #71717f;
               letter-spacing: .04em; }
      .cover[hidden] { display: none; }
    </style>`;

    this.#canvas = document.createElement('canvas');
    this.#cover = document.createElement('div');
    this.#cover.className = 'cover';
    this.#cover.style.setProperty('--cover', this.#perceived(this.#palette.background));
    this.#cover.textContent = this.getAttribute('placeholder') ?? 'hold to reveal';
    root.append(this.#canvas, this.#cover);

    this.#flicker = new Flicker(this.#canvas, this.#options()).resize(
      +(this.getAttribute('width') ?? 260),
      +(this.getAttribute('height') ?? 56)
    );

    if (this.hasAttribute('hold')) {
      this.addEventListener('pointerdown', this.#onHold);
      this.addEventListener('pointerup', this.hide);
      this.addEventListener('pointerleave', this.hide);
      this.addEventListener('pointercancel', this.hide);
    } else {
      this.addEventListener('click', this.reveal);
    }

    // A tab switch or a window blur is the moment a screen share usually starts.
    document.addEventListener('visibilitychange', this.#onVisibility);
    window.addEventListener('blur', this.hide);
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this.#onVisibility);
    window.removeEventListener('blur', this.hide);
    clearTimeout(this.#hideTimer);
    this.#flicker?.destroy();
    this.#flicker = null;
    this.#canvas = null;
  }

  attributeChangedCallback() {
    if (!this.#flicker) return;
    this.#flicker.configure(this.#options());
    if (this.#revealed) this.reveal();
  }

  /** Write-only by design: reading it back would put the secret in reach again. */
  set secret(value) {
    const str = String(value ?? '');
    if (this.hasAttribute('scramble')) {
      // Keep the glyphs, drop the arrangement. Nothing in this object is ever
      // the plaintext in order, so a heap snapshot search for it finds nothing.
      const pairs = [...str].map((ch, i) => [ch, i]);
      for (let i = pairs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
      }
      this.#chars = pairs.map((p) => p[0]);
      this.#slots = pairs.map((p) => p[1]);
      this.#secret = '';
    } else {
      this.#secret = str;
      this.#chars = this.#slots = null;
    }
    if (this.#revealed) this.reveal();
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

  reveal = async () => {
    if (!this.#flicker || !(this.#secret || this.#chars?.length)) return;
    clearTimeout(this.#hideTimer);

    const { color, background } = this.#palette;
    const font = `600 ${Math.round(this.#flicker.canvas.height * 0.46)}px ui-monospace, monospace`;
    const fakeMode = this.getAttribute('fake');
    if (fakeMode && fakeMode !== 'off' && this.#secret) {
      await this.#drawFake(font, color, background, fakeMode);
    } else if (this.#chars) {
      await this.#drawScrambled(font, color, background);
    } else {
      await this.#flicker.setText(this.#secret, { font, color, background });
    }
    this.#warnPalette();
    this.#cover.hidden = true;
    this.#revealed = true;
    this.#flicker.start();

    this.#adaptBlock();
    const seconds = +(this.getAttribute('auto-hide') ?? 0);
    if (seconds > 0) this.#hideTimer = setTimeout(this.hide, seconds * 1000);
    this.dispatchEvent(new CustomEvent('reveal'));
  };

  hide = () => {
    if (!this.#flicker || !this.#revealed) return;
    clearTimeout(this.#hideTimer);
    this.#flicker.stop();
    // Overwrite the canvas — a stopped Flicker leaves the last plane on screen.
    const { ctx, canvas } = this.#flicker;
    ctx.fillStyle = this.#perceived(this.#palette.background);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.#cover.hidden = false;
    this.#revealed = false;
    this.dispatchEvent(new CustomEvent('hide'));
  };

  /** Measured single-plane leak for the current settings, for tuning. */
  measureLeak() {
    const planes = this.#flicker?.planes ?? [];
    if (!planes.length) return null;
    const mean = planes[0];
    return Math.max(...planes.map((p) => leakScore(p, mean)));
  }

  /**
   * Draw scrambled glyphs back into their real positions.
   *
   * Each character is rendered alone into a scratch canvas at a fixed point and
   * then blitted to its slot. That split matters: a hook on
   * `CanvasRenderingContext2D.prototype.fillText` — the one-liner that otherwise
   * defeats this component outright — sees single characters, in shuffled order,
   * every one drawn at the same coordinates. It recovers the multiset of
   * characters and the length, not the arrangement. Position lives in the
   * drawImage calls instead, so an attacker now has to hook two APIs and
   * correlate them rather than dump one log.
   *
   * Be clear about the level: this is obfuscation, not encryption. #chars and
   * #slots are both live fields on the element, so anyone who reads both
   * reconstructs the value immediately. It raises the cost of a casual console
   * poke; it does not withstand someone who has decided to extract the value.
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
   * Two placements, and the choice is a real trade rather than a preference.
   *
   * 'gaps' (default) puts decoy glyphs only where the target left background,
   * so the real glyphs are untouched and stay readable. At 30Hz the alternation
   * does not fully fuse, and overlaying a decoy on the real glyphs makes the
   * value genuinely hard to read. The cost is that the real value is present in
   * every frame — the decoy adds ambiguity about which digits are real, it does
   * not replace them.
   *
   * 'overlay' replaces the glyphs, so a capture can show a wholly wrong value.
   * Stronger, and harder to read.
   *
   * Noise announces failure and invites another screenshot. A value in the right
   * shape does not. The cost is that only ONE of the two planes reads cleanly —
   * offsets must sum to zero, so if plane 0 is the decoy then plane 1 is
   * 2*target - decoy and looks like a ghosted negative. A single capture has
   * roughly even odds of landing on either.
   *
   * Everything happens in light, so the mean is the authored value exactly.
   * Where a pixel lacks the headroom to reach the decoy outright, it goes as far
   * as it can: clipping would break the zero-sum property and shift the colour.
   */
  async #drawFake(font, color, background, mode) {
    const decoy = fakeLike(this.#secret, { mode: mode === 'auto' ? 'auto' : mode });
    this.#lastDecoy = decoy;

    // Swapping a glyph means travelling the whole text-to-background distance,
    // so fake mode needs more headroom than noise does. Without it the pixels
    // only move part way and the REAL value ghosts through both frames — a
    // silent failure that looks like it is working.
    const { ratio } = checkPalette(this.#palette);
    if (ratio < 1 && !this.#fakeWarned) {
      this.#fakeWarned = true;
      console.warn(
        `[nocap-secret] fake mode needs a masking ratio of 1.0+; this palette is ` +
          `${ratio.toFixed(2)}, so the real value will show through both frames. ` +
          `Move both colours toward the mid-tones.`
      );
    }

    const measureAdvance = (f) => {
      const cv = makeCanvas(8, 8);
      const ctx = cv.getContext('2d');
      ctx.font = f;
      return ctx.measureText('0').width;
    };

    const render = (text, dx = 0) => {
      const { width: w, height: h } = this.#flicker.canvas;
      const cv = makeCanvas(w, h);
      const ctx = cv.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2 + dx, h / 2);
      return ctx.getImageData(0, 0, w, h);
    };

    const T = render(this.#secret);
    // Offset by half an advance so decoy glyphs land between the real ones
    // rather than on top of them.
    const advance = measureAdvance(font);
    const F = render(decoy, advance / 2);

    const a = new Uint8ClampedArray(T.data.length);
    const b = new Uint8ClampedArray(T.data.length);
    const gapsOnly = (this.getAttribute('fake-placement') ?? 'gaps') === 'gaps';
    const bgLight = toLight(render('', 0).data[0]);

    let placed = 0;
    for (let i = 0; i < T.data.length; i += 4) {
      // A pixel is "empty" when the target left it at the background value.
      const empty = Math.abs(toLight(T.data[i]) - bgLight) < 0.004;
      const allow = !gapsOnly || empty;
      for (let c = 0; c < 3; c++) {
        const lt = toLight(T.data[i + c]);
        const raw = toLight(F.data[i + c]) - lt;
        const d = allow ? raw : 0;
        const reach = d === 0 ? 0 : Math.min(1, Math.min(lt, 1 - lt) / Math.abs(d));
        a[i + c] = toCode(lt + reach * d);
        b[i + c] = toCode(lt - reach * d);
        if (c === 0 && reach > 0.1) placed++;
      }
      a[i + 3] = b[i + 3] = 255;
    }

    // Nowhere to put it: showing the target unchanged is honest, and better
    // than smearing a decoy over the glyphs and making the value unreadable.
    if (gapsOnly && placed < T.width) {
      this.#lastDecoy = null;
      if (!this.#gapWarned) {
        this.#gapWarned = true;
        console.warn(
          '[nocap-secret] fake: no empty space to place a decoy in, so none was ' +
            'inserted. Use a shorter value, a wider element, or ' +
            'fake-placement="overlay" to replace glyphs instead (harder to read).'
        );
      }
      return this.#flicker.setText(this.#secret, { font, color, background });
    }

    await this.#flicker.setPlanes([
      { width: T.width, height: T.height, data: a },
      { width: T.width, height: T.height, data: b },
    ]);
  }

  /** Current planes, for demos that show what a capture lands on. */
  get planes() {
    return this.#flicker?.planes ?? [];
  }

  /** The decoy shown last, for demos. Never exposes the real value. */
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
      this.#flicker.configure({ noiseScale: 5 }).then(() => {
        if (this.#revealed) this.reveal();
      });
    }, 800);
  }

  #onHold = (e) => {
    e.preventDefault();
    this.reveal();
  };

  #onVisibility = () => {
    if (document.visibilityState !== 'visible') this.hide();
  };

  #options() {
    const num = (name, fallback) =>
      this.hasAttribute(name) ? +this.getAttribute(name) : fallback;
    return {
      ...TEXT_DEFAULTS,
      amplitude: num('amplitude', TEXT_DEFAULTS.amplitude),
      frames: num('frames', TEXT_DEFAULTS.frames),
      contrast: num('contrast', TEXT_DEFAULTS.contrast),
      noiseScale: num('noise-scale', TEXT_DEFAULTS.noiseScale),
      chroma: num('chroma', TEXT_DEFAULTS.chroma),
      gamma: num('gamma', TEXT_DEFAULTS.gamma),
      hardness: num('hardness', TEXT_DEFAULTS.hardness),
      adaptive: this.hasAttribute('adaptive'),
    };
  }

  /**
   * Authored colours. Under the default (non-adaptive) split these are pulled
   * into [amplitude, 255-amplitude], so what you see is a hue-preserved, lower
   * contrast version — tinted rather than grey, but never the literal values.
   * `adaptive` reproduces them exactly and caps amplitude to their headroom
   * instead; see maxAmplitudeFor().
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
      // the obvious dark-UI pairing and it leaks 0.951 — a screenshot reads it
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
