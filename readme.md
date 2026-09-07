# capture-page

A modern Puppeteer screenshot utility for URLs, local files and inline HTML. It is designed for ordinary pages and renderer-heavy applications such as Three.js/WebGL/WebGPU scenes.

## Install

```sh
bun add capture-page
```

Chrome, Chromium or another supported browser must be available. `puppeteer` is included as the browser-control dependency; Sass is optional and only loaded when Sass/SCSS styles are used.

## Basic use

```ts
import capturePage from 'capture-page'

const {buffer, passedTime} = await capturePage('https://example.com', {
  width: 1440,
  height: 900,
})

await Bun.write('page.png', buffer)
console.log(`captured in ${Math.round(passedTime)} ms`)
```

Save directly and infer the image type from the extension:

```ts
await capturePage.save(
  'https://example.com',
  'screenshots/page.webp',
  {quality: 90},
)
```

`capturePage.save()` creates missing parent directories. `.png`, `.jpg`, `.jpeg` and `.webp` are recognized case-insensitively. An explicit `format` overrides extension inference.

## Targets

```ts
await capturePage(new URL('https://example.com'))

await capturePage({html: '<h1>Hello</h1>'})

// Existing string paths are also recognized.
await capturePage('./fixtures/page.html')

// Explicit file targets are unambiguous and resolve relative assets through file://.
await capturePage({path: './fixtures/page.html'})

// Raw HTML strings beginning with "<" are accepted for compatibility.
await capturePage('<main>Hello</main>')
```

Schemeless host-like strings such as `localhost:3000` and `example.com/page` are normalized to HTTP URLs.

## Renderer-aware waiting

The special `wait: 'three'` rule means “wait for meaningful visible canvas output”, not merely “wait until a canvas exists” or “wait until some draw call happened.”

```ts
await capturePage('https://example.com/three-scene', {
  wait: 'three',
})
```

The detector intentionally avoids forcing `preserveDrawingBuffer`, disabling the GPU or switching to software rendering. It combines three independent strategies:

1. **Transient WebGL observation.** `getContext()` wrapped without changing its arguments. Once the native browser returns a WebGL/WebGL2 context, only that context instance is instrumented. Draws to the default framebuffer are sparsely sampled in a microtask while the normal transient drawing buffer is still readable.
2. **Direct canvas snapshots.** Visible canvases are sampled through `toDataURL()` when the browser/renderer permits it. This can also cover WebGPU canvases.
3. **Compositor fallback.** When direct canvas readback is unavailable or tainted, capture-page screenshots the visible canvas rectangle through the browser compositor and analyzes the resulting pixels.

The visual paths require repeated nonuniform evidence rather than a nonempty image or one nonzero pixel. Uniform clear frames and blank canvases therefore do not count as ready.

This remains a heuristic. A loading animation can be visually meaningful before the application is semantically ready, tiny scenes can fall between sample points and cross-origin/iframe/offscreen rendering has additional constraints. Combine renderer readiness with application-specific signals when available.

### Slop Gallery

The live test covers the render-heavy Slop Gallery fixture:

```ts
await capturePage.save(
  'https://gpt.slop-gallery.mage.build?ai=false',
  'slop-gallery.png',
  {
    width: 1920,
    height: 1080,
    timeout: 90_000,
    wait: {
      count: 'all',
      rules: ['three', 'networkidle2'],
    },
  },
)
```

No Slop Gallery-specific globals or private APIs are used.

## Wait rules

Lifecycle rules:

```ts
wait: 'load'
wait: 'domcontentloaded'
wait: 'networkidle0'
wait: 'networkidle2'
```

Multiple lifecycle events can be grouped into one rule:

```ts
wait: ['load', 'networkidle0']
```

Wait for a visible selector:

```ts
wait: {selector: '#ready'}
```

Wait for attachment rather than visibility:

```ts
wait: {selector: '#ready', visible: false}
```

Quorum waits count only successful rules:

```ts
wait: {
  count: 2,
  rules: [
    'networkidle2',
    'three',
    {selector: '#ready'},
  ],
}
```

`count: 1` means “any”, a larger integer means exactly that many successful rules are required and `count: 'all'` requires every rule. Once the quorum is reached, losing waits are aborted. If enough rules fail that the requested quorum becomes impossible, the call rejects immediately rather than counting failures as success.

The default remains `networkidle2` for compatibility with the original package.

## Hooks

Hooks run after navigation, media/body/style setup and **before readiness waits**:

```ts
await capturePage(url, {
  hook: async page => {
    await page.click('#start')
  },
  wait: {selector: '#finished'},
})
```

This lets readiness depend on changes made by the hook.

## Styles

Raw CSS:

```ts
style: 'body { background: #eee; }'
```

Explicit CSS or Sass:

```ts
style: [
  {type: 'css', code: 'h1 { color: red; }'},
  {type: 'sass', code: '$gap: 24px; main { padding: $gap; }'},
]
```

Structured styles:

```ts
style: {
  type: 'style',
  content: {
    rule: ['1', '.title'],
    properties: {
      fontSize: '48px',
      '--accent': '#284',
    },
  },
}
```

The legacy `{content, type?: 'css' | 'sass'}` form remains accepted.

Sass is loaded dynamically from the optional `sass` dependency. CSS numeric values are emitted literally; include units yourself where CSS requires them.

Set `normalizeCss: true` to inject a small modern normalization before user styles.

## Body handling

The original `background` API remains valid:

```ts
body: {
  background: '#f7f4ec',
  when: 'auto',
}
```

The richer style form is also supported:

```ts
body: {
  when: 'auto',
  style: {
    backgroundColor: '#f7f4ec',
    margin: 0,
  },
}
```

A string `style` os interpreted as a background value.

Browsers normalize parsed HTML into `html`, `head` and `body` elements. Therefore `body: false` means “do not let capture-page modify the body”, not “force Chromium to preserve a body-less DOM.”

## Media emulation

```ts
await capturePage(url, {
  colorScheme: 'dark',
  motion: 'reduced',
  mediaType: 'print',
})
```

On Chromium these values are applied together through one CDP media command so setting the media type does not clear the preference features or vice versa. Other browsers fall back to Puppeteer's high-level emulation methods.

## Viewport and screenshot options

| Option | Default |
| --- | --- |
 `width` | `1920` |
 `height` | `1080` |
 `deviceScaleFactor` | `1` |
 `format` | `'png'` |
 `fullPage` | `false` |
 `omitBackground` | `false` |
 `delay` | `0` |
 `timeout` | `30000` |
 `colorScheme` | `'light'` |
 `motion` | `'no-preference'` |
 `mediaType` | `'screen'` |
 `wait` | `'networkidle2'` |

@quality` is available for JPEG/WebP and must be an integer from 0–100.

## Browser selection and reuse

Use an executable path or an ordered list:

```ts
await capturePage(url, {
  browser: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ],
})
```

Without an explicit browser, capture-page prefers system Chrome/Chromium/Edge, then falls back to Puppeteer's downloaded browser when available.

A successful process launch is not enough to prove a browser is usable for screenshots. Each newly encountered executable receives a tiny one-time screenshot health probe; if it launches but cannot capture, the next candidate is tried.

You can also supply an existing Puppeteer `Browser`. capture-page creates an isolated `BrowserContext` for the capture and leaves your browser running:

```ts
import puppeteer from 'puppeteer'
import capturePage from 'capture-page'

const browser = await puppeteer.launch()

try {
  await capturePage('https://example.com/a', {browser})
  await capturePage('https://example.com/b', {browser})
} finally {
  await browser.close()
}
```

This avoids paying browser startup cost for bulk work while preserving per-capture context isolation.

## Browser sandbox

The browser sandbox is enabled by default. In an already isolated root-run container where Chromium cannot start sandboxed, opt out explicitly:

```ts
await capturePage(url, {
  sandbox: false,
})
```

Do not disable the sandbox indiscriminately for untrusted pages. A screenshot service also needs its own network/security policy; capture-page is not an SSRF boundary.

## Development

```sh
bun install --frozen-lockfile
bun run lint
bunx --bun eslint .
bun run test
bun run test_live
bun run build
bun run build_dev
```

The normal suite is local/offline apart from browser startup. `test_live` also captures Slop Gallery. Production builds keep packages external instead of bundling Puppeteer into the library output.
