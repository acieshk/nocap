/**
 * nocap. Anti-screenshot, anti-AI display for secrets on screen.
 *
 * Hand-written rather than generated: the library is plain JS, and the whole
 * surface is a handful of functions over one struct.
 */

/** Structurally an ImageData, so browser ImageData is assignable. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type SplitMode = 'amplitude' | 'aperture' | 'interleave' | 'decoy';

export interface SplitOptions {
  /**
   * `amplitude` degrades every pixel and needs colour headroom. `aperture`
   * shows one slice per frame and needs none, so it works at pure white.
   * `interleave` exists to show why splitting WHERE pixels are does not work.
   */
  mode?: SplitMode;
  /** Planes per cycle. 2 is almost always right. */
  frames?: number;
  /** 0–127. Fraction of the headroom the colours allow. */
  amplitude?: number;
  /** Pre-emphasis. Not needed under `linearLight`, which does not compress. */
  contrast?: number;
  /** 1 = all noise at full amplitude (best mask). 0 = uniform magnitude. */
  hardness?: number;
  /** 0 = one draw shared across RGB (grey, masks better). 1 = per channel. */
  chroma?: number;
  /** Noise block in px. Derived as 2x the stroke unless set. Strobes below 120Hz. */
  noiseScale?: number;
  /** `interleave` / `aperture`: value shown by the non-carrying planes. */
  fill?: number;
  /** `decoy`: the second image, same size. */
  decoy?: Pixels | null;
  /** Average in light, not in code values, so authored colours are exact. */
  linearLight?: boolean;
  /** Display EOTF. 2.4 selects the real sRGB curve. Else a pure power. */
  gamma?: number;
  rng?: () => number;
}

export function splitFrames(src: Pixels, opts?: SplitOptions): Pixels[];
export function averageFrames(caps: Pixels[]): Pixels;
export function expandRange(img: Pixels, range: { lo: number; hi: number }): Pixels;
export function planeRange(opts?: SplitOptions): { lo: number; hi: number };

/** |Pearson r| between plane luma and source luma. A legibility proxy. */
export function leakScore(plane: Pixels, src: Pixels): number;
/** Throws on a size mismatch. */
export function boxBlur(img: Pixels, radius: number): Pixels;
/** Worst leak an attacker reaches by blurring at any radius up to maxRadius. */
export function denoisedLeak(
  plane: Pixels,
  src: Pixels,
  maxRadius?: number
): { leak: number; radius: number };
export function maxAmplitudeFor(colors: Array<string | [number, number, number]>): number;

/* ------------------------------------------------------------- palette -- */

export type Grade = 'good' | 'fair' | 'weak';

export interface PaletteCheck {
  /** min(codeSwing(text), codeSwing(background)) / |text - background|. */
  ratio: number;
  /** `good` means "the best this technique achieves", not "safe". */
  grade: Grade;
  textSwing: number;
  backgroundSwing: number;
  separation: number;
  warnings: string[];
}

export function checkPalette(design: {
  color: string;
  background: string;
  gamma?: number;
}): PaletteCheck;

export function codeSwing(color: string, gamma?: number): number;
/** WCAG-style contrast, so the cost of fitting is a number. */
export function contrastRatio(a: string, b: string, gamma?: number): number;

/**
 * Move a palette that cannot carry noise into one that can, keeping the hue and
 * the light-or-dark character and shrinking only the separation.
 *
 * White has a swing of 0, so white on black masks nothing. That was never a
 * property of the colour: it followed from the split insisting the frames
 * average to the authored hex. Give up the exact hex and it masks.
 */
export function fitToBand(design: {
  color: string;
  background: string;
  minRatio?: number;
  gamma?: number;
}): { color: string; background: string; ratio: number; moved: boolean; contrast: number };
export function toLight(v: number, gamma?: number): number;
export function toCode(x: number, gamma?: number): number;
export function luma(rgb: number[]): number;
export function toRgb(color: string | number[]): number[];
export function toHex(rgb: number[]): string;
export function placeInBand(
  color: string,
  targetLuma: number,
  bounds: { lo: number; hi: number }
): number[];

export interface SuggestedConfig {
  amplitude: number;
  noiseScale: number;
  chroma: number;
  hardness: number;
  linearLight: boolean;
  /** What to author. Under linear light these are also what you see. */
  color: string;
  background: string;
  perceivedColor: string;
  perceivedBackground: string;
  band: { lo: number; hi: number };
  contrast: number;
  chromaRetained: number;
  adaptiveCeiling: number;
  masking: PaletteCheck;
  notes: string[];
}

export function suggestConfig(design: {
  background: string;
  color: string;
  amplitude?: number;
  chroma?: number;
  hardness?: number;
  fontSize?: number;
  minContrast?: number;
  linearLight?: boolean;
}): SuggestedConfig;

/* ---------------------------------------------------------------- fake -- */

export type FakeMode = 'auto' | 'number' | 'text' | 'random';

export function detectFormat(text: string): {
  kind: string;
  mask: string;
  digits: number;
  letters: number;
  separators: string[];
  describe: string;
};
export function fakeLike(
  text: string,
  opts?: { mode?: FakeMode; rng?: () => number }
): string;
export function passesLuhn(text: string): boolean;

/* ---------------------------------------------------------------- audit -- */

export interface PageAudit {
  clean: boolean;
  /** Surface names that contained the secret. */
  found: string[];
  surfaces: Record<string, boolean | 'recoverable' | 'unavailable'>;
  /** Preformatted for console.log. */
  report: string;
}

/**
 * Search the page for a secret that should not be findable.
 *
 * Takes the plaintext because it has to search for it, so the value exists in
 * one more place while the call runs. Development and tests, not production.
 */
export function auditPage(
  secret: string,
  opts?: { document?: Document; fetchSource?: boolean }
): Promise<PageAudit>;

/* -------------------------------------------------------------- runtime -- */

export interface FlickerOptions extends SplitOptions {
  /** Vsyncs each plane is held for. 1 is what you want. */
  planeHold?: number;
  bankSize?: number;
  warnBelowHz?: number;
  /** Only if you intend to getImageData off the live canvas. */
  willReadFrequently?: boolean;
}

export class Flicker {
  constructor(canvas: HTMLCanvasElement, options?: FlickerOptions);
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly opts: Required<FlickerOptions>;
  readonly stats: { presented: number; dropped: number; refreshHz: number; cycleHz: number };
  /** Plane k is exactly what a single screenshot lands on. */
  readonly planes: Pixels[];
  readonly range: { lo: number; hi: number };
  readonly running: boolean;

  resize(cssWidth: number, cssHeight: number, dpr?: number): this;
  setSource(drawable: CanvasImageSource, opts?: { background?: string }): Promise<this>;
  setDecoy(drawable: CanvasImageSource | null, opts?: { background?: string }): Promise<this>;
  setText(
    text: string,
    opts?: { font?: string; color?: string; background?: string; lineHeight?: number }
  ): Promise<this>;
  /** Present planes built elsewhere, bypassing splitFrames. */
  setPlanes(planes: Pixels[]): Promise<this>;
  /** Present a whole bank of prebuilt cycles. */
  setBank(sets: Pixels[][]): Promise<this>;
  configure(patch: Partial<FlickerOptions>): Promise<this>;
  start(): this;
  stop(): this;
  showPlane(k?: number): this;
  destroy(): void;
}

/**
 * `<nocap-secret>`. Renders as soon as it has a value.
 *
 * Hold-to-reveal, auto-hide and click-to-toggle are product decisions and are
 * deliberately absent. The value is also unreadable to assistive technology by
 * construction, so provide an accessible route to it yourself.
 */
export type Strength = 'weak' | 'medium' | 'strong';

/** Tested points on the masking/legibility curve. `medium` is the default. */
/**
 * A colour differing from `base` in chrominance only, along blue-yellow.
 * The swing is reduced near the gamut edge rather than clipped.
 */
export function isoluminantPartner(
  base: string | [number, number, number],
  swing?: number
): { color: string; swing: number; deltaLuma: number };

export const STRENGTHS: Record<Strength, {
  amplitude: number;
  /** Multiple of the stroke width. 2 is where a blur stops gaining. */
  blockRatio: number;
  hardness: number;
}>;

/** Merge defaults, a strength preset and explicit attributes. Pure, for tests. */
export function resolveOptions(
  attrs?: Record<string, string>,
  dpr?: number,
  height?: number
): SplitOptions & { adaptive: boolean };

export class NocapSecret extends HTMLElement {
  /** Write-only: reading it back would put the secret in reach again. */
  set secret(value: string);
  readonly revealed: boolean;
  readonly refreshHz: number;
  readonly planes: Pixels[];
  readonly decoys: string[];
  readonly lastDecoy: string | null;
  /** What fitToBand moved the palette to, or null if it was already maskable. */
  readonly fitted: {
    color: string; background: string; ratio: number; moved: boolean; contrast: number;
  } | null;
  /** Achieved chroma swing of the watermark, 0 if none is set. */
  readonly watermarkSwing: number;
  render(): Promise<void>;
  stop(): void;
  /** Worst plane against the mean. null before anything is rendered. */
  measureLeak(): number | null;
}

declare global {
  interface HTMLElementTagNameMap {
    'nocap-secret': NocapSecret;
  }
}
