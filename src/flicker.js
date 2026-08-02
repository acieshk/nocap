import { splitFrames, planeRange } from './splitter.js';

const DEFAULTS = {
  mode: 'amplitude',
  frames: 2,
  amplitude: 64,
  contrast: 1,
  hardness: 1,
  chroma: 1,
  noiseScale: 1,
  fill: 128,
  // Vsyncs each plane is held for. 1 is what you want. Raising it simulates a
  // slower display so you can see what the shimmer looks like at lower rates.
  planeHold: 1,
  // Noise is precomputed into a bank of ready-to-blit ImageBitmaps. Generating
  // it per cycle would cost ~10ms/megapixel on the main thread, which vsync
  // does not have. Cycling a bank makes each presented frame a single
  // drawImage. Memory ~= w * h * 4 * frames * bankSize bytes.
  bankSize: 6,
  warnBelowHz: 100,
  // Leave false in production: a GPU-backed canvas blits bitmaps faster. Set
  // true only if you intend to getImageData off the live canvas.
  willReadFrequently: false,
};

/**
 * Drives the alternation on a canvas, one plane per vsync.
 *
 * Frequency is capped by the display: on 60Hz a 2-plane cycle alternates at
 * 30Hz and visibly shimmers. 120Hz+ is where this stops being unpleasant.
 */
export class Flicker {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Partial<typeof DEFAULTS>} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.opts = { ...DEFAULTS, ...options };
    this.ctx = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: this.opts.willReadFrequently,
    });
    this.ctx.imageSmoothingEnabled = false;

    this.stats = { presented: 0, dropped: 0, refreshHz: 0, cycleHz: 0 };

    this._src = null;
    this._decoy = null;
    this._bank = [];
    this._planes = [];
    this._gen = 0;
    this._bankIdx = 0;
    this._phase = 0;
    this._held = 0;
    this._raf = 0;
    this._last = 0;
    this._interval = 0;
    this._warned = false;
    this._tick = this._tick.bind(this);
  }

  /** Size the canvas in CSS pixels, backing it with exact device pixels. */
  resize(cssWidth, cssHeight, dpr = window.devicePixelRatio || 1) {
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.imageSmoothingEnabled = false;
    return this;
  }

  /** Draw any canvas-drawable source, contained within the canvas. */
  async setSource(drawable, opts = {}) {
    this._src = this._rasterize(drawable, opts);
    await this._rebuild();
    return this;
  }

  /** The second image used as the modulator in 'decoy' mode. */
  async setDecoy(drawable, opts = {}) {
    this._decoy = drawable ? this._rasterize(drawable, opts) : null;
    if (this._src) await this._rebuild();
    return this;
  }

  /** Render text to the canvas size, then use it as the source. */
  async setText(text, opts = {}) {
    const {
      font = `bold ${Math.round(this.canvas.height / 6)}px system-ui, sans-serif`,
      color = '#fff',
      background = '#000',
      lineHeight = 1.25,
    } = opts;

    const { width: w, height: h } = this.canvas;
    const { canvas: off, ctx } = scratch(w, h, background);
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lines = wrap(ctx, text, w * 0.9);
    const size = parseFloat(font) || h / 6;
    const step = size * lineHeight;
    const top = h / 2 - ((lines.length - 1) * step) / 2;
    lines.forEach((line, i) => ctx.fillText(line, w / 2, top + i * step));

    void off;
    this._src = ctx.getImageData(0, 0, w, h);
    await this._rebuild();
    return this;
  }

  /**
   * Present planes built elsewhere, bypassing splitFrames.
   *
   * Needed by decoy modes, where the planes are not a noise split at all: one
   * carries a plausible wrong value and the other carries whatever makes the
   * pair average back to the truth.
   */
  async setPlanes(planes) {
    return this.setBank([planes]);
  }

  /**
   * Present a whole bank of prebuilt cycles.
   *
   * Decoy modes need this: each cycle carries a different fake value, so the
   * bank is the rotation the viewer never resolves and a capture freezes one of.
   */
  async setBank(sets) {
    const gen = ++this._gen;
    const built = await Promise.all(sets.map((set) => Promise.all(
      set.map((pl) => createImageBitmap(new ImageData(pl.data, pl.width, pl.height)))
    )));
    if (gen !== this._gen) {
      for (const set of built) for (const b of set) b.close?.();
      return this;
    }
    this._closeBank();
    this._bank = built;
    this._planes = sets[0];
    this._bankIdx = 0;
    this._phase = 0;
    this._held = 0;
    return this;
  }

  /** Change split options and regenerate the bank. */
  async configure(patch) {
    Object.assign(this.opts, patch);
    if (this._src) await this._rebuild();
    return this;
  }

  start() {
    if (this._raf) return this;
    this._last = 0;
    this._raf = requestAnimationFrame(this._tick);
    return this;
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    return this;
  }

  get running() {
    return this._raf !== 0;
  }

  /**
   * The current planes as plain image data — plane k is exactly what a single
   * screenshot lands on. Use with averageFrames() to get the ideal perceived
   * image without waiting on the display.
   */
  get planes() {
    return this._planes;
  }

  /** The [lo, hi] band the source was compressed into, for expandRange(). */
  get range() {
    return planeRange(this.opts);
  }

  /** Stop and display one plane. */
  showPlane(k = 0) {
    this.stop();
    const set = this._bank[this._bankIdx];
    if (set) this.ctx.drawImage(set[k % set.length], 0, 0);
    return this;
  }

  destroy() {
    this.stop();
    this._closeBank();
    this._src = this._decoy = null;
  }

  /* ---------------------------------------------------------------------- */

  _rasterize(drawable, { background = '#000' } = {}) {
    const { width: w, height: h } = this.canvas;
    const { ctx } = scratch(w, h, background);
    const sw = drawable.width || drawable.videoWidth;
    const sh = drawable.height || drawable.videoHeight;
    const s = Math.min(w / sw, h / sh);
    const dw = sw * s;
    const dh = sh * s;
    ctx.drawImage(drawable, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return ctx.getImageData(0, 0, w, h);
  }

  _closeBank() {
    for (const set of this._bank) for (const bmp of set) bmp.close?.();
    this._bank = [];
  }

  async _rebuild() {
    const gen = ++this._gen;
    const cfg = { ...this.opts, decoy: this._decoy };
    if (cfg.mode === 'decoy' && !this._decoy) cfg.mode = 'amplitude';

    const bank = [];
    let first = null;
    for (let b = 0; b < this.opts.bankSize; b++) {
      const planes = splitFrames(this._src, cfg);
      if (!first) first = planes;
      const bmps = await Promise.all(
        planes.map((p) => createImageBitmap(new ImageData(p.data, p.width, p.height)))
      );
      // A newer rebuild started while we were awaiting; drop this one. Close
      // everything built so far, not just this iteration — closing only the
      // current set stranded every earlier cycle's bitmaps, and a fast slider
      // drag supersedes several rebuilds a second.
      if (gen !== this._gen) {
        for (const bmp of bmps) bmp.close?.();
        for (const set of bank) for (const bmp of set) bmp.close?.();
        return;
      }
      bank.push(bmps);
    }

    this._closeBank();
    this._bank = bank;
    this._planes = first;
    this._bankIdx = 0;
    this._phase = 0;
    this._held = 0;
  }

  _tick(t) {
    this._raf = requestAnimationFrame(this._tick);
    if (!this._bank.length) return;

    if (this._last) {
      const dt = t - this._last;
      if (this._interval && dt > this._interval * 1.5) this.stats.dropped++;
      // Rolling estimate; clamp so a tab stall doesn't poison it.
      const sample = Math.min(dt, 100);
      this._interval = this._interval ? this._interval * 0.9 + sample * 0.1 : sample;
      this.stats.refreshHz = Math.round(1000 / this._interval);
      // Use the real plane count, not opts.frames — 'channels' mode forces 3.
      const perCycle = (this._planes.length || this.opts.frames) * this.opts.planeHold;
      this.stats.cycleHz = Math.round(this.stats.refreshHz / perCycle);
      this._maybeWarn();
    }
    this._last = t;

    const set = this._bank[this._bankIdx];
    this.ctx.drawImage(set[this._phase], 0, 0);
    this.stats.presented++;

    if (++this._held < this.opts.planeHold) return;
    this._held = 0;
    if (++this._phase >= set.length) {
      this._phase = 0;
      this._bankIdx = (this._bankIdx + 1) % this._bank.length;
    }
  }

  _maybeWarn() {
    if (this._warned || this.stats.presented < 30) return;
    if (this.stats.refreshHz >= this.opts.warnBelowHz) return;
    this._warned = true;
    console.warn(
      `[flicker] display is ~${this.stats.refreshHz}Hz, so the cycle runs at ` +
        `${this.stats.cycleHz}Hz. Below ~60Hz cycle rate the shimmer is clearly ` +
        `visible and uncomfortable for some viewers. Consider not engaging here.`
    );
  }
}

function scratch(w, h, background) {
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

function wrap(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}
