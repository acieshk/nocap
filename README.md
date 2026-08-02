# nocap

**Anti-screenshot, anti-AI display for secrets on screen.**

**[Live demo & playground](https://acieshk.github.io/nocap/)**

Splits content into frames that alternate at your display's refresh rate. Each
frame is noise; their *mean* is the content. Your visual system does the
averaging, so you read it — a single screenshot does not.

The text never enters the DOM, so page-reading AI agents and scrapers get
nothing at all.

```js
import 'nocap';
```
```html
<nocap-secret></nocap-secret>
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

## Scope

This library is the display effect and nothing else: split the content, show it,
and tell you honestly how well it is hidden. It deliberately does **not** ship
storage, delivery, encryption, expiry or accounts.

That is not an oversight — those belong a layer up, and they are where the real
protection lives. The flicker cannot beat a screen recording or DevTools; what
does beat them is making the captured value worthless. A one-time value that
dies on first read turns an unwinnable fight into an economic one.

If you are building that layer, the pieces that pair with this are: encryption
at rest with a key that never touches your server (a passphrase, or a key in the
URL fragment), single-use or short-lived values, per-recipient watermarking, and
on native, `WDA_EXCLUDEFROMCAPTURE` / `FLAG_SECURE` — which is enforcement
rather than friction. Use nocap for the moment the value is on screen.

## Choosing colours

`color` and `background` **are** the perceived colours. The split runs in linear
light, so what you author is what you see — verified to within 0.3 code levels
across the range. There is no band, no compression, and no contrast
pre-emphasis; those existed only to buy uniform noise headroom and linear light
removed the need.

What you cannot escape is that a colour can only carry so much noise. The
predictor is the **masking ratio**:

```js
checkPalette({ color: '#9ea6b4', background: '#6b7280' })
// { ratio: 1.42, grade: 'good', warnings: [] }
```

| ratio | measured leak | verdict |
| --- | --- | --- |
| ≥ 1.0 | 0.08 – 0.22 | good |
| 0.5 – 1.0 | ~0.3 | fair |
| < 0.5 | 0.47 – 0.79 | **do not ship** |

Correlated at −0.73 against denoised leak over 28 palettes. Light headroom, the
obvious metric, correlates −0.06 — no better than chance, because light is
expansive near white: `#f0f0f0` keeps 26% of its light headroom and still leaks
0.76.

Two hard limits fall out:

- **Saturation is capped.** A channel at 0 or 255 has zero swing, so `#ff3131`
  scores 0.00 at any lightness. Fully saturated colours cannot be masked.
- **Both ends are bad.** Usable region is roughly channels in `[40, 214]`, both
  colours mid-tone, separation under ~90.

Put the secret on a **mid-tone panel**. It then matches its surroundings exactly
*and* has room to be protected. `suggestConfig()` derives such a pair from a
page's palette, and [the palette demo](https://acieshk.github.io/nocap/demo/colors.html)
lets you check one interactively.

`amplitude` is now a fraction of whatever headroom the colours allow, so
**choosing mid-tone colours buys more protection than raising amplitude ever
does**. `noise-scale` trades blur resistance against flicker fusion: coarse
noise resists a blur far better but strobes below 120Hz, so 3 is the default.

## Fake values — experimental

> **Experimental, and not recommended for production yet.** It works, but the
> useful range is narrow enough that it may not be worth the complexity. Read
> the trade below before enabling it.


Noise tells an attacker the capture failed, so they take another. A value in the
right shape does not.

```html
<nocap-secret fake="auto"></nocap-secret>
```

**Each cycle carries a different decoy**, added on one of its two frames and
subtracted on the other. Two consequences:

- **The viewer never resolves any of them.** The pair cancels inside a single
  cycle — about 16ms at 60Hz — so it is gone well within the 50-100ms your eye
  integrates over.
- **A capture freezes one.** A screenshot cannot average, so it catches a single
  frame and a single decoy, in the right format, at full contrast. The rotation
  holds eight, so a burst lands on different ones.

### Why it is marked experimental

The decoy's push is bounded by the headroom the noise leaves, because anything
larger clips — and a clipped push is no longer equal and opposite, so the decoy
stops cancelling and ghosts into the mean where the viewer sees it. That bound
also makes the decoy subtle in a capture: it shares the noise's grain and
contrast rather than standing out from it.

So the two things you want are in direct tension. A decoy that blends and never
reaches the eye is hard to read in a screenshot; one that is boldly legible
leaks. There is no setting that gives both, and the honest summary is that fake
mode currently buys less than its complexity costs. It is kept because the
mechanism is sound and a larger decoy font may widen the window later.

**The pair has to sit inside one cycle**, and this is the subtle part. An earlier
version split each pair one cycle apart, which cancels only over the full
16-frame rotation — 267ms, far longer than the eye's window. The result inverted
the whole effect: the decoys stayed visible and the noise averaged away. Two
other failures cost a rebuild each, both visible only in a rendered frame:
alternating signs over *different* strings does not cancel, it leaves the
difference of their glyph coverage as a smear; and flipping the line and the sign
together re-correlates them and makes it worse.

`detectFormat()` classifies ISO and d/m/y dates, card expiries, card numbers,
grouped numbers, phone numbers, alphanumerics and free text; `fakeLike()`
generates the decoy in `auto` / `number` / `text` / `random`. The shape always
matches the source exactly — same length, separators, digit/letter/case pattern —
because a wrong-shaped decoy reveals the mechanism and is worse than noise. Auto
mode is semantic too: fake dates have real months, fake card numbers pass Luhn.

```
4471-0092-8834   grouped number, 12 digits   2206-9276-8289  6943-2162-7081 ...
2026-09-01       ISO date                    2024-02-15
4539578763621486 16-digit card number        4638875219028443
```

Decoys are driven from the mean of the plane pair at full headroom, so they
replace the noise where their ink falls rather than competing with it, and they
never clip or shift the perceived value. Each gets its own random position and
size, scattered across the field rather than stacked on fixed lines — the spot
belongs to the decoy rather than to the appearance, so the added and subtracted
copies still land on exactly the same pixels and cancel.

## `<nocap-secret>`

| Attribute | Default | Meaning |
| --- | --- | --- |
| `scramble` | off | Store glyphs shuffled; see the DevTools table. |
| `fake` | off | **Experimental.** `auto` / `number` / `text` / `random`. Needs masking ratio 1.0+. |
| `amplitude` | `96` | Fraction of the headroom the colours allow. |
| `noise-scale` | `3 × dpr` | Noise block in device px. Higher resists blur, strobes below 120Hz. |
| `gamma` | `2.4` | Display EOTF. Measure yours with the calibration demo. |
| `frames` | `2` | Planes per cycle. 2 is almost always right. |
| `contrast` | `1` | Pre-emphasis. Not needed under linear light, which does not compress. |
| `chroma` | `0` | 0 = grey noise, 1 = independent per channel. |
| `hardness` | `0.5` | 1 slams every pixel to ±amplitude; lower keeps noise near the background. |
| `color` / `background` | `#9ea6b4` / `#6b7280` | Authored palette. Must be maskable — see below. |
| `adaptive` | off | Exact colours, amplitude capped to their headroom. |
| `width` / `height` | `260` / `56` | CSS pixels. |

Properties: `.secret` (write-only), `.revealed`, `.refreshHz`, `.render()`,
`.stop()`, `.measureLeak()`. Events: `render`, `stop`.

**It renders as soon as it has a value.** Hold-to-reveal, click-to-toggle,
auto-hide on blur — those are product decisions, not part of the effect, so they
are deliberately absent. Wire them up around the element with `render()` and
`stop()`.

**Set `.secret` from JS.** Putting the text in markup works — it is read once and
erased from the DOM — but it was in the HTML source on the way there, which
defeats the point.

## Lower-level API

```js
import {
  Flicker, splitFrames, averageFrames, boxBlur, denoisedLeak,
  leakScore, planeRange, suggestConfig, checkPalette, codeSwing,
  detectFormat, fakeLike,
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

One page: the live/screenshot/denoise comparison, a playground with presets and
every parameter, checks that search each page surface for the secret on screen,
and both DevTools attacks running for real.

## Test

```
npm test
```

45 tests: the planes average back to the source at every amplitude and mode, no
plane leaks, clipping never breaks the zero-sum property, the leak ordering
holds, adaptive colour is exact, and coarse blocks resist a blur that fine noise
does not.

## License

MIT
