# nocap API reference

Every attribute, property, and export, with defaults, ranges, and what each one
trades. Almost nothing here is free: most knobs move masking strength, visual
calm, and colour fidelity against each other, and the notes say which way.

```js
import 'nocap';                               // registers <nocap-secret>
import { Flicker, splitFrames, checkPalette } from 'nocap';   // the barrel
import { NocapSecret } from 'nocap/secret';   // or per-module subpaths
import { splitFrames } from 'nocap/splitter';
import { checkPalette } from 'nocap/palette';
import { fakeLike } from 'nocap/fake';
```

The package is plain ES modules, no build step, no dependencies. The barrel is
safe to import under SSR (Next, Astro, Remix): the element class falls back to a
plain base outside a browser and registration is guarded, so nothing renders
until the module reaches a real DOM.

---

## `<nocap-secret>`

```html
<nocap-secret strength="medium"></nocap-secret>
<script type="module">
  import 'nocap';
  document.querySelector('nocap-secret').secret = await fetchAccountNumber();
</script>
```

The plaintext is rendered straight to a canvas and never enters the DOM: absent
from View Source, the DOM inspector, the accessibility tree, Select-All + Copy,
Reader mode, "Save Page As", and every text-scraping extension. What it does
**not** do is hide from DevTools and intent — a breakpoint, a heap snapshot, or
one `canvas.toDataURL()` retrieves it, because the client belongs to the user.

Prefer the `.secret` property over inline text. Inline text works (it is read
once and erased), but it was in the HTML source on the way there.

**Accessibility is your job.** The value is unreadable to assistive technology
by construction. Provide an accessible route to the same value yourself (a
reveal button, a copy action behind auth — whatever fits your product).

### The value

| Member | Type | Meaning |
| --- | --- | --- |
| `secret` | `string`, **write-only** setter | Sets the value and renders. There is deliberately no getter: reading it back would put the secret in reach of any script that can see the element. |
| inline text | — | Read once on connect, then erased from the DOM. Works, but defeats the point unless the HTML was never served with it. |

### Strength

| Attribute | Default | Range | Meaning |
| --- | --- | --- | --- |
| `strength` | `medium` | `weak` \| `medium` \| `strong` | Sets `amplitude`, the noise block ratio, and `hardness` together, as tested points on one curve. Any individual attribute you also set overrides that part of the preset. |

* `weak` — amplitude 80, block 1.33× stroke, hardness 0.5. Easiest to read and
  the only one that fuses comfortably on a slow 60Hz panel. Its block sits
  *below* the blur-saturation point on purpose, so a denoise has a radius worth
  trying: that is the trade the name is making.
* `medium` — amplitude 110, block 2× stroke, hardness 1. The default.
* `strong` — amplitude 127, block 2.67× stroke, hardness 1. Most masking, most
  visually active. Untested at very large type (96px+), where coarse blocks are
  exactly what shimmers.

### The split

| Attribute | Default | Range | Meaning |
| --- | --- | --- | --- |
| `amplitude` | `110` | 0–127 | Half-swing of the per-pixel noise, in code values. More = stronger masking, more visible shimmer. Under linear light the swing is capped per pixel by that pixel's own headroom, so near-black and near-white carry less than asked. |
| `frames` | `2` | 2+ (aperture: 3+) | Planes per cycle. 2 is almost always right: the cycle rate is `refresh / frames`, so more planes push the alternation into the flicker-sensitive band. Left unset, the mode picks (aperture defaults to 6). |
| `mode` | `amplitude` | `amplitude` \| `aperture` \| `interleave` \| `decoy` | How the split works. `amplitude` perturbs every pixel with zero-sum noise (strongest mask). `aperture` shows one horizontal slice per frame and needs no colour headroom, so it works at pure white — at the cost of a burst of N frames holding everything. `interleave` exists to demonstrate why splitting *where* pixels are does not work (a single plane still holds 1/N true pixels and subsampling reads fine). `decoy` modulates with a second image instead of noise. `aperture`/`interleave` default `amplitude` to 0 so their own mechanism is visible; set `amplitude` explicitly to stack noise on top. |
| `contrast` | `1` | 0.5–2 sane | Pre-emphasis before band compression. Not needed under linear light, which does not compress. |
| `hardness` | `1` | 0–1 | 1 = every pixel at full amplitude (best mask, measured ~20% less leak raw and blurred). 0 = uniform-magnitude noise, which looks calmer and protects less. |
| `chroma` | `0` | 0–1 | 0 = one noise draw shared across R/G/B: grey static, and the whole budget lands in luminance, which is what the eye and `leakScore` key on (measured 0.262 denoised leak against 0.346 per-channel at equal loudness). 1 = independent per channel: rainbow static. |
| `noise-scale` | 2× stroke | ≥1 px | Noise block size in device px, derived from the stroke width unless set. 2× the stroke is where a box blur stops gaining on the attacker (measured across five font sizes). Setting it lower warns: a blur can recover value below that ratio. Coarser blocks resist blur best but sit at low spatial frequency, where temporal sensitivity peaks — they shimmer more at 30Hz cycle rates. |
| `noise-scale-max` | `16` | ≥4 px | Ceiling on the derived block, because 24–30px tiles on large type read as broken graphics rather than noise. Aesthetic, deliberately: raise it if the capture matters more than the look at very large sizes. The element warns when this cap is what is binding. |
| `noise-profile` | `white` | `white` \| `blue` | `blue` high-passes the block lattice (~37% less low-frequency energy at an 8px window), which may read calmer. It is not true void-and-cluster blue noise. Security unchanged — any leak difference is inside seed variance. |
| `ink-bias` | `0` | 0–1 | Leans amplitude toward the ink and quiets the background. The largest comfort win available, bought directly from protection, because where the noise is, is where the text is: measured leak 0.263 → 0.304 at 0.2, 0.361 at 0.4. The map is blurred past the stroke and keeps a floor so it cannot trace glyph edges outright. Past ~0.3, measure on your own content first. |
| `edge-fade` | `0` | ≥0 px | Taper the noise to nothing within this many pixels of the canvas edge, so the block dissolves into the page instead of ending on a hard rectangle. Free, unlike `ink-bias`: it follows the canvas rectangle, which an attacker can already see. |
| `gamma` | `2.4` | ~1.8–2.8 | Display transfer function. `2.4` selects the real piecewise sRGB curve; any other value is a pure power, for a display you have measured. |
| `adaptive` | off | boolean | Reproduce authored colours exactly by capping amplitude per pixel instead of compressing. Mostly superseded by linear light, which does both; kept for comparison. Check `maxAmplitudeFor()` before using — high-contrast palettes cap near zero. |

### Colour

| Attribute | Default | Meaning |
| --- | --- | --- |
| `color` | `#9ea6b4` | Text colour. The default pair is chosen to be maskable (ratio 1.42, leak 0.180), not merely handsome — the obvious dark-UI pairing `#e8e8f0`/`#14141a` leaks 0.951. |
| `background` | `#6b7280` | Panel colour behind the text. |
| `fit` | on | `off` to disable | When the authored pair cannot carry noise (masking ratio < 1), the element moves it to the nearest pair that can — same hue, same light-or-dark character, less separation — and warns with the numbers. `fit="off"` keeps your exact colours and the leak they imply. |

Check any custom pair with `checkPalette()` first. The physics: a pixel can only
swing `±min(light, 1-light)` of its own emitted light, so near-black and
near-white pixels carry almost no noise. Mid-tones are what buy masking. White
on black masks *nothing* — not as a weaker version of the technique, but none of
it.

### Type

| Attribute | Default | Meaning |
| --- | --- | --- |
| `font-family` | `ui-monospace, monospace` | Free text. If the canvas rejects the resulting font string, the element warns and falls back rather than silently drawing in whatever was set before. |
| `font-weight` | `600` | Any CSS weight. |
| `font-size` | `height × font-scale` | Device px, floor 6. Feeds back into the noise block: the block follows the stroke, and the stroke follows the font, so a configurable size keeps the blur margin intact. |
| `font-scale` | `0.46` | Fraction of the canvas height used when `font-size` is not set. |
| `letter-spacing` | `0px` | CSS length; a bare number gets `px`. Warns where the canvas API lacks support (Safari < 17.4) instead of silently ignoring. |
| `text-align` | `center` | `left` \| `center` \| `right`. |
| `padding-x` | `0` | Inset for left/right alignment, CSS px, floor 0. |
| `padding-y` | `0` | Vertical nudge of the baseline, may be negative. |

All numeric attributes are validated: a malformed value falls back to the
documented default and warns once, instead of coercing to `NaN` and silently
drawing nothing (which is what a canvas does with a non-finite coordinate).

### Sizing & playback

| Attribute | Default | Meaning |
| --- | --- | --- |
| `width` | `260` | CSS px. The canvas backs it with exact device pixels. |
| `height` | `56` | CSS px. |
| `max-dpr` | uncapped | Cap the devicePixelRatio the canvas renders at. The split, the bitmap bank, and every per-frame draw scale with dpr², and chunky noise gains nothing from 3×; a page with many elements should cap at 2. |
| `paused` | off | boolean. Holds plane 0 (exactly what a screenshot lands on — one plane is by definition safe to sit on) instead of animating. Use for elements that are off-screen or numerous: dozens animating at once drag the page below the refresh rate the cycle needs. |

**Never scale the canvas with CSS.** Resampling averages the noise toward its
mean and hands a capture the value back. Size with `width`/`height` attributes.

### Modes (experimental)

| Attribute | Default | Meaning |
| --- | --- | --- |
| `scramble` | off | Store the glyphs shuffled, with positions kept separately, so no JS value ever holds the plaintext in order (a heap-snapshot search finds nothing). Each glyph is drawn alone at fixed coordinates and blitted to its slot, so a `fillText` hook sees single characters in shuffled order. Obfuscation, not encryption: reading both fields reconstructs the value. `letter-spacing`, `text-align`, `padding-*` are inert (each glyph has its own cell) and warn. |
| `fake` | off | `auto` \| `number` \| `text` \| `random`. Each of 8 cycles carries a *different* plausible wrong value, added on one frame of the pair and subtracted on the other: the viewer never resolves any (the pair cancels inside one cycle, ~16ms), while a capture freezes one at full contrast. `auto` matches the detected format — card-shaped values get Luhn-valid numbers, dates get real months. Needs a maskable palette (ratio 1.0+). Draws the value centred; alignment/spacing attributes are inert while on. With `scramble` also set, fake wins and warns (they are alternative draw paths). |
| `fake-share` | `0.8` | 0–0.9. Share of each ink pixel's excursion budget the decoy takes; the rest stays with the noise. The pair's centre is re-solved in light after widening, so the perceived value stays exact at every setting (measured ghost ≤ 1 code level). Defaults sit at the loud end because that is the measured requirement: below ~0.5 the decoy reads *under* the real value and convinces nobody. |
| `fake-size` | `1` | 0.1–1. Decoy glyph size relative to the real type. Full size is the measured requirement, same reason. At the old 0.55 default the decoy scored below the truth at every share, which is why 0.1 shipped with the mode disabled. |
| `fake-weight` | `800` | 100–1000. The decoy's own font weight, deliberately heavier than the value it imitates: the noise block is calibrated to 2× the *real* stroke, so a decoy at the same weight has strokes half a block wide — the worst spatial frequency for a glance to separate from noise. Bolding is only safe together with the halo below; benched alone it turns the strokes into low-noise windows the real value's mean reads through. |
| `fake-halo` | auto | px, 0 to disable. A contour ring around each decoy glyph, spending the same budget with the opposite sign, so the glyph carries its own edge on both polarities — a bright glyph with a dark rim on one plane, dark with bright on the other. This is what makes the decoy legible to a *human* glance rather than only to correlation, and it covers the real value's single-frame ghosts exactly where they show, at the stroke edges. Auto derives the width from the rendered decoy size. Cancels between the planes like the glyph does; the viewer sees neither. |
| `watermark` | off | text | An isoluminant mark composited under the value, scattered to resist cropping. Survives frame averaging (it is in the mean), nearly invisible to the eye (chrominance only, blue-yellow axis). One greyscale conversion strips it — measured 0.996 correlation in colour, 0.020 after `-vf format=gray`. Attribution for casual leaks, not protection. |
| `watermark-swing` | `60` | chroma units | Requested swing along blue-yellow. Reduced (never clipped) near the gamut edge; read `watermarkSwing` for the achieved value. Direction is chosen automatically toward the side with room. |
| `watermark-repeat` | `3` | 1–8 | Copies scattered across the field. |
| `chroma-decoy` | off | text | A decoy written in chrominance at zero luminance contrast, alternating isoluminant colours in fine blocks inside its glyphs. Spatial, not temporal: still there after a thousand frames averaged — aimed at the case nocap otherwise loses. The eye greys it out; a sensor reads it. Defeated by one greyscale conversion, so: automated capture and screenshot-into-chat, not a thinking attacker. Warns when the background leaves under 8 levels of chroma swing. |
| `chroma-block` | `2` | ≥1 px | Checker block of the chroma decoy. 1px is annihilated by 4:2:0 subsampling (measured 54.0 PNG → 1.3 JPEG); 2px survives JPEG and H.264; above ~4px a viewer starts seeing coloured speckle. The usable window is roughly 2–4 and may not exist on your panel — judge live. |

### Scratch-to-reveal (experimental)

Changes the thing the frame-averaging attack depends on: a pixel carries content
only while inside the pointer trail, so a long capture averages to
`duty × content` while the noise keeps full amplitude. A cost to the attacker,
not a defence — a long recording still holds a faint copy.

| Attribute | Default | Meaning |
| --- | --- | --- |
| `scratch` | off | boolean. Reveal only a trail under the pointer. Requires a pointer: keyboard and screen-reader users cannot scrub, so an integration **must** offer another route. Sets `touch-action: none` while on (a drag competes with scrolling). |
| `scratch-radius` | `34` (`52` coarse pointer) | Brush radius, CSS px. Read live every frame — not observed, so changing it never re-splits. |
| `scratch-linger` | `30` | Seconds for a stroke to fade to 1%. Wall-clock, not per-frame: the same setting means the same thing at 60Hz and 120Hz. Also read live. |
| `scratch-hint` | `Scratch to reveal` | Overlay text shown until first scratch and again once the trail has faded. `off` or empty disables. Painted over the canvas, never into it, so it is never masked. |
| `scratch-exclusive` | on | `off` to disable | Scratching one element clears every other live trail, so no single frame ever holds two revealed values (the still capture, and the person behind you). Not an anti-extraction measure and not sold as one. |

### Textures

| Attribute | Default | Meaning |
| --- | --- | --- |
| `pattern` | none | `dots` \| `hatch` \| `grid` \| `grain`. A texture in the element's ground so it can match a patterned page. |
| `pattern-strength` | `16` | code levels | Same units as the CSS around it. In-canvas, texture is *content the split must carry*: measured raw leak 0.197 flat → 0.225 at 16 levels → 0.285 at 34. Warns past the ground's own swing, where it clips instead of strengthening. Judge it live — a screenshot buries any texture under the noise span, by design. |
| `pattern-layer` | in-canvas | `front` | Composite the texture *over* the canvas as CSS instead. Free (the split never carries it) and can run at page strength; the cost moves to legibility, since it now sits on the glyphs. Phase-locks to the page properly (~1px residual), which the in-canvas hatch cannot. |
| `pattern-offset-x` / `-y` | `0` | CSS px | Phase, so the texture continues the page's rather than restarting at the element's corner. For `front`, supply live via CSS custom properties instead (below). |
| `pattern-enter` | off | `left` \| `right` \| `up` \| `down` \| `center` | Wipe-in animation for the front layer, honouring `prefers-reduced-motion`. |
| `pattern-playing` | off | boolean | The animation runs while set; remove and re-add to replay. Presentational only — changing it never re-splits. |

### CSS custom properties

The shadow root is closed; custom properties are the one styling hook that
crosses it.

| Property | Default | Meaning |
| --- | --- | --- |
| `--nocap-radius` | `4px` | Canvas corner radius. Set `0` when stacking elements into a wall so seams do not notch. |
| `--nocap-pattern-ox` / `-oy` | `0px` | Live phase for `pattern-layer="front"`, written by the page whenever layout settles. |
| `--nocap-enter-dur` / `--nocap-enter-delay` | `.62s` / `.1s` | Wipe-in timing. |

### Properties, methods, events

| Member | Meaning |
| --- | --- |
| `revealed` → `boolean` | Whether the element is currently showing a value. |
| `refreshHz` → `number` | Measured display refresh, 0 before the first frames land. Below ~120Hz a 2-plane cycle runs under 60Hz and shimmers; tell the viewer rather than letting them conclude the technique looks bad. |
| `planes` → `Pixels[]` | The current planes. Plane *k* is exactly what a single screenshot lands on. |
| `decoys` → `string[]` | Fake mode's rotation, for demos. Never contains the real value. |
| `lastDecoy` → `string \| null` | The decoy in the first cycle. |
| `fitted` → object \| null | What `fit` moved the palette to (`{color, background, ratio, moved, contrast}`), or null if it was already maskable. |
| `watermarkSwing` → `number` | Achieved chroma swing of the mark, 0 if none. |
| `render()` → `Promise` | Re-split and start. Called for you on `.secret =` and attribute changes. |
| `stop()` | Stop the alternation and overwrite the canvas with the background (a stopped canvas must not sit on one readable plane). |
| `measureLeak()` → `number \| null` | Worst single plane against the mean, for tuning. Null before first render. |
| `render` event | Fired after each render completes. |
| `stop` event | Fired by `stop()`. |

### Console warnings

The element warns once (never spams) on: an unmaskable palette (with the fitted
replacement), a malformed numeric attribute, a rejected font, unsupported
letter-spacing, a value wider than the canvas (with how many characters are
cut), a noise block under 2× the stroke, `prefers-reduced-motion` forcing a
static render, pattern strength past the ground's headroom, and fake+scramble
both set. Silent wrong output is treated as a bug throughout.

---

## `Flicker`

The runtime under the element, usable directly on any canvas with any drawable
source.

```js
import { Flicker } from 'nocap';
const f = new Flicker(canvas, { amplitude: 110, linearLight: true, chroma: 0 });
f.resize(320, 74);                      // CSS px; backs with device pixels
await f.setText('4471-0092-8834', { color: '#9ea6b4', background: '#6b7280' });
f.start();
```

### Options (superset of `SplitOptions`)

| Option | Default | Meaning |
| --- | --- | --- |
| `planeHold` | `1` | Vsyncs each plane is held. 1 is what you want; raising it simulates a slower display. |
| `bankSize` | `6` | Precomputed noise cycles rotated through. Generation costs ~10ms/megapixel, which vsync does not have, so banks are built ahead and each presented frame is a single `drawImage`. Memory ≈ `w × h × 4 × frames × bankSize` bytes. |
| `warnBelowHz` | `100` | Refresh threshold for the one-time comfort warning. |
| `willReadFrequently` | `false` | Leave false in production (GPU-backed blits are faster). Set true only to `getImageData` off the live canvas. |
| …plus every `SplitOptions` field | | See below. |

### Methods

| Method | Meaning |
| --- | --- |
| `resize(cssW, cssH, dpr?)` | Size in CSS px, backed by exact device pixels. |
| `setSource(drawable, {background})` | Any canvas-drawable, contain-fitted. Rebuilds the bank. |
| `setText(text, {font, color, background, lineHeight})` | Word-wrapped text helper. |
| `setDecoy(drawable \| null, {background})` | The second image for `mode: 'decoy'`. |
| `setPlanes(planes)` | Present planes built elsewhere, bypassing `splitFrames`. |
| `setBank(sets)` | Present a whole rotation of prebuilt cycles (what fake mode uses). |
| `configure(patch)` | Change options, rebuild if a source is set. |
| `start()` / `stop()` / `running` | Drive the rAF loop. Superseded rebuilds are cancelled and their bitmaps closed. |
| `showPlane(k)` | Stop and display one plane — exactly what a screenshot gets. |
| `setRevealMask(mask, background)` | Alpha stencil; planes show only where it is opaque (scratch mode's engine). |
| `destroy()` | Stop, close every ImageBitmap, drop sources. Call it or leak bitmaps. |
| `stats` | `{presented, dropped, refreshHz, cycleHz}`, measured live. |
| `planes` / `range` | Current planes; the `[lo, hi]` band for `expandRange`. |

---

## Splitter (`nocap/splitter`)

Pure functions over `{width, height, data}` structs (structurally `ImageData`),
no DOM — the same code runs in Node, a worker, or a native port. The attacks are
shipped alongside the defence so every claim can be run rather than believed.

### `splitFrames(src, opts?) → Pixels[]`

The core. Turns one image into N planes whose per-pixel offsets sum to exactly
zero: their mean is the content, each plane alone is degraded.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `amplitude` | See the element's `mode` table above. |
| `frames` | `2` (aperture `6`, floor 3) | Planes per cycle. |
| `amplitude` | `64` | 0–127 noise half-swing. (The element overrides to 110 for text; a photograph wants less.) |
| `contrast` | `1` | Pre-emphasis before compression. |
| `hardness` | `1` | 0–1, magnitude distribution (see element table). |
| `chroma` | `1` | 0–1, per-channel independence. The element defaults 0; the raw function keeps the legacy 1. |
| `noiseScale` | `1` | Block size, px. The blocks are laid like brickwork (rows offset, never repeating a neighbour) so no seam spans the canvas. Fresh draws per split are load-bearing: freezing one pattern and inverting it doubles across-cycle modulation, the stimulus the eye is most sensitive to. |
| `fill` | `128` | interleave/aperture: the value non-carrying planes show. Clamped into the noise headroom, since a fill of 0 with stacked noise clips and silently darkens the mean. |
| `decoy` | `null` | The second image for `mode: 'decoy'`. |
| `linearLight` | `false` | Average in light, not code. A display emits `(v/255)^γ` and the eye integrates light, so alternating `v±d` in sRGB reads brighter than `v` (~35 levels at mid-grey). Linear light solves each pixel's centre so emitted light averages exactly to the target: authored colours arrive exact, with no compression band, and the swing shrinks only where a pixel nears an extreme. The element always uses it. Forced off for interleave/aperture, which do not implement it. |
| `gamma` | `2.4` | `2.4` = real piecewise sRGB; else a pure power for a measured display. |
| `inkBias` | `0` | See element table. |
| `edgeFade` | `0` | See element table. |
| `noiseProfile` | `white` | `blue` high-passes the lattice. |
| `adaptive` | `false` | Cap amplitude per pixel instead of compressing. |
| `rng` | `Math.random` | Injectable for reproducible tests. |

### Recovery & scoring

| Export | Meaning |
| --- | --- |
| `averageFrames(caps) → Pixels` | The attack: the mean your eye computes, done in software. Code-space mean — what an attacker's ffmpeg produces. |
| `perceivedMean(caps, gamma?) → Pixels` | The mean in *light* — what a viewer resolves. Use for anything meant to look right; `averageFrames` for anything meant to model a capture (it renders ~19 levels dark under linear light). |
| `leakScore(plane, src) → number` | \|Pearson r\| between plane luma and source luma. A legibility *proxy*: 0 tells nothing, 1 is the picture. Blind to contrast, brightness, inversion — the transforms an attacker undoes for free. Compare configurations with it; do not certify one. Throws on size mismatch. |
| `boxBlur(img, radius) → Pixels` | The cheapest denoise an attacker reaches for. Radius 0 is identity. |
| `denoisedLeak(plane, src, maxRadius=8)` | `{leak, radius}`: the worst leak over every blur radius. Use this, not raw `leakScore`, to judge a configuration. |
| `gaussianBlur(img, sigma)` | A stronger attack, shipped so the box-blur numbers stand on more than the friendliest attack. (Box wins anyway at the shipped block sizes; the numbers are in the source.) |
| `medianFilter(img, radius)` | The attack that *should* worry us (edge-preserving, impulse-rejecting) and measurably does not: at a radius small enough to keep strokes, the window sits inside one noise block and sees no outliers. |
| `bestAttack(plane, src, {maxRadius, maxSigma})` | `{attack, param, leak}` — the strongest of all of the above, so a caller cannot accidentally quote the friendliest one. |
| `expandRange(img, {lo, hi})` | Undo band compression, to compare a recovery against the original. |
| `planeRange(opts) → {lo, hi}` | The band a config compresses into. `{0, 255}` under linear light or adaptive (no compression). |
| `maxAmplitudeFor(colors) → number` | The ceiling a palette allows in adaptive mode: `['#000','#fff']` → 0, mid-tones → 107+. |

---

## Palette (`nocap/palette`)

| Export | Meaning |
| --- | --- |
| `checkPalette({color, background, gamma?})` | **Run this on any custom pair.** Returns `{ratio, grade, textSwing, backgroundSwing, separation, warnings}`. `ratio = min(swing) / separation`; ≥1 is `good` (a single frame stops being readable), 0.5–1 `fair`, <0.5 `weak` (a capture stays legible). Validated against denoised leak across 28 palettes (r = −0.73, where raw light headroom scores −0.06). |
| `fitToBand({color, background, minRatio=1, gamma?})` | Move an unmaskable pair to the nearest one that masks: same hue, same light/dark character, less separation; the midpoint walks toward mid-grey only when it must, and saturated channels are desaturated only as far as needed. Returns `{color, background, ratio, moved, contrast}`. This is what the element's `fit` runs. |
| `suggestConfig(design)` | A full starting configuration derived from your page's `background`/`color` (+ optional `fontSize`, `minContrast`, `amplitude`…): colours placed where they can be masked, block derived from the stroke, plus `masking`, `contrast`, `chromaRetained`, `adaptiveCeiling`, and human-readable `notes` on every trade made. |
| `codeSwing(color, gamma?)` | How far a colour's pixels can travel in code values under a full-swing linear-light split. Peaks ~127 at `#bcbcbc`, collapses toward white far faster than toward black. The atom the ratio is built from. |
| `contrastRatio(a, b, gamma?)` | WCAG-style contrast, so the cost of fitting is a number. |
| `isoluminantPartner(base, swing=60)` | A colour differing in chrominance only, along blue-yellow (S-cones are sparse; codecs subsample this axis). Swing reduced, never clipped, near the gamut edge. Returns `{color, swing, deltaLuma}` with the *achieved* values. |
| `isoluminantPair(background, strength=1)` | Two colours of equal luminance whose mean is exactly the background (green/magenta axis), for the chroma decoy. Returns `{a, b, swing}`. |
| `placeInBand(color, targetLuma, bounds)` | Move a colour to a luminance, keeping hue, inside channel bounds. Scales chroma down rather than clipping (clipping a channel silently breaks isoluminance). |
| `toLight(v, gamma?)` / `toCode(x, gamma?)` | The sRGB EOTF and its inverse. `2.4` = the real piecewise curve. |
| `luma(rgb)` / `toRgb(color)` / `toHex(rgb)` | Rec. 709 luma; hex/array conversions. |

---

## Fake values (`nocap/fake`)

| Export | Meaning |
| --- | --- |
| `detectFormat(text)` | `{kind, mask, digits, letters, separators, describe}`. Recognises ISO and d/m/y dates, card expiries, card numbers (13–19 digits), grouped numbers, phone numbers (needs a real phone marker — `+`, `(`, or leading 0 — so account numbers are not swallowed), alphanumerics, plain numbers, email, free text. |
| `fakeLike(text, {mode='auto', rng})` | A decoy shaped *exactly* like the input: same length, separators, digit/letter/case pattern (a wrong-shaped decoy reveals the mechanism). `auto` is semantic: dates get real months and days, card-shaped values get a **Luhn-valid** number (final digit solved, not rejection-sampled). Never returns the input itself. Alphabet omits I/O (they read as 1/0 and look wrong). |
| `passesLuhn(text)` | True when the digit positions satisfy the checksum (13+ digits). |

```js
detectFormat('4111 1111 1111 1111').describe   // "16-digit card number"
fakeLike('4111 1111 1111 1111')                // "5327 8801 4429 6613"
passesLuhn(fakeLike('4111 1111 1111 1111'))    // true
```

---

## Page audit (`nocap`, `auditPage`)

```js
import { auditPage } from 'nocap';
const { clean, found, report } = await auditPage(secretValue);
console.log(report);
```

Searches every surface an integration leaks through without meaning to: fetched
HTML source, live DOM, `innerText`, Select-All text, form control values, the
accessibility tree (`aria-label`, `title`, `alt`, …), open shadow roots, and
web storage. Canvas pixels always report `recoverable` — a run of frames
averages to the plaintext, no mode changes that, and reporting it clean would
be a lie.

⚠️ It takes the plaintext because it has to search for it, so the value exists
in one more place while the call runs: development and tests, not production.
`{fetchSource: false}` skips the network round trip.

---

## Testing hooks

`resolveOptions(attrs, dpr?, height?, fontSizePx?)`, `resolveText(attrs,
height?)`, `resolveFake(attrs)`, `decoySplit(cap, share, amount, b0, b1)`,
`feasibleHalfTable(gamma)`, `scratchLingerKeep(dt, linger)` and `STRENGTHS` are
exported from `nocap/secret` so the attribute pipeline is testable without a
DOM. They are stable enough to test against, not part of the styling surface.
