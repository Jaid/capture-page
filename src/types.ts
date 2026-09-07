import type {Browser, Page, PuppeteerLifeCycleEvent, ScreenshotOptions} from 'puppeteer'

export type Arrayable<T> = Array<T> | T

export type UrlTarget = URL | string

export type FileTarget = {
  path: string
}

export type HtmlTarget = {
  html: string
}

export type Target = FileTarget | HtmlTarget | UrlTarget

export type Format = NonNullable<ScreenshotOptions['type']>

export type StyleProperties = Record<string, number | string>

export type BodyBehavior = 'auto' | boolean

export type Body = {
  /** Legacy alias for a background color. */
  background?: string
  /** A background color string or CSS declaration object. */
  style?: StyleProperties | string
  /** @default 'auto' */
  when?: BodyBehavior
}

/** Legacy style shape retained for compatibility. */
export type StyleCode = {
  content: string
  type?: 'css' | 'sass'
}

export type CssCode = {
  code: string
  type: 'css'
}

export type SassCode = {
  code: string
  type: 'sass'
}

export type StyleObject = {
  content: Arrayable<{
    properties: StyleProperties
    rule: Arrayable<string>
  }>
  type: 'style'
}

export type Style = CssCode | SassCode | StyleCode | StyleObject | string

export type SelectorWait = {
  selector: string
  /** @default true */
  visible?: boolean
}

export type WaitEvent = Array<PuppeteerLifeCycleEvent> | PuppeteerLifeCycleEvent | SelectorWait | 'three'

export type WaitBehavior = WaitEvent | {
  /** Number of successful rules required, or all rules. */
  count: 'all' | number
  rules: Array<WaitEvent>
}

export type Options = {
  /** Additional launch arguments when capture-page launches the browser. */
  args?: Array<string>
  /** Controls whether capture-page ensures/styles the parsed document body. */
  body?: Body | BodyBehavior
  /** Browser instance, executable/name, or executables/names to try in order. */
  browser?: Arrayable<string> | Browser
  /** @default 'light' */
  colorScheme?: 'dark' | 'light'
  /** Additional delay after readiness and font loading, in milliseconds. @default 0 */
  delay?: number
  /** @default 1 */
  deviceScaleFactor?: number
  /** Output image format. @default 'png' */
  format?: Format
  /** Capture the entire scrollable page. @default false */
  fullPage?: boolean
  /** @default 1080 */
  height?: number
  /** Runs after navigation and style/body setup, before readiness waits. */
  hook?: (page: Page) => Promise<void> | void
  /** @default 'screen' */
  mediaType?: 'print' | 'screen'
  /** @default 'no-preference' */
  motion?: 'no-preference' | 'reduced'
  /** Apply a small modern CSS normalization before user styles. @default false */
  normalizeCss?: boolean
  /** Preserve transparent page backgrounds where supported. @default false */
  omitBackground?: boolean
  /** JPEG/WebP quality from 0–100. */
  quality?: number
  /** Keep Chromium's sandbox enabled. Set false only in an isolated environment. @default true */
  sandbox?: boolean
  /** CSS, Sass/SCSS or structured style injections. */
  style?: Arrayable<Style>
  /** Timeout for launch, navigation and each readiness operation, in milliseconds. @default 30000 */
  timeout?: number
  /** @default 'networkidle2' */
  wait?: WaitBehavior
  /** @default 1920 */
  width?: number
}

export type Result = {
  buffer: Buffer
  /** Elapsed milliseconds through screenshot creation. */
  passedTime: number
}
