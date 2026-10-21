import type {Format, Options, Result, Target} from './types.ts'
import type {Page, ScreenshotOptions} from 'puppeteer-core'

import path from 'node:path'

import fs from 'fs-extra'

import {acquireBrowser, releaseBrowser} from './browser.ts'
import {prepareDownload} from './download.ts'
import {installRenderProbe} from './render.ts'
import {applyBody, injectStyles} from './style.ts'
import {injectPreloadScript, navigate, normalizeTarget} from './target.ts'
import {runToolCalls} from './toolCalls.ts'
import {includesThreeWait, waitForFonts, waitForReadiness} from './wait.ts'

const DEFAULT_TIMEOUT = 30_000
const inferFormat = (outputFile: string): Format | undefined => {
  const extension = path.extname(outputFile).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'jpeg'
  }
  if (extension === '.png') {
    return 'png'
  }
  if (extension === '.webp') {
    return 'webp'
  }
}
const validateOptions = (options: Options) => {
  const width = options.width ?? 1920
  const height = options.height ?? 1080
  const timeout = options.timeout ?? DEFAULT_TIMEOUT
  const deviceScaleFactor = options.deviceScaleFactor ?? 1
  const delay = options.delay ?? 0
  for (const [name, value] of Object.entries({
    height,
    timeout,
    width,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer.`)
    }
  }
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
    throw new RangeError('deviceScaleFactor must be a positive number.')
  }
  if (!Number.isFinite(delay) || delay < 0) {
    throw new RangeError('delay must be a nonnegative number.')
  }
  for (const call of options.toolCalls ?? []) {
    if (typeof call.name !== 'string' || !call.name) {
      throw new TypeError('Every tool call needs a name.')
    }
  }
  if (options.quality !== undefined) {
    if (!Number.isSafeInteger(options.quality) || options.quality < 0 || options.quality > 100) {
      throw new RangeError('quality must be an integer from 0 to 100.')
    }
    const format = options.format ?? 'png'
    if (format === 'png') {
      throw new TypeError('quality is only supported for JPEG and WebP.')
    }
  }
  return {
    delay,
    deviceScaleFactor,
    height,
    timeout,
    width,
  }
}
const applyMedia = async (page: Page, options: Options) => {
  const media = options.mediaType ?? 'screen'
  const features = [
    {
      name: 'prefers-color-scheme',
      value: options.colorScheme ?? 'light',
    },
    {
      name: 'prefers-reduced-motion',
      value: options.motion === 'reduced' ? 'reduce' : 'no-preference',
    },
  ]
  try {
    const session = await page.createCDPSession()
    await session.send('Emulation.setEmulatedMedia', {
      features,
      media,
    })
  } catch {
    await page.emulateMediaType(media)
    await page.emulateMediaFeatures(features)
  }
}
/** Headless Chromium only exposes `document.modelContext` with the WebMCP feature. */
const withWebmcp = (args: Array<string> = []) => {
  const index = args.findIndex(arg => arg.startsWith('--enable-features='))
  if (index === -1) {
    return [...args, '--enable-features=WebMCP']
  }
  return args.with(index, `${args[index]},WebMCP`)
}
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

type CapturePage = {
  (target: Target, options?: Options): Promise<Result>
  save: (target: Target, outputFile: string, options?: Options) => Promise<Result>
}

const capturePage = (async (target: Target, options: Options = {}) => {
  const startedAt = performance.now()
  const validated = validateOptions(options)
  const normalizedTarget = await normalizeTarget(target)
  const lease = await acquireBrowser(options.browser, {
    args: options.toolCalls?.length ? withWebmcp(options.args) : options.args,
    sandbox: options.sandbox,
    timeout: validated.timeout,
  })
  let context: Awaited<ReturnType<typeof lease.browser.createBrowserContext>> | undefined
  let download: Awaited<ReturnType<typeof prepareDownload>> | undefined
  try {
    context = await lease.browser.createBrowserContext()
    if (options.capture === 'download') {
      download = await prepareDownload(lease.browser, context, validated.timeout)
    }
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(validated.timeout)
    page.setDefaultTimeout(validated.timeout)
    await page.setViewport({
      deviceScaleFactor: validated.deviceScaleFactor,
      height: validated.height,
      width: validated.width,
    })
    await applyMedia(page, options)
    let navigationTarget = normalizedTarget
    if (includesThreeWait(options.wait)) {
      if (normalizedTarget.kind === 'html') {
        const source = `(${installRenderProbe.toString()})()`
        navigationTarget = {
          ...normalizedTarget,
          value: injectPreloadScript(normalizedTarget.value, source),
        }
      } else {
        await page.evaluateOnNewDocument(installRenderProbe)
      }
    }
    await navigate(page, navigationTarget, validated.timeout)
    await injectStyles(page, options)
    await applyBody(page, options.body)
    if (options.hook) {
      await options.hook(page)
    }
    await waitForReadiness(page, options.wait, validated.timeout)
    await waitForFonts(page, validated.timeout)
    if (validated.delay) {
      await sleep(validated.delay)
    }
    const toolResults = options.toolCalls?.length ? await runToolCalls(page, options.toolCalls, validated.timeout) : []
    if (download) {
      const {buffer, suggestedFilename} = await download.wait()
      return {
        buffer,
        passedTime: performance.now() - startedAt,
        suggestedFilename,
        toolResults,
      }
    }
    const screenshotOptions: ScreenshotOptions = {
      captureBeyondViewport: options.fullPage ?? false,
      fullPage: options.fullPage ?? false,
      omitBackground: options.omitBackground,
      type: options.format ?? 'png',
    }
    if (options.quality !== undefined) {
      screenshotOptions.quality = options.quality
    }
    const screenshot = await page.screenshot(screenshotOptions)
    return {
      buffer: Buffer.from(screenshot),
      passedTime: performance.now() - startedAt,
      toolResults,
    }
  } finally {
    await download?.dispose()
    await context?.close().catch(() => {})
    await releaseBrowser(lease)
  }
}) as CapturePage
capturePage.save = async (target, outputFile, options = {}) => {
  // A download is stored as the page produced it, whatever the extension.
  const format = options.capture === 'download' ? options.format : options.format ?? inferFormat(outputFile)
  if (!format && options.capture !== 'download') {
    throw new TypeError('Cannot infer screenshot format from output file extension. Supply options.format.')
  }
  const result = await capturePage(target, {
    ...options,
    format,
  })
  const absolute = path.resolve(outputFile)
  await fs.mkdir(path.dirname(absolute), {recursive: true})
  await fs.writeFile(absolute, result.buffer)
  return result
}

export type {
  Arrayable,
  Body,
  BodyBehavior,
  Capture,
  CssCode,
  FileTarget,
  Format,
  HtmlTarget,
  Options,
  Result,
  SassCode,
  SelectorWait,
  Style,
  StyleCode,
  StyleObject,
  StyleProperties,
  Target,
  ToolCall,
  UrlTarget,
  WaitBehavior,
  WaitEvent,
} from './types.ts'

export default capturePage
