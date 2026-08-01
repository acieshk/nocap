import { Flicker } from './flicker.js';
import { leakScore } from './splitter.js';

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
  amplitude: 110,
  contrast: 2.2,
  hardness: 1,
  chroma: 1,
  noiseScale: 1,
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
export class NocapSecret extends HTMLElement {
  static observedAttributes = ['amplitude', 'frames', 'contrast', 'width', 'height', 'placeholder'];

  #secret = '';
  #flicker = null;
  #canvas = null;
  #cover = null;
  #hideTimer = 0;
  #revealed = false;

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
               background: #14141a; border-radius: 4px; cursor: pointer;
               font: 500 13px/1 ui-sans-serif, system-ui, sans-serif; color: #71717f;
               letter-spacing: .04em; }
      .cover[hidden] { display: none; }
    </style>`;

    this.#canvas = document.createElement('canvas');
    this.#cover = document.createElement('div');
    this.#cover.className = 'cover';
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
    this.#secret = String(value ?? '');
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
    if (!this.#flicker || !this.#secret) return;
    clearTimeout(this.#hideTimer);

    await this.#flicker.setText(this.#secret, {
      font: `600 ${Math.round(this.#flicker.canvas.height * 0.46)}px ui-monospace, monospace`,
      background: '#14141a',
    });
    this.#cover.hidden = true;
    this.#revealed = true;
    this.#flicker.start();

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
    ctx.fillStyle = '#14141a';
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
    };
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('nocap-secret')) {
  customElements.define('nocap-secret', NocapSecret);
}
