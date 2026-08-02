/**
 * Frame splitting: turn one image into N planes that alternate at refresh rate.
 * Each plane is degraded; their *mean* is the content, and your visual system
 * computes that mean.
 *
 * No DOM dependencies — takes and returns plain {width, height, data} objects
 * (structurally an ImageData) so the same code runs in Node, a worker, or a
 * native port.
 *
 * Three ways to split, all sharing one invariant: the per-pixel offsets applied
 * across the N planes sum to exactly zero, so mean(planes) === the remapped
 * source and no plane shifts local average luminance.
 *
 *   'amplitude'  Every pixel is in every plane, perturbed by zero-sum noise.
 *                Strongest mask. A single plane is confetti.
 *
 *   'interleave' Each pixel is carried by exactly ONE plane; the others show a
 *                fill. This is spatial splitting — the pixels themselves are
 *                divided across time. Note what this costs you: a single plane
 *                still holds 1/N of the true pixels at their true values, and
 *                subsampling does not destroy legibility. Stack noise on top
 *                (amplitude > 0) if you want a single plane to be unreadable.
 *
 *   'channels'   Interleave along the colour axis: plane 0 carries R, plane 1
 *                G, plane 2 B. This is field-sequential colour, the technique
 *                DLP projectors use — and it is a *display* technique, not a
 *                masking one. A single plane keeps full spatial resolution, so
 *                it is a legible monochrome version of the picture. Included so
 *                leakScore() can show you that; do not ship it.
 *
 *   'decoy'      The modulator is a second image instead of noise: plane 0 is
 *                target+decoy, plane 1 is target-decoy. Alternating two real
 *                pictures. Weakest mask — the target ghosts through both — but
 *                a single plane looks like a plausible image rather than noise.
 *
 * The through-line: a split that partitions a dimension the eye does not need
 * for recognition will leak. Recognition survives losing colour, losing most
 * pixels, blur, and quantization. It does not survive randomized *values*.
 */

/** Amplitude ceiling: above this the remapped source has no range left. */
const MAX_AMP = 127;

/**
 * The [lo, hi] band the source is compressed into for a given config.
 *
 * This is where the perceived contrast goes. Noise needs headroom on both
 * sides of every pixel or it clips, and clipping breaks the zero-sum property
 * that makes the mean come out right. The band is the price.
 */
export function planeRange(opts = {}) {
  const cfg = resolveCfg(opts);
  // Adaptive mode does not compress: it caps amplitude per pixel instead, so
  // the perceived colours come out exactly as authored.
  // Neither adaptive nor linear-light compresses: both keep authored colours
  // exact and cap the swing per pixel instead.
  if (cfg.adaptive || cfg.linearLight) return { lo: 0, hi: 255 };
  if (!carriesOnePlane(cfg.mode)) return { lo: cfg.amplitude, hi: 255 - cfg.amplitude };

  // carrier = n*v - (n-1)*fill must land in [amp, 255-amp] so stacked noise
  // still fits, and the fill itself needs the same headroom.
  const { frames: n, fill, amplitude: amp } = cfg;
  return {
    lo: ((n - 1) * fill + amp) / n,
    hi: ((n - 1) * fill + 255 - amp) / n,
  };
}

/** Modes where exactly one plane holds each pixel and the rest show `fill`. */
function carriesOnePlane(mode) {
  return mode === 'interleave' || mode === 'channels';
}

/**
 * Single source of truth for option defaulting. planeRange() and splitFrames()
 * both need the resolved fill and frame count, and when they each computed it
 * themselves they drifted — that is what let a fill of 0 clip against stacked
 * noise. Everything derived goes here.
 */
function resolveCfg(opts = {}) {
  const mode = opts.mode ?? 'amplitude';
  const amplitude = clamp(opts.amplitude ?? 64, 0, MAX_AMP);
  return {
    mode,
    // 'channels' is R/G/B by definition, so the frame count is not a free knob.
    frames: mode === 'channels' ? 3 : Math.max(2, opts.frames ?? 2),
    amplitude,
    // The fill needs the same noise headroom the carrier does. A fill of 0 with
    // amplitude 24 would clip the negative half of every offset on the
    // non-carrier planes, silently breaking the zero-sum property and darkening
    // the perceived image. Pure black fill is only available at amplitude 0.
    fill: clamp(opts.fill ?? (mode === 'channels' ? 0 : 128), amplitude, 255 - amplitude),
    contrast: opts.contrast ?? 1,
    // Keep authored colours exact by capping amplitude per pixel to its own
    // headroom, instead of compressing everything into [amp, 255-amp].
    adaptive: opts.adaptive ?? false,
    // Average in light, not in code values. A display emits light proportional
    // to (v/255)^gamma and the eye integrates light, so alternating v±d in sRGB
    // reads BRIGHTER than v — at amplitude 96 around mid-grey, 128 looks like
    // ~163. Splitting in linear light makes the perceived colour exactly the
    // authored one, which is the only way "set the perceived background" can
    // mean anything.
    // Only the modulated modes implement it. 'interleave' and 'channels' exist
    // solely so leakScore can demonstrate that they do not work (they leak 0.69
    // and 1.00), so implementing linear light for them would be wasted effort —
    // but silently ignoring the flag would be worse. Forced off, and said so.
    linearLight: carriesOnePlane(mode) ? false : opts.linearLight ?? false,
    gamma: opts.gamma ?? 2.4,
    hardness: clamp(opts.hardness ?? 1, 0, 1),
    chroma: clamp(opts.chroma ?? 1, 0, 1),
    noiseScale: Math.max(1, Math.floor(opts.noiseScale ?? 1)),
    decoy: opts.decoy ?? null,
    rng: opts.rng ?? Math.random,
  };
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} src
 * @param {object} [opts]
 * @param {'amplitude'|'interleave'|'decoy'} [opts.mode='amplitude']
 * @param {number} [opts.frames=2]      Planes per cycle. 2 is the best tradeoff.
 * @param {number} [opts.amplitude=64]  0-127. Noise amplitude ('amplitude',
 *                                      'decoy') or stacked noise ('interleave').
 * @param {number} [opts.contrast=1]    Pre-emphasis applied before the range
 *                                      compression, to claw back the washout.
 * @param {number} [opts.hardness=1]    1 = all noise at full amplitude
 *                                      (strongest mask). 0 = uniform magnitude.
 * @param {number} [opts.chroma=1]      1 = independent noise per channel.
 *                                      0 = one draw shared across R,G,B.
 * @param {number} [opts.noiseScale=1]  Noise/interleave cell size in pixels.
 * @param {number} [opts.fill=128]      'interleave': value shown by the planes
 *                                      not carrying the pixel.
 * @param {object} [opts.decoy]         'decoy': the second image, same size.
 * @param {() => number} [opts.rng=Math.random]
 * @returns {Array<{width:number,height:number,data:Uint8ClampedArray}>}
 */
export function splitFrames(src, opts = {}) {
  const cfg = resolveCfg(opts);
  const { width: w, height: h } = src;
  const planes = [];
  for (let k = 0; k < cfg.frames; k++) {
    planes.push({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  }

  // The source, contrast-boosted and compressed into the headroom band.
  const { lo, hi } = planeRange(cfg);
  const target = remap(src, cfg.contrast, lo, hi);

  if (carriesOnePlane(cfg.mode)) fillInterleave(planes, target, cfg);
  else fillModulated(planes, target, cfg);

  for (const p of planes) for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  return planes;
}

/* -------------------------------------------------------------------------- */

/**
 * 'amplitude' and 'decoy': every plane carries every pixel, offset by a
 * zero-sum modulator. The two modes differ only in where the modulator comes
 * from — random draws, or a second image.
 */
function fillModulated(planes, target, cfg) {
  const n = planes.length;
  const { width: w, height: h, data: t } = target;
  const off = new Float64Array(n);

  // Built once per split; 256 entries is far cheaper than solving per pixel.
  const lut = cfg.linearLight ? linearMeanTable(cfg.amplitude, cfg.gamma) : null;

  const draws = cfg.mode === 'decoy'
    ? decoyDraws(cfg.decoy, w, h)
    : randomDraws(w, h, cfg);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = t[p + c];
        const { phase, mag } = draws(x, y, c);

        // Normalised zero-sum offsets in [-1, 1], scaled per pixel below.
        // n === 2 -> +/-r, all energy at one magnitude: the strongest mask for
        // a given budget. n > 2 -> r*cos(2*PI*(phase + k/n)), which sums to
        // exactly zero and never leaves a plane holding a clean pixel.
        const r = cfg.hardness + (1 - cfg.hardness) * mag;
        if (n === 2) {
          off[0] = phase < 0.5 ? -r : r;
          off[1] = -off[0];
        } else {
          for (let k = 0; k < n; k++) off[k] = r * Math.cos(2 * Math.PI * (phase + k / n));
        }

        if (cfg.linearLight) {
          // Offset in light. The mean of the planes' *emitted light* is then
          // exactly the target's, so the patch reads as the authored colour
          // instead of the ~35-levels-too-bright value sRGB averaging gives.
          // Headroom is per pixel, so nothing clips and no band is needed —
          // but a near-black or near-white pixel has almost none, and carries
          // almost no noise. Mid-tones are what buy masking.
          const centre = lut[v * 2];
          const swing = lut[v * 2 + 1];
          for (let k = 0; k < n; k++) planes[k].data[p + c] = centre + off[k] * swing;
        } else {
          // A pixel at v can only carry ±min(v, 255-v) before it clips, and
          // clipping breaks the zero-sum property. Adaptive respects that
          // ceiling per pixel; otherwise the source was compressed for it.
          const amp = cfg.adaptive ? Math.min(cfg.amplitude, v, 255 - v) : cfg.amplitude;
          for (let k = 0; k < n; k++) planes[k].data[p + c] = v + off[k] * amp;
        }
      }
    }
  }
}

/**
 * 'interleave': one plane carries the pixel, the rest show `fill`.
 *
 * The carrier is boosted to n*v - (n-1)*fill so the mean still lands on v —
 * without that the image would just dim by a factor of n. Optional zero-sum
 * noise is stacked on top, because interleaving alone leaves 1/n of the true
 * pixels legible in every plane.
 */
function fillInterleave(planes, target, cfg) {
  const n = planes.length;
  const { width: w, height: h, data: t } = target;
  const scale = cfg.noiseScale;
  const nw = Math.ceil(w / scale);
  const nh = Math.ceil(h / scale);

  // Which plane carries each cell. Shared across channels — "split the pixel",
  // not "split the channel". In 'channels' mode the owner is the channel index
  // instead, which is the whole difference between the two modes.
  const byChannel = cfg.mode === 'channels';
  const owner = new Uint8Array(byChannel ? 0 : nw * nh);
  for (let i = 0; i < owner.length; i++) owner[i] = (cfg.rng() * n) | 0;

  const noise = cfg.amplitude > 0 ? randomDraws(w, h, cfg) : null;
  const off = new Float64Array(n);

  for (let y = 0; y < h; y++) {
    const ly = (y / scale) | 0;
    for (let x = 0; x < w; x++) {
      const cell = owner[ly * nw + ((x / scale) | 0)];
      const p = (y * w + x) * 4;

      for (let c = 0; c < 3; c++) {
        const own = byChannel ? c : cell;
        const carrier = n * t[p + c] - (n - 1) * cfg.fill;

        off.fill(0);
        if (noise) {
          const { phase, mag } = noise(x, y, c);
          const r = cfg.amplitude * (cfg.hardness + (1 - cfg.hardness) * mag);
          if (n === 2) {
            off[0] = phase < 0.5 ? -r : r;
            off[1] = -off[0];
          } else {
            for (let k = 0; k < n; k++) off[k] = r * Math.cos(2 * Math.PI * (phase + k / n));
          }
        }

        for (let k = 0; k < n; k++) {
          planes[k].data[p + c] = (k === own ? carrier : cfg.fill) + off[k];
        }
      }
    }
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Random modulator. Three draws per cell per channel: noise phase/sign,
 * magnitude (for `hardness`), and a selector that interpolates between shared
 * and independent channel noise.
 *
 * `chroma` interpolates by *choosing* which channel's draw to use rather than
 * by blending values, which keeps the marginal distribution exactly uniform at
 * every setting.
 */
function randomDraws(w, h, cfg) {
  const scale = cfg.noiseScale;
  const nw = Math.ceil(w / scale);
  const nh = Math.ceil(h / scale);
  const lat = new Float32Array(nw * nh * 9);
  for (let i = 0; i < lat.length; i++) lat[i] = cfg.rng();

  const chroma = cfg.chroma;
  return (x, y, c) => {
    const base = (((y / scale) | 0) * nw + ((x / scale) | 0)) * 9;
    const sc = lat[base + c * 3 + 2] < chroma ? c : 0;
    return { phase: lat[base + sc * 3], mag: lat[base + sc * 3 + 1] };
  };
}

/**
 * Decoy modulator: a second image drives the offsets. Its value maps to the
 * noise *phase*, so where the decoy is dark plane 0 goes down and plane 1 goes
 * up, and vice versa — the decoy's own contrast is what you see in each plane.
 */
function decoyDraws(decoy, w, h) {
  if (!decoy) throw new Error("splitFrames: mode 'decoy' requires opts.decoy");
  const { width: dw, height: dh, data: d } = decoy;
  return (x, y, c) => {
    const sx = Math.min(dw - 1, ((x * dw) / w) | 0);
    const sy = Math.min(dh - 1, ((y * dh) / h) | 0);
    const v = d[(sy * dw + sx) * 4 + c] / 255;
    return { phase: v, mag: Math.abs(v - 0.5) * 2 };
  };
}

/**
 * sRGB electro-optical transfer function, code value -> emitted light.
 *
 * The real curve is piecewise: linear near black, then a 2.4 power with an
 * offset. A pure 2.2 power is the usual shorthand and is wrong exactly where it
 * matters here, since a plane driven to one extreme spends its time near black.
 *
 * `gamma` of 2.4 selects the standard curve; any other value falls back to a
 * pure power so a display measured with tools/fit.mjs can be matched directly.
 * Measured on one 60Hz panel: 2.45 fitted best as a pure power, and the true
 * EOTF did slightly better still.
 */
/**
 * Per-target centre and swing for linear-light splitting, as a 256-entry table.
 *
 * The first version offset in light directly: swing = k * min(L, 1-L). Colours
 * came out exact, but light is tiny for most real colours — #14141a sits at
 * L=0.007, giving a code range of [3, 30]. That is a +/-13 swing, i.e. almost
 * no masking, and it is why a mid-tone panel stopped hiding anything.
 *
 * Instead: put the two planes symmetrically around a centre in CODE space, so
 * the swing is as large as the amplitude asks for, and solve for the centre
 * whose planes AVERAGE IN LIGHT to the target. Averaging a convex function
 * overshoots, so the centre lands below the target and cancels it exactly.
 *
 * Both properties at once: full code-space noise, and a perceived colour equal
 * to the authored one. The swing is only reduced where a pixel is close enough
 * to an extreme that v +/- d would clip.
 */
function linearMeanTable(amplitude, gamma) {
  const table = new Float64Array(512); // [centre, swing] per target value
  for (let target = 0; target < 256; target++) {
    const wanted = toLight(target, gamma);
    let swing = amplitude;

    for (; swing > 0; swing--) {
      // Light-mean is monotonic in the centre, so the reachable band is set by
      // the two ends of the centre's own range.
      const lowest = (toLight(2 * swing, gamma) + toLight(0, gamma)) / 2;
      const highest = (toLight(255, gamma) + toLight(255 - 2 * swing, gamma)) / 2;
      if (wanted >= lowest && wanted <= highest) break;
    }

    let lo = swing;
    let hi = 255 - swing;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const got = (toLight(mid + swing, gamma) + toLight(mid - swing, gamma)) / 2;
      if (got < wanted) lo = mid;
      else hi = mid;
    }
    table[target * 2] = (lo + hi) / 2;
    table[target * 2 + 1] = swing;
  }
  return table;
}

/** sRGB EOTF at gamma 2.4, else a pure power so a measured display can be matched. */
function toLight(v, gamma) {
  const s = clamp(v, 0, 255) / 255;
  if (gamma !== 2.4) return Math.pow(s, gamma);
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Contrast pre-emphasis around mid-grey, then compression into [lo, hi]. */
function remap(src, contrast, lo, hi) {
  const out = new Float32Array(src.data.length);
  const span = (hi - lo) / 255;
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const boosted = clamp(128 + (src.data[i + c] - 128) * contrast, 0, 255);
      out[i + c] = lo + boosted * span;
    }
  }
  return { width: src.width, height: src.height, data: out };
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/* -------------------------------------------------------------------------- */

/**
 * Average a set of captured frames. This is the recovery attack — the same
 * integration your eye performs, done in software. Kept in the library on
 * purpose: if you can't run this against your own output and see how much
 * comes back, you don't know what you're shipping.
 */
export function averageFrames(caps) {
  if (!caps.length) throw new Error('averageFrames: no frames');
  const { width: w, height: h } = caps[0];
  const acc = new Float64Array(w * h * 4);

  for (const c of caps) {
    if (c.width !== w || c.height !== h) throw new Error('averageFrames: size mismatch');
    for (let i = 0; i < acc.length; i++) acc[i] += c.data[i];
  }

  const out = new Uint8ClampedArray(acc.length);
  for (let i = 0; i < acc.length; i++) out[i] = acc[i] / caps.length;
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { width: w, height: h, data: out };
}

/**
 * How much of the source survives in a single plane, as |Pearson r| between
 * plane luma and source luma. 0 is a plane that tells you nothing; 1 is a plane
 * that is the picture.
 *
 * This is a legibility proxy, not a security metric — correlation is blind to
 * whether a human can read the result, and a low score is necessary but not
 * sufficient. Use it to compare modes against each other, not to certify one.
 *
 * Contrast, brightness and inversion do not move it, which is the point: those
 * are exactly the transforms an attacker undoes for free.
 */
export function leakScore(plane, src) {
  // averageFrames validates this; without the same check here a mismatch reads
  // past the end of the smaller buffer and returns NaN instead of throwing.
  if (plane.width !== src.width || plane.height !== src.height) {
    throw new Error(
      `leakScore: size mismatch, ${plane.width}x${plane.height} vs ${src.width}x${src.height}`
    );
  }
  const n = src.width * src.height;
  let sa = 0;
  let sb = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    sa += luma(plane.data, p);
    sb += luma(src.data, p);
  }
  const ma = sa / n;
  const mb = sb / n;

  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const da = luma(plane.data, p) - ma;
    const db = luma(src.data, p) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va && vb ? Math.abs(cov / Math.sqrt(va * vb)) : 0;
}

function luma(d, p) {
  return 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
}

/**
 * The strongest amplitude a set of authored colours can carry in adaptive mode.
 *
 * A pixel at value v clips beyond ±min(v, 255-v), so the ceiling is set by
 * whichever channel of whichever colour sits closest to black or white. This is
 * the real cost of picking vivid or high-contrast colours: near-black and
 * near-white have almost no headroom, so they carry almost no noise and leak.
 * Mid-tones are what buy you masking strength.
 *
 *   maxAmplitudeFor(['#000000', '#ffffff'])  ->   0   (no masking possible)
 *   maxAmplitudeFor(['#404a58', '#a8b4c4'])  ->  59
 *   maxAmplitudeFor(['#6b7280', '#9aa3b2'])  -> 107
 *
 * @param {Array<string|[number,number,number]>} colors  hex strings or RGB triples
 */
export function maxAmplitudeFor(colors) {
  let ceiling = 127;
  for (const color of colors) {
    for (const ch of toRgb(color)) ceiling = Math.min(ceiling, ch, 255 - ch);
  }
  return Math.max(0, Math.round(ceiling));
}

function toRgb(color) {
  if (Array.isArray(color)) return color;
  const hex = String(color).replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/**
 * Separable box blur — the cheapest denoise an attacker reaches for, and the
 * one that matters most here.
 *
 * Per-pixel noise is *white*: its energy sits above the spatial frequencies that
 * text strokes occupy, so a small blur averages the noise away while the strokes
 * survive. Measured on 5px strokes at amplitude 110, blurring a single captured
 * plane at radius 4 raises the leak from 0.13 to 0.46.
 *
 * Raising `noiseScale` pushes the noise down into the same frequency band as the
 * content, where no blur can separate them. At a block size at or above the
 * stroke width the attacker's best radius drops to 0 — blurring stops helping.
 * That is the reason to set noiseScale, and leakScore() alone cannot see it.
 */
export function boxBlur(img, radius) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return img;
  const { width: w, height: h, data: s } = img;
  const tmp = new Float32Array(w * h * 4);
  const out = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < w) {
            sum += s[(y * w + xx) * 4 + c];
            n++;
          }
        }
        tmp[(y * w + x) * 4 + c] = sum / n;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < h) {
            sum += tmp[(yy * w + x) * 4 + c];
            n++;
          }
        }
        out[(y * w + x) * 4 + c] = sum / n;
      }
      out[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Worst-case leak once an attacker is allowed to denoise: the best leakScore
 * they can reach by blurring the plane at any radius up to `maxRadius`.
 *
 * Use this, not leakScore alone, to decide whether a configuration is safe.
 * Returns { leak, radius } so you can see which radius broke it.
 */
export function denoisedLeak(plane, src, maxRadius = 8) {
  let best = { leak: 0, radius: 0 };
  for (let r = 0; r <= maxRadius; r++) {
    const leak = leakScore(boxBlur(plane, r), src);
    if (leak > best.leak) best = { leak, radius: r };
  }
  return best;
}

/**
 * The mean your eye actually resolves, averaged in light rather than in code.
 *
 * averageFrames() takes the arithmetic mean of the code values, which is what an
 * attacker's ffmpeg does and therefore the right tool for scoring a leak. It is
 * the wrong tool for asking what a viewer sees. Under linearLight the planes are
 * solved so their emitted LIGHT averages to the target, and because light is
 * convex the solved centre sits below the target in code. So the code-space mean
 * comes out systematically dark: an authored #404040 reads as #2d2d2d, about 19
 * levels, which is visible.
 *
 * Use this for anything meant to look like what the viewer sees. Use
 * averageFrames for anything meant to model a capture.
 */
export function perceivedMean(caps, gamma = 2.4) {
  if (!caps.length) throw new Error('perceivedMean: no frames');
  const { width: w, height: h } = caps[0];
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let lit = 0;
      for (const cap of caps) lit += toLight(cap.data[i + c], gamma);
      out[i + c] = toCode(lit / caps.length, gamma);
    }
    out[i + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/** Emitted light back to a code value. Inverse of toLight. */
function toCode(x, gamma) {
  const v = clamp(x, 0, 1);
  if (gamma !== 2.4) return 255 * Math.pow(v, 1 / gamma);
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
}

/** Undo the [lo, hi] compression, to compare a recovery against the original. */
export function expandRange(img, range) {
  const { lo, hi } = range;
  const span = (hi - lo) / 255;
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = (img.data[i + c] - lo) / span;
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}
