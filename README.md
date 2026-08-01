# nocap

**Anti-screenshot, anti-AI display for secrets on screen.**

**[Live demo](https://acieshk.github.io/nocap/)** · [Tuning bench](https://acieshk.github.io/nocap/demo/) · [Secret demo & attacks](https://acieshk.github.io/nocap/demo/secret.html)

Splits content into frames that alternate at your display's refresh rate. Each
frame is noise; their *mean* is the content. Your visual system does the
averaging, so you read it — a single screenshot does not.

The text never enters the DOM, so page-reading AI agents and scrapers get
nothing at all.

```js
import 'nocap';
```
```html
<nocap-secret hold auto-hide="6"></nocap-secret>
```
```js
document.querySelector('nocap-secret').secret = await fetchAccountNumber();
```

---

## What this defeats, and what defeats it

The claims are narrow on purpose. Read this before building on it.

| Threat | Result |
| --- | --- |
| Reflexive Print Screen / Win+Shift+S / Cmd+Shift+4 | **Blocked** — the capture lands on one plane |
| DOM-reading AI agents, LLM scrapers, accessibility-tree readers | **Blocked absolutely** — the secret is never a DOM node |
| Single-frame OCR / vision-model ingestion | **Blocked** — one frame is noise |
| View Source, `curl`, Save Page As, Select-All + Copy | **Blocked** — verified live in the demo |
| Quick phone photo | **Usually blocked** — short exposure lands on one plane |
| **Screenshot + a box blur** | **Weakened.** Denoising recovers a lot; see the block-size table |
| **Screen recording + temporal averaging** | **Defeated.** `ffmpeg -i cap.mp4 -vf tmix=frames=2 out.mp4` |
| **Burst screenshots** | **Defeated.** Average them, or keep the readable one |
| Casual DevTools poke — heap search, one-line `fillText` hook | **Slowed** by `scramble` — yields the glyphs without their order |
| **Anyone with DevTools and intent** | **Defeated.** The canvas must hold the arranged image, so averaging a run of frames recovers it |

The averaging limit is information-theoretic, not an implementation gap:
**anything your eye can integrate, software can integrate better.** No tuning
fixes it. `averageFrames()` and `denoisedLeak()` ship so you can run both attacks
against your own settings — if you can't, you don't know what you're shipping.

For protection that holds against a determined attacker the mechanism is the
compositor, not the content: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
on Windows, `NSWindow.sharingType = .none` on macOS, `FLAG_SECURE` on Android.
Layer nocap on top of those, never instead. For documents, per-user forensic
watermarking changes behaviour more than any technical speed bump.

## How DevTools defeats it

`scramble` is an optional mode that stores glyphs shuffled with a separate slot
map and paints each back into place. It moves several of these attacks. It does
not move the one that matters.

| Attack | Default | With `scramble` |
| --- | --- | --- |
| **Average a run of frames off the canvas** | plaintext | **plaintext** |
| Breakpoint on the `secret` setter | plaintext | plaintext |
| Read the element's private fields | plaintext | reconstructable |
| Hook `fillText` on both 2D prototypes | whole secret, one call | glyphs, no order |
| Heap snapshot, search for the string | found | not found |

The first row settles it, and no mode changes it: **the canvas must hold the
correctly-arranged image, or you could not read it either.** A short run of frames averaged
together is the plaintext — verified live in the demo, which recovers it
identically with and without `scramble`. Scrambling protects how the value sits in JS memory
and does blunt the one-line `fillText` dump, but it is obfuscation, not
encryption — both the shuffled glyphs and their position map are live fields on
the element, and the setter still receives the plaintext before any of it happens.

A `fillText` hook has to patch **`OffscreenCanvasRenderingContext2D`** as well;
text is rasterised off-screen, so patching only `CanvasRenderingContext2D`
catches nothing and makes the default look safe when it is not.

The real line is **automated pipeline vs. targeted attacker**. nocap defeats the
pipeline and never the person who has decided to come after the value.

## Tuning

Two knobs matter, and both are trade-offs rather than settings with a right answer.

**Amplitude** buys masking with perceived contrast. The source is remapped into
`[amplitude, 255-amplitude]`, so that band *is* your contrast budget.

**Block size** (`noise-scale`) buys blur resistance with flicker fusion. Per-pixel
noise is *white* — it sits above the spatial frequencies text strokes occupy, so
a small blur separates them. Coarse noise shares the band with the content, where
no radius helps. But coarse noise is low spatial frequency, and that is exactly
where the eye's temporal contrast sensitivity peaks: at 30Hz (any 60Hz display,
two planes) large blocks strobe instead of fusing.

At amplitude 96 on 14 characters of monospace, with a box-blur attack allowed:

| block | perceived contrast | denoised leak | fuses at 60Hz |
| --- | --- | --- | --- |
| 1 | 63 | 0.604 | yes |
| **3** | 63 | **0.377** | yes — **default** |
| 5 | 63 | 0.310 | no, strobes |

Block size costs nothing in legibility, only in fusion. Raise it toward the
stroke width only when you know the display runs at 120Hz+.

Amplitude 110 was the earlier default and was wrong: its band is `[110, 145]`,
giving the perceived image 35 levels of contrast — readable in a still, far too
washed out to read through a live alternation.

## Colour

A pixel at value `v` carries at most `±min(v, 255-v)` before it clips, and
clipping breaks the zero-sum property that makes the mean come out right. So the
perceived palette must live inside `[amplitude, 255-amplitude]` — a band centred
on mid-grey that narrows as masking gets stronger.

- **Default** pulls your colours into the band, keeping hue via a luma+chroma
  placement rather than an RGB scale (scaling blows out a near-black colour's
  chroma into a cast). Tinted rather than grey; masking preserved.
- **`adaptive`** reproduces authored colours exactly and caps amplitude per pixel
  to their headroom instead. Check the ceiling first with `maxAmplitudeFor()` —
  white-on-black gives **0**, and leaks 1.000. It is unmaskable.

Masking only works when noise amplitude exceeds the text/background separation,
so lower perceived contrast is not a cosmetic compromise here — it is the thing
that makes the technique work.

`suggestConfig({ background, color, amplitude })` turns a page's palette into a
config that blends and still masks, and reports `chromaRetained` so a suggestion
cannot quietly grey out a brand palette and call it a match. The
[live demo](https://acieshk.github.io/nocap/) recolours itself from two pickers
and emits the matching snippet.

One constraint it will tell you about: the secret's background **cannot** match a
near-black or near-white page, because it has to sit in the band. Style it as an
inset field and the difference reads as a form input rather than a mistake.

## `<nocap-secret>`

| Attribute | Default | Meaning |
| --- | --- | --- |
| `hold` | off | Reveal only while the pointer is held. Recommended. |
| `auto-hide` | `0` | Hide after N seconds. |
| `scramble` | off | Store glyphs shuffled; see the DevTools table. |
| `amplitude` | `96` | 0–127. |
| `noise-scale` | `3` | Noise block in px. |
| `frames` | `2` | Planes per cycle. 2 is almost always right. |
| `contrast` | `2.6` | Pre-emphasis to claw back the band compression. |
| `color` / `background` | `#e8e8f0` / `#14141a` | Authored palette. |
| `adaptive` | off | Exact colours, amplitude capped to their headroom. |
| `width` / `height` | `260` / `56` | CSS pixels. |
| `placeholder` | `hold to reveal` | Cover text. |

Properties: `.secret` (write-only), `.revealed`, `.refreshHz`, `.reveal()`,
`.hide()`, `.measureLeak()`. Events: `reveal`, `hide`. It auto-hides on tab
switch and window blur — the moment a screen share usually starts.

**Set `.secret` from JS.** Putting the text in markup works — it is read once and
erased from the DOM — but it was in the HTML source on the way there, which
defeats the point.

## Lower-level API

```js
import {
  Flicker, splitFrames, averageFrames, boxBlur, denoisedLeak,
  leakScore, planeRange, maxAmplitudeFor, suggestConfig,
} from 'nocap';
```

`Flicker` drives a canvas. Everything in `splitter.js` and `palette.js` is pure
and DOM-free, so it runs in Node, a worker, or a native port.

Split modes: **`amplitude`** (the one that works), plus `interleave`, `channels`
and `decoy` — included so `leakScore` can show you why they do not:

| Split | Single-plane leak |
| --- | --- |
| `channels` — RGB split across planes | 1.000 |
| `decoy` — second image as modulator | 0.929 |
| `interleave` ×2 — pixels split across planes | 0.693 |
| `amplitude` 64 | 0.386 |
| `amplitude` 96 | 0.137 |
| `amplitude` 127 | 0.004 |

Measured on a structured test image with `leakScore` — raw, with no denoising.
See the block-size table above for numbers with a blur attack allowed; they are
considerably worse, and that is the honest number to design against.

**Splitting *where* pixels are does nothing; only randomizing *what they say*
works.** Recognition survives losing colour, losing 90% of pixels, blur and
quantization, so channel splitting and pixel interleaving both leak badly.
Interleave only becomes safe once stacked noise carries it — at which point the
interleaving contributed nothing. Noise amplitude is the only lever; frame count
is not a substitute.

Render at exact device pixels. `resize(cssW, cssH)` handles `devicePixelRatio`;
if CSS rescales the canvas the noise blurs toward its mean and the content
becomes readable in a *single* frame — a silent, total failure.

## Safety

Noise is per-pixel and zero-mean, so **every frame carries the same local mean
luminance as the source**. The alternation is a high-spatial-frequency contrast
reversal, not a full-field flash — the mechanism 6-bit panels use for FRC
dithering. That keeps it out of the large-area-flash regime WCAG 2.3.1 targets.

It is still moving high-contrast content. `hold` is the default pattern because
it keeps the flicker on screen only while the pointer is down. Always offer an
opt-out, and never engage it without user intent. Below ~120Hz the shimmer is
clearly visible; the library warns to the console below 100Hz measured refresh,
and the demos honour `prefers-reduced-motion`.

## Demo

Live: **<https://acieshk.github.io/nocap/>** — or `npm run demo`, then
<http://127.0.0.1:8787/>.

- `/` — before/after comparison with live sliders, and the blend studio.
- `/demo/` — tuning bench over public-domain paintings: live, single plane, ideal
  mean, and recovered-by-averaging, with a leak meter.
- `/demo/secret.html` — the account-number reveal, live checks that search every
  page surface for the secret, and both DevTools attacks running for real.

## Test

```
npm test
```

39 tests: the planes average back to the source at every amplitude and mode, no
plane leaks, clipping never breaks the zero-sum property, the leak ordering
holds, adaptive colour is exact, and coarse blocks resist a blur that fine noise
does not.

## License

MIT
