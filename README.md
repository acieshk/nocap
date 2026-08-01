# nocap

**Anti-screenshot, anti-AI display for secrets on screen.**

**[▶ Live demo](https://acieshk.github.io/nocap/)** · [Tuning bench](https://acieshk.github.io/nocap/demo/) · [Secret demo & source proof](https://acieshk.github.io/nocap/demo/secret.html)

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

Read this before building on it. The claims are narrow on purpose.

| Threat | Result |
| --- | --- |
| Reflexive Print Screen / Win+Shift+S / Cmd+Shift+4 | **Blocked** — the screenshot lands on one plane, which measures 0.00 correlation with the content |
| DOM-reading AI agents, LLM scrapers, accessibility-tree readers | **Blocked absolutely** — the secret is never a DOM node, so there is nothing to read |
| Single-frame OCR / vision-model ingestion | **Blocked** — one frame is noise |
| View Source, `curl`, Save Page As, Reader mode, Select-All + Copy | **Blocked** — verified live in the demo |
| Quick phone photo | **Usually blocked** — short exposure plus rolling shutter lands on one plane |
| **Screen recording + temporal averaging** | **Defeated.** `ffmpeg -i cap.mp4 -vf tmix=frames=2 out.mp4` recovers it |
| **Burst screenshots** | **Defeated.** Take several, average or keep the readable one |
| **Anyone with DevTools** | **Defeated.** The string is a live JS value: a breakpoint, heap snapshot, or `canvas.toDataURL()` retrieves it |

The averaging limit is information-theoretic, not an implementation gap:
**anything your eye can integrate, software can integrate better.** No amount of
tuning fixes it. `averageFrames()` ships in the library so you can run the attack
against your own output — if you can't, you don't know what you're shipping.

For protection that holds against a determined attacker, the mechanism is the
compositor, not the content: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
on Windows, `NSWindow.sharingType = .none` on macOS, `FLAG_SECURE` on Android.
Layer nocap on top of those, never instead of them. For documents, per-user
forensic watermarking changes behaviour more than any technical speed bump.

## Why it works for secrets specifically

Text is essentially two-tone, so it survives being crushed into a narrow value
band that would turn a photograph to mush. That means you can run amplitude 110+,
where a single plane retains no usable signal. Photographs cannot — this is not a
general-purpose image protector, and the demo is built to show you exactly where
it stops working.

Measured single-plane leak, |Pearson r| between plane luma and source luma:

| split | leak |
| --- | --- |
| RGB channel split (plane 0 = R, 1 = G, 2 = B) | 1.000 |
| decoy image as modulator | 0.929 |
| noise amplitude 32 | 0.782 |
| pixel interleave ×2 | 0.693 |
| noise amplitude 64 | 0.386 |
| noise amplitude 96 | 0.137 |
| pixel interleave ×2 + noise 96 | 0.095 |
| **noise amplitude 127** | **0.004** |

Two findings worth internalising, both reproducible via `npm test`:

**Splitting *where* pixels are does nothing. Only randomizing *what they say*
works.** Recognition survives losing colour, losing 90% of pixels, blur, and
quantization — so channel splitting and pixel interleaving both leak badly.
Interleave only becomes safe once stacked noise carries it, at which point the
interleaving contributed nothing.

**Noise amplitude is the only lever.** Frame count is not a substitute.

## Safety

Noise is per-pixel and zero-mean, so **every frame carries the same local mean
luminance as the source**. The alternation is a high-spatial-frequency contrast
reversal, not a full-field flash — the mechanism 6-bit panels use for FRC
dithering. That keeps it out of the large-area-flash regime WCAG 2.3.1 targets.

It is still moving high-contrast content. `hold` is the default pattern for a
reason: it keeps the flicker on screen only while the pointer is down. Always
offer an opt-out, and never engage it without user intent.

Below ~120Hz the shimmer is clearly visible — a 2-plane cycle on a 60Hz display
alternates at 30Hz. The library warns to the console below 100Hz measured refresh.

## `<nocap-secret>`

| Attribute | Default | Meaning |
| --- | --- | --- |
| `hold` | off | Reveal only while the pointer is held. Recommended. |
| `auto-hide` | `0` | Hide after N seconds. |
| `amplitude` | `110` | 0–127. Below ~96 the plane starts to leak. |
| `frames` | `2` | Planes per cycle. 2 is almost always right. |
| `contrast` | `2.2` | Pre-emphasis to claw back the band compression. |
| `width` / `height` | `260` / `56` | CSS pixels. |
| `placeholder` | `hold to reveal` | Cover text. |

Properties: `.secret` (write-only), `.revealed`, `.reveal()`, `.hide()`,
`.measureLeak()`. Events: `reveal`, `hide`. It auto-hides on tab switch and
window blur — the moment a screen share usually starts.

**Set `.secret` from JS.** Putting the text in markup works — it is read once and
erased from the DOM — but it was in the HTML source on the way there, which
defeats the point.

## Lower-level API

```js
import { Flicker, splitFrames, averageFrames, leakScore, planeRange } from 'nocap';
```

`Flicker` drives a canvas; `splitFrames` is pure and DOM-free (Node, workers, or
a native port). Modes: `amplitude` (the one that works), `interleave`, `channels`,
`decoy` — the last three are included so `leakScore` can show you why they don't.

| Option | Default | Effect |
| --- | --- | --- |
| `amplitude` | `64` | **The knob that matters.** Use 96–127. Higher masks better and washes out contrast, because the source is remapped into `[amplitude, 255-amplitude]` for clipping headroom. |
| `contrast` | `1` | Pre-emphasis. `planeRange()` tells you the value that fully compensates. |
| `hardness` | `1` | 1 = all noise energy at full amplitude (best mask). 0 = uniform. |
| `chroma` | `1` | 1 = independent per-channel noise. 0 = one draw shared across RGB. |
| `noiseScale` | `1` | Cell size in pixels. Keep at 1. |
| `bankSize` | `6` | Precomputed noise sets. Memory `w*h*4*frames*bankSize`. |

Render at exact device pixels. `resize(cssW, cssH)` handles `devicePixelRatio`;
if CSS rescales the canvas the noise blurs toward its mean and the content
becomes readable in a *single* frame — a silent, total failure.

## Demo

Live: **<https://acieshk.github.io/nocap/>**

Or locally:

```
npm run demo     # then open http://127.0.0.1:8787/
```

`/demo/` is the tuning bench: four synchronised panels (live, single plane, ideal
mean, recovered-by-averaging) with a live leak meter, over public-domain paintings.
`/demo/secret.html` is the account-number reveal, plus live checks that search the
served HTML, the DOM, `innerText`, Select-All + Copy, and the accessibility tree
for the secret on screen.

## Test

```
npm test
```

Verifies the planes average back to the source at every amplitude and mode,
that no plane leaks, that the leak ordering above holds, and that clipping never
breaks the zero-sum property.

## License

MIT
