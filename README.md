# nocap

**Prevent screenshots of text on the web.** A display layer that shows a secret
to a human but not to a screen capture, an OCR pass, or a page-reading AI agent. And that ships the attacks against itself so you can check the claim.

[![test](https://github.com/acieshk/nocap/actions/workflows/test.yml/badge.svg)](https://github.com/acieshk/nocap/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/nocap)](https://www.npmjs.com/package/nocap)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/acieshk/nocap/blob/main/LICENSE)

| What a screenshot captures | What you see |
| --- | --- |
| ![one captured frame](https://raw.githubusercontent.com/acieshk/nocap/main/docs/screenshot.png) | ![the perceived mean](https://raw.githubusercontent.com/acieshk/nocap/main/docs/perceived.png) |

Both are the same element at the same moment. The left is one plane straight out
of the live pipeline. The right is the mean of that plane and its partner, which
is what your visual system resolves. Neither is retouched. Regenerate them from
the demo yourself.

**[Live demo & playground](https://acieshk.github.io/nocap/)**

## Quick start

```
npm i nocap
```

```js
import 'nocap';   // registers <nocap-secret>
```

```html
<nocap-secret id="acct" strength="medium" width="300" height="62"></nocap-secret>
```

```js
// Set it from JS. Putting the value in markup would place it in your HTML
// source, which is the one thing this is for avoiding.
document.getElementById('acct').secret = await fetchAccountNumber();
```

That is the whole API for most uses. It renders as soon as it has a value.

**Pick a strength instead of tuning numbers:**

| `strength` | Reads well at | Trade |
| --- | --- | --- |
| `weak` | 60Hz, comfortably | Easiest to read. A captured frame leaks noticeably more |
| `medium` *(default)* | 60Hz | The balanced point. Start here |
| `strong` | 120Hz+ | Best against a blur. Visibly strobes on a 60Hz panel |

Everything below is for when you need more control. You can ignore it.

### Three things to know before you ship

1. **Check your colours.** A secret is only maskable if its two colours can carry
   noise. `checkPalette({ color, background })` tells you, and the wrong pair
   leaves the value plainly readable in a screenshot. See
   [Choosing colours](https://github.com/acieshk/nocap#choosing-colours).
2. **Check your page.** `await auditPage(secret)` finds the value if your app
   leaked it into an input, an `aria-label`, or `localStorage`.
3. **Read [what this defeats](https://github.com/acieshk/nocap#what-this-defeats-and-what-defeats-it).** A screen
   recording beats it. That is inherent, not a bug.

---

## Using it

### Registering the element

`import 'nocap'` has the side effect of calling `customElements.define`. Import
it once, anywhere that runs in the browser.

```js
import 'nocap';
```

Without a bundler, point a module script at the file directly:

```html
<script type="module" src="https://unpkg.com/nocap/src/index.js"></script>
```

The module is safe to import on a server. It falls back to a plain base class
when `HTMLElement` is absent and only registers once it reaches a browser, so
Next, Astro, Remix and friends will not throw at module scope. Nothing renders
there either, so treat the element as client-only for layout purposes.

### Giving it a value

`secret` is a **property, not an attribute**, and it is write-only.

```js
el.secret = await fetchAccountNumber();
```

Reading it back is not supported, deliberately: a getter would put the value
within reach of anything holding a reference to the element. Keep your own copy
if you need one, and keep it somewhere you have thought about.

Markup works and is read once and erased:

```html
<nocap-secret>4111 1111 1111 1111</nocap-secret>
```

but the value was in your HTML source on the way there, which is the one thing
this library exists to avoid. Use it for a static demo, never for a real secret.

**Restyling does not need the value again.** The element keeps the plaintext for
as long as it is displayed, so changing a colour or a font re-renders from what
it already holds. That is what makes a write-only setter usable. It is also why
the value sits in JS memory for the element's lifetime, which is what `scramble`
exists to blunt.

### Sizing

`width` and `height` are attributes in CSS pixels, not styles.

```html
<nocap-secret width="300" height="62"></nocap-secret>
```

The font is derived from the height, and the noise block is derived from the
font, so the element scales as one piece. Do not size it with CSS `width`:
letting the browser rescale the canvas resamples the noise toward its mean, which
is the one transformation that makes a captured frame readable.

### Styling

```html
<nocap-secret
  color="#6d6d6d" background="#404040"
  font-family="Inter, system-ui, sans-serif"
  font-weight="700"
  font-size="30"          <!-- or font-scale="0.46", the default -->
  letter-spacing="4"      <!-- or "0.1em" -->
  text-align="left"
  padding-x="16"
></nocap-secret>
```

Any value that is not usable falls back to the documented default and warns once
rather than reaching the canvas, because an invalid `ctx.font` or a non-finite
`fillText` coordinate is a silent no-op that would render the wrong thing, or
nothing at all, without an error.

**The colours are not free.** See
[Choosing colours](https://github.com/acieshk/nocap#choosing-colours). A pair
that cannot carry noise cannot be masked at any amplitude.

**`letter-spacing`, `text-align` and `padding-*` do nothing while `scramble` is
on** ([#14](https://github.com/acieshk/nocap/issues/14)). Scramble draws each
glyph into its own cell and places the cells itself, so there is no run of text
to space and no single `fillText` to align. The font attributes do apply. The
element warns when you set one of the inert ones together with `scramble`.

### Accessibility, which is not optional

The value is pixels. It is unreadable to a screen reader **by construction**, and
that is the same property that defeats DOM-reading agents. There is no setting
that makes it accessible without also making it scrapeable.

So an integration has to provide another route, and only you can decide what it
is. A "reveal" button that swaps in real text, a copy-to-clipboard control, a
phone line, a different page. What you must not do is ship this as the only way
to reach the value.

```html
<nocap-secret id="acct" width="300" height="62"></nocap-secret>
<button id="copy">Copy account number</button>
<p class="sr-only" id="hint">Account number is shown as an image. Use the copy
  button to place it on your clipboard.</p>
```

```js
copy.onclick = () => navigator.clipboard.writeText(accountNumber);
```

`scratch` mode additionally needs a pointer, so keyboard and touch users need
that alternative even more.

### React

`secret` is a property, so it cannot be passed as a JSX attribute. Use a ref.

```jsx
import { useEffect, useRef } from 'react';
import 'nocap';

export function Secret({ value, strength = 'medium' }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.secret = value; }, [value]);
  return <nocap-secret ref={ref} strength={strength} width="300" height="62" />;
}
```

React 19 passes unknown props to custom elements as attributes, so `strength`,
`color` and the rest work as written. On React 18 and earlier, set those with a
ref too. If you render on the server, load this component with
`dynamic(..., { ssr: false })` or the equivalent, since it produces nothing
there.

### Vue

```vue
<script setup>
import 'nocap';
import { ref, watchEffect } from 'vue';
const el = ref(null);
const props = defineProps({ value: String });
watchEffect(() => { if (el.value) el.value.secret = props.value; });
</script>

<template>
  <nocap-secret ref="el" strength="medium" width="300" height="62" />
</template>
```

Tell the compiler it is a custom element, or Vue will warn about an unknown
component:

```js
// vite.config.js
vue({ template: { compilerOptions: { isCustomElement: (t) => t === 'nocap-secret' } } })
```

### Svelte

Svelte sets properties on custom elements when it can, so the binding is direct:

```svelte
<script>
  import 'nocap';
  export let value;
</script>

<nocap-secret secret={value} strength="medium" width="300" height="62" />
```

### Checking that it actually worked

Three measurements, all exported, all runnable in your own tests:

```js
import { checkPalette, auditPage } from 'nocap';

// 1. Can these colours carry noise at all?
const pal = checkPalette({ color: '#6d6d6d', background: '#404040' });
if (pal.ratio < 1) console.warn(pal.warnings);

// 2. Did the page leak the value somewhere else?
const report = await auditPage(secret);
if (!report.clean) throw new Error(`leaked in ${report.found.join(', ')}`);

// 3. How much does one captured frame give away? Lower is better.
el.measureLeak();   // ~0.05 at the defaults, 1.0 is fully readable
```

`auditPage` takes the plaintext because it has to search for it, so the value
exists in one more place while the call runs. Development and tests, not a
production render path.

### When it looks wrong

| Symptom | Cause |
| --- | --- |
| Text is plainly readable in a screenshot | Palette cannot carry noise. Run `checkPalette` |
| Heavy strobing, hard to read | 60Hz display with `strength="strong"`. Drop to `medium` or `weak` |
| Colours look lighter than authored | Simultaneous contrast from a darker surround. The split is exact, step your panel between page and secret |
| Blurry or readable after resizing | Sized with CSS instead of the `width` and `height` attributes |
| A style attribute does nothing | Check the console. It warns once for a value it refused, and for styling that is inert under `scramble` |
| Nothing renders at all | `secret` was never set, or set as an attribute rather than a property |

---

## How it works

Content is split into frames that alternate at your display's refresh rate. Each
frame is noise. Their *mean* is the content. Your visual system does the
averaging, so you read it. A single screenshot does not. The text never enters
the DOM, so scrapers and DOM-reading AI agents get nothing at all.

---

## What this defeats, and what defeats it

The claims are narrow on purpose. Read this before building on it | Threat | Result |
| --- | --- |
| Reflexive Print Screen / Win+Shift+S / Cmd+Shift+4 | **Blocked**. The capture lands on one plane |
| DOM-reading AI agents, LLM scrapers, accessibility-tree readers | **Blocked absolutely**. The secret is never a DOM node |
| Single-frame OCR / vision-model ingestion | **Blocked**. One frame is noise |
| View Source, `curl`, Save Page As, Select-All + Copy | **Blocked**. Verified live in the demo |
| Quick phone photo | **Usually blocked**. Short exposure lands on one plane |
| **Screenshot + a box blur** | **Weakened.** Denoising recovers a lot. See the block-size table |
| **Screen recording + temporal averaging** | **Defeated.** `ffmpeg -i cap.mp4 -vf tmix=frames=2 out.mp4` |
| **Burst screenshots** | **Defeated.** Average them, or keep the readable one |
| Casual DevTools poke. Heap search, one-line `fillText` hook | **Slowed** by `scramble`. Yields the glyphs without their order |
| **Anyone with DevTools and intent** | **Defeated.** The canvas must hold the arranged image, so averaging a run of frames recovers it |

The re-encode row is the one with no attacker in it. Per-pixel noise is the most
expensive thing in a frame to encode, so an encoder under a bitrate budget throws
it away and keeps the strokes. The denoise attack, performed for free, by
software nobody asked. Measured on real x264 at screen-share bitrates, worst
decoded frame moved 0.181 → 0.268 against the mean. Weakened, not defeated: 0.27
is still not readable. Treat the exact figure as one run of a noisy statistic,
and probably a lower bound, since a real share starves a small chip of bits far
harder than a test frame that is nothing but noise.

The averaging limit is information-theoretic, not an implementation gap:
**anything your eye can integrate, software can integrate better.** No tuning
fixes it. `averageFrames()` and `denoisedLeak()` ship so you can run both attacks
against your own settings. If you can't, you don't know what you're shipping.

For protection that holds against a determined attacker the mechanism is the
compositor, not the content: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
on Windows, `NSWindow.sharingType = .none` on macOS, `FLAG_SECURE` on Android.
Layer nocap on top of those, never instead. For documents, per-user forensic
watermarking changes behaviour more than any technical speed bump.

## Check your own page

nocap keeps the value out of the DOM. Your integration can still put it back. An `<input>` you kept for editing, an `aria-label` added for accessibility, a
`title`, a debug line in `localStorage`. Every one of those is read instantly by
the scrapers and DOM-reading agents the canvas defeats, and none of them appear
in View Source, so they are easy to miss.

```js
import { auditPage } from 'nocap';

const { clean, found, report } = await auditPage(accountNumber);
console.log(report);
```

```
nocap audit: LEAKED in 1 surface: formValues
  ✓ HTML source (View Source, curl, scrapers)  not found
  ✓ Live DOM (DevTools, most agents)           not found
  ✓ Rendered text (Reader mode, innerText)     not found
  ✓ Select All + Copy                          not found
  ✗ Form control values                        CONTAINS IT
  ✓ Accessible name (aria-label, title, alt)   not found
  ✓ Open shadow roots                          not found
  ✓ localStorage / sessionStorage              not found
  ! Canvas pixels (average a run of frames)    recoverable with DevTools, inherent
```

Same idea as shipping `averageFrames()` and `denoisedLeak()`: those attack the
pixels, this attacks the page around them. Put it in a test so a leak fails CI
rather than being noticed later.

The last row never reports clean. The canvas has to hold the arranged image or
nobody could read it, so a run of frames averaged together is the plaintext, and
no mode changes that.

⚠️ It takes the plaintext, because it has to search for it. So the value exists
in one more place while the call runs. Development and tests, not a production
render path.

## How DevTools defeats it

`scramble` is an optional mode that stores glyphs shuffled with a separate slot
map and paints each back into place. It moves several of these attacks. It does
not move the one that matters | Attack | Default | With `scramble` |
| --- | --- | --- |
| **Average a run of frames off the canvas** | plaintext | **plaintext** |
| Breakpoint on the `secret` setter | plaintext | plaintext |
| Read the element's private fields | plaintext | reconstructable |
| Hook `fillText` on both 2D prototypes | whole secret, one call | glyphs, no order |
| Heap snapshot, search for the string | found | not found |

The first row settles it, and no mode changes it: **the canvas must hold the
correctly-arranged image, or you could not read it either.** A short run of frames averaged
together is the plaintext. Verified live in the demo, which recovers it
identically with and without `scramble`. Scrambling protects how the value sits in JS memory
and does blunt the one-line `fillText` dump, but it is obfuscation, not
encryption. Both the shuffled glyphs and their position map are live fields on
the element, and the setter still receives the plaintext before any of it happens.

A `fillText` hook has to patch **`OffscreenCanvasRenderingContext2D`** as well. Text is rasterised off-screen, so patching only `CanvasRenderingContext2D`
catches nothing and makes the default look safe when it is not.

The real line is **automated pipeline vs. targeted attacker**. nocap defeats the
pipeline and never the person who has decided to come after the value.

## Scope

This library is the display effect and nothing else: split the content, show it,
and tell you honestly how well it is hidden. It deliberately does **not** ship
storage, delivery, encryption, expiry or accounts.

That is not an oversight. Those belong a layer up, and they are where the real
protection lives. The flicker cannot beat a screen recording or DevTools. What
does beat them is making the captured value worthless. A one-time value that
dies on first read turns an unwinnable fight into an economic one.

**The value is unreadable to assistive technology, by construction.** It is a
`<canvas>` inside a closed shadow root: no text node, no accessible name, no
alternative. That is the same property that blocks scrapers and DOM-reading
agents, and it cannot be had selectively. A screen reader is a DOM-reading
agent. Any integration has to provide an accessible route to the value itself.
A copy-to-clipboard control is the usual answer, and it is what people want to
do with an account number anyway.

If you are building that layer, the pieces that pair with this are: encryption
at rest with a key that never touches your server (a passphrase, or a key in the
URL fragment), single-use or short-lived values, per-recipient watermarking, and
on native, `WDA_EXCLUDEFROMCAPTURE` / `FLAG_SECURE`. Which is enforcement
rather than friction. Use nocap for the moment the value is on screen.

## Choosing colours

`color` and `background` **are** the perceived colours. The split runs in linear
light, so what you author is what you see. Verified to within 0.3 code levels
across the range. There is no band, no compression, and no contrast
pre-emphasis. Those existed only to buy uniform noise headroom and linear light
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
obvious metric, correlates −0.06. No better than chance, because light is
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

## Watermarking, experimental

> **Experimental, and narrower than it looks.** It marks a capture for
> attribution. It does not protect the value, and one greyscale conversion
> removes it. Read the limit before enabling it.

```html
<nocap-secret watermark="user-8841"></nocap-secret>
```

Every other mark in this library cancels between the two planes, so the viewer
never resolves one and averaging a run of frames removes it. That is the point
there, and also the limit: an attacker who averages ends up with the clean value.

This one does not cancel. It is composited into the source before the split, so
it is part of what the pair averages to and it survives any number of frames.
**The operation that defeats nocap is the operation that recovers the mark.**
What keeps it off the viewer is not time, it is colour: the mark is isoluminant
with the background, and the eye resolves chrominance far more coarsely than
luminance, worst of all on blue-yellow where the S-cones are sparse and absent
from the foveal centre. Every video codec exploits the same fact when it
subsamples chroma. `chroma: 0` is the default, so the masking noise is grey and
the chrominance dimension was sitting unused.

Put a recipient id in it. A leaked screenshot then says who it came from.

### The limit, stated first

| attacker | mark correlation |
| --- | --- |
| keeps colour | **0.996** |
| `-vf format=gray` | **0.020** |

One filter and it is gone. So this is a **casual-leak watermark, not a forensic
one**: it survives a screenshot into chat, a paste into a doc, an image handed
to a model. It does not survive anyone who knows it is there. If you need
attribution that holds against a determined leaker, that is DCT-domain spread
spectrum and a different project.

Same line the rest of the library draws. Beat the pipeline, never the person.

### It was a decoy first, and that could not work

The original version generated a plausible fake value rather than carrying an
identifier. That cannot work, for a structural reason worth recording: the real
value **must** carry luminance contrast, because a person has to read it, and
the mark **must not**, or the viewer sees it. So the two always render
differently and nobody is confused for a moment. A decoy has to be mistakable
for the content. A watermark only has to be present and attributable, which is a
requirement this mechanism can actually meet.

### Measured

| | |
| --- | --- |
| luminance shift where the mark sits | ~0, isoluminant by construction |
| mark in an averaged frame | 0.77 at swing 20, 0.996 at swing 90 |
| survives H.264 4:2:0 at screen-share bitrate | 0.917 |
| effect on the real value's single-plane leak | none, 0.132 either way |

The codec result is the surprising one. 4:2:0 subsamples chroma 2x2 and a
chroma-only payload is the first thing an encoder discards, so it should not
survive. The glyphs are coarse enough that it does.

`watermark-swing` sets how far the mark moves, default 60. The swing is reduced
near the edge of the gamut rather than clipped, since clipping a channel breaks
isoluminance silently. `watermark-repeat` sets how many times it is drawn,
default 3, scattered across the value rather than on a clear row, because a mark
on its own row is trivially cropped out.

Verified in Chrome on the rendered element, not only on the arrays:

| | mark band | rest of the element |
| --- | --- | --- |
| chrominance variation | **16.6** | 6.0 |
| luminance variation | **5.1** | 16.1 |

The mark sits in chrominance and carries almost no luminance. The real value is
the opposite. That is the whole mechanism, measured end to end.

**Isoluminant is not invisible.** Equiluminant text is a well-known case of
something visible but hard to localise and hard to focus. Expect a faint tint,
and decide on your own content whether it is tolerable.

## Fake values. Experimental

> **Experimental.** It works, and the trade that used to make it marginal is
> gone (see below), but it has had far less use than the rest of the library.
> Verify it on your own content.


Noise tells an attacker the capture failed, so they take another. A value in the
right shape does not.

```html
<nocap-secret fake="auto"></nocap-secret>
```

**Each cycle carries a different decoy**, added on one of its two frames and
subtracted on the other. Two consequences:

- **The viewer never resolves any of them.** The pair cancels inside a single
  cycle. About 16ms at 60Hz. So it is gone well within the 50-100ms your eye
  integrates over.
- **A capture freezes one.** A screenshot cannot average, so it catches a single
  frame and a single decoy, in the right format, at full contrast. The rotation
  holds eight, so a burst lands on different ones.

### The trade that used to limit this is gone

The decoy used to be sized from the *residual* headroom the noise left, which
varies per pixel, so its contrast was modulated by the noise and a capture came
away with texture rather than a glyph. Pushing harder clipped, and a clipped
push no longer cancels, so it ghosted into the mean. That looked like a hard
tension between blending and legibility.

It was not. The push was being applied in **code** space around a fixed centre,
which preserves the code-space mean but not the mean in *light*. Widening a
pair raises its mean light, even with nothing clipping. Giving the decoy a fixed
budget and then re-solving the centre for the widened pair removes it. The
budget is capped per pixel by what that pixel can actually reach, because the
reachable band narrows as the pair widens. A constant budget goes infeasible for
dark pixels and the shortfall reappears as lift.

Measured, worst perceived lift from enabling `fake`: **53 levels before, 0
after**, with the decoy legible in a captured frame.

Found by @ithiria894 in #5.

**The pair has to sit inside one cycle**, and this is the subtle part. An earlier
version split each pair one cycle apart, which cancels only over the full
16-frame rotation. 267ms, far longer than the eye's window. The result inverted
the whole effect: the decoys stayed visible and the noise averaged away. Two
other failures cost a rebuild each, both visible only in a rendered frame:
alternating signs over *different* strings does not cancel, it leaves the
difference of their glyph coverage as a smear. And flipping the line and the sign
together re-correlates them and makes it worse.

`detectFormat()` classifies ISO and d/m/y dates, card expiries, card numbers,
grouped numbers, phone numbers, alphanumerics and free text; `fakeLike()`
generates the decoy in `auto` / `number` / `text` / `random`. The shape always
matches the source exactly. Same length, separators, digit/letter/case pattern. Because a wrong-shaped decoy reveals the mechanism and is worse than noise. Auto
mode is semantic too: fake dates have real months, fake card numbers pass Luhn.

```
4471-0092-8834   grouped number, 12 digits   2206-9276-8289  6943-2162-7081 ...
2026-09-01       ISO date                    2024-02-15
4539578763621486 16-digit card number        4638875219028443
```

Decoys are driven from the mean of the plane pair at full headroom, so they
replace the noise where their ink falls rather than competing with it, and they
never clip or shift the perceived value. Each gets its own random position and
size, scattered across the field rather than stacked on fixed lines. The spot
belongs to the decoy rather than to the appearance, so the added and subtracted
copies still land on exactly the same pixels and cancel.

## `<nocap-secret>`

| Attribute | Default | Meaning |
| --- | --- | --- |
| `scramble` | off | Store glyphs shuffled. See the DevTools table |
| `fake` | off | **Experimental.** `auto` / `number` / `text` / `random`. Needs masking ratio 1.0+ |
| `strength` | `medium` | `weak` / `medium` / `strong`. Sets amplitude, block and hardness together |
| `amplitude` | `110` | Fraction of the headroom the colours allow |
| `noise-scale` | `6 × dpr` | Noise block in device px. Higher resists blur, strobes below 120Hz |
| `gamma` | `2.4` | Display EOTF. Measure yours with the calibration demo |
| `frames` | `2` | Planes per cycle. 2 is almost always right |
| `contrast` | `1` | Pre-emphasis. Not needed under linear light, which does not compress |
| `chroma` | `0` | 0 = grey noise, 1 = independent per channel |
| `hardness` | `1` | 1 slams every pixel to ±amplitude. Lower keeps noise near the background |
| `color` / `background` | `#9ea6b4` / `#6b7280` | Authored palette. Must be maskable. See below |
| `adaptive` | off | Exact colours, amplitude capped to their headroom |
| `scratch` | off | **Experimental.** Unmask only a trail under the pointer |
| `scratch-linger` | `30` | Seconds for a trail to fade to 1%. See the note below |
| `scratch-radius` | `34` | Brush radius in CSS px |
| `width` / `height` | `260` / `56` | CSS pixels |

**`scratch-linger` is the trade, not a cosmetic.** A pixel carries the value
only while the trail sits on it, so with a short trail a long capture averages
to about `duty × value` while the noise keeps its full amplitude. Over 30
frames that is leak 0.70 at full duty against 0.25 at a duty of 0.1, and a
clean 0.9 needs 34s of recording rather than 4.3s.

The 30s default gives most of that up on purpose, because a trail that fades in
a second is close to unreadable. A trail that outlasts the reading sits near
full duty, so treat the default as a gate on when the value appears rather than
as a defence against capture. Set it to a second or two if capture is the
threat you care about.

It also needs a pointer, so any integration has to offer keyboard and screen
reader users another route.

Properties: `.secret` (write-only), `.revealed`, `.refreshHz`, `.render()`,
`.stop()`, `.measureLeak()`. Events: `render`, `stop`.

**It renders as soon as it has a value.** Hold-to-reveal, click-to-toggle,
auto-hide on blur. Those are product decisions, not part of the effect, so they
are deliberately absent. Wire them up around the element with `render()` and
`stop()`.

**Set `.secret` from JS.** Putting the text in markup works. It is read once and
erased from the DOM. But it was in the HTML source on the way there, which
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
and `decoy`. Included so `leakScore` can show you why they do not:

| Split | Single-plane leak |
| --- | --- |
| `channels`. RGB split across planes | 1.000 |
| `decoy`. Second image as modulator | 0.929 |
| `interleave` ×2. Pixels split across planes | 0.693 |
| `amplitude` 64 | 0.386 |
| `amplitude` 96 | 0.137 |
| `amplitude` 127 | 0.004 |

Measured on a structured test image with `leakScore`. Raw, with no denoising.
See the block-size table above for numbers with a blur attack allowed. They are
considerably worse, and that is the honest number to design against.

**Splitting *where* pixels are does nothing. Only randomizing *what they say*
works.** Recognition survives losing colour, losing 90% of pixels, blur and
quantization, so channel splitting and pixel interleaving both leak badly.
Interleave only becomes safe once stacked noise carries it. At which point the
interleaving contributed nothing. Noise amplitude is the only lever. Frame count
is not a substitute.

Render at exact device pixels. `resize(cssW, cssH)` handles `devicePixelRatio`. If CSS rescales the canvas the noise blurs toward its mean and the content
becomes readable in a *single* frame. A silent, total failure.

## Safety

Noise is per-pixel and zero-mean, so **every frame carries the same local mean
luminance as the source**. The alternation is a high-spatial-frequency contrast
reversal, not a full-field flash. The mechanism 6-bit panels use for FRC
dithering. That keeps it out of the large-area-flash regime WCAG 2.3.1 targets.

It is still moving high-contrast content, and **the element starts as soon as it
has a value and does not stop on its own**. There is no `hold` or `auto-hide`
here. Those are product decisions (see Scope). So gating the reveal, bounding
how long it runs, and offering an opt-out are your responsibility. `stop()` is
the hook.

`prefers-reduced-motion: reduce` is honoured: the element shows the perceived
mean statically instead of alternating, and warns to the console that there is
no masking in that mode. Below ~120Hz the shimmer is clearly visible, and the
library warns below 100Hz measured refresh.

This argument has not had a real accessibility review. It reads plausibly. Contrast reversal rather than full-field flash, small area, zero-mean per frame. But plausible is not assessed. Get one before shipping this anywhere public.

## Demo

Live: **<https://acieshk.github.io/nocap/>**. Or `npm run demo`, then
<http://127.0.0.1:8787/>.

| Page | What is on it |
| --- | --- |
| [Overview](https://acieshk.github.io/nocap/) | The live, screenshot and denoise comparison, and the threat table |
| [Sandbox](https://acieshk.github.io/nocap/sandbox.html) | Every setting on a real element, with masking and leak measured as you change them |
| [Security check](https://acieshk.github.io/nocap/security.html) | A fresh secret each load, no text box anywhere, searched for across every readable surface |
| [Scratch to reveal](https://acieshk.github.io/nocap/scratch.html) | The trail, and what its length costs |
| [Fake value](https://acieshk.github.io/nocap/fake.html) | Decoys, and why the budget does not stretch |

**The security page has no text box, on purpose.** Every other page lets you type
a value, which is convenient and quietly ruins the test: a value you typed lives
in `input.value`, and that is a leaky surface of its own. The audit would
correctly report a leak, the leak would be the demo's own text box, and a check
that always fails for a reason you have to explain away is not evidence. So that
page generates its own secret with `fakeLike()`, hands it straight to the
element, and never writes it anywhere else. Reload for a different format.

## Test

```
npm test
```

65 tests: the planes average back to the source at every amplitude and mode, no
plane leaks, clipping never breaks the zero-sum property, the leak ordering
holds, adaptive colour is exact, coarse blocks resist a blur that fine noise does
not, a scratch trail lasts the same wall-clock time at any frame rate, and every
attribute value that is not usable falls back to its documented default rather
than reaching the canvas.

## License

MIT
