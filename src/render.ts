import type {Page} from 'puppeteer'

type ProbeState = {
  contexts: number
  meaningfulFrames: number
  ready: boolean
  version: 1
}

type PixelStats = {
  distinctColors: number
  luminanceRange: number
  variance: number
  visibleFraction: number
}

type CanvasInspection = {
  canvasCount: number
  meaningful: boolean
  stats?: PixelStats
}

const isMeaningfulStats = ({distinctColors, luminanceRange, variance, visibleFraction}: PixelStats) => {
  return visibleFraction > 0.08 && distinctColors >= 4 && luminanceRange >= 6 && variance >= 3
}

/**
 * Runs inside the page before application scripts. It observes real WebGL
 * default-framebuffer draws without changing context attributes such as
 * preserveDrawingBuffer.
 */
export function installRenderProbe() {
  const world = globalThis as typeof globalThis & {capturePageRenderProbe?: ProbeState}
  if (world.capturePageRenderProbe?.version === 1) {
    return
  }
  const state: ProbeState = {
    contexts: 0,
    meaningfulFrames: 0,
    ready: false,
    version: 1,
  }
  Object.defineProperty(world, 'capturePageRenderProbe', {
    configurable: true,
    value: state,
  })

  type Gl = WebGL2RenderingContext | WebGLRenderingContext
  const tracked = new WeakSet<Gl>
  const queued = new WeakSet<Gl>
  const isVisibleCanvas = (canvas: HTMLCanvasElement) => {
    if (!canvas.isConnected) {
      return false
    }
    const rectangle = canvas.getBoundingClientRect()
    if (rectangle.width < 2 || rectangle.height < 2) {
      return false
    }
    if (rectangle.bottom <= 0 || rectangle.right <= 0 || rectangle.top >= innerHeight || rectangle.left >= innerWidth) {
      return false
    }
    const style = getComputedStyle(canvas)
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
  }
  const hasDefaultFramebuffer = (gl: Gl) => {
    if ('DRAW_FRAMEBUFFER_BINDING' in gl && gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null) {
      return false
    }
    return gl.getParameter(gl.FRAMEBUFFER_BINDING) === null
  }
  const canReadPixels = (gl: Gl) => {
    if (!hasDefaultFramebuffer(gl) || gl.isContextLost() || !gl.drawingBufferWidth || !gl.drawingBufferHeight) {
      return false
    }
    if ('READ_FRAMEBUFFER_BINDING' in gl && gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) !== null) {
      return false
    }
    if ('PIXEL_PACK_BUFFER_BINDING' in gl && gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) !== null) {
      return false
    }
    return true
  }
  const inspect = (gl: Gl) => {
    queued.delete(gl)
    if (state.ready || !canReadPixels(gl)) {
      return
    }
    const canvas = gl.canvas
    if (!(canvas instanceof HTMLCanvasElement) || !isVisibleCanvas(canvas)) {
      return
    }
    const pixel = new Uint8Array(4)
    let first: [number, number, number] | undefined
    let contrast = 0
    let opaque = 0
    try {
      for (let y = 1; y <= 5; y++) {
        for (let x = 1; x <= 5; x++) {
          gl.readPixels(Math.floor(gl.drawingBufferWidth * x / 6), Math.floor(gl.drawingBufferHeight * y / 6), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          if (pixel[3] <= 4) {
            continue
          }
          opaque++
          first ??= [pixel[0], pixel[1], pixel[2]]
          contrast = Math.max(contrast, Math.abs(pixel[0] - first[0]), Math.abs(pixel[1] - first[1]), Math.abs(pixel[2] - first[2]))
        }
      }
    } catch {
      return
    }
    if (opaque < 2 || contrast < 4) {
      return
    }
    state.meaningfulFrames++
    setTimeout(() => {
      if (isVisibleCanvas(canvas) && !gl.isContextLost()) {
        state.ready = true
      }
    }, 250)
  }
  const instrument = (gl: Gl) => {
    if (tracked.has(gl)) {
      return
    }
    tracked.add(gl)
    state.contexts++
    const methods = gl as unknown as Record<string, ((...args: Array<unknown>) => unknown) | undefined>
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'blitFramebuffer']) {
      const original = methods[name]
      if (!original) {
        continue
      }
      methods[name] = function (...args: Array<unknown>) {
        const result = Reflect.apply(original, gl, args)
        if (!state.ready && !queued.has(gl) && hasDefaultFramebuffer(gl)) {
          queued.add(gl)
          queueMicrotask(() => inspect(gl))
        }
        return result
      }
    }
  }
  const canvasPrototype = HTMLCanvasElement.prototype as unknown as Record<string, ((...args: Array<unknown>) => unknown) | undefined>
  const originalGetContext = canvasPrototype.getContext
  if (!originalGetContext) {
    return
  }
  canvasPrototype.getContext = function (this: HTMLCanvasElement, ...args: Array<unknown>) {
    const context = Reflect.apply(originalGetContext, this, args)
    const type = args[0]
    if (
      typeof type === 'string'
      && /^(?:experimental-webgl|webgl2?)$/iu.test(type)
      && typeof context === 'object'
      && context !== null
      && 'readPixels' in context
    ) {
      instrument(context as Gl)
    }
    return context
  }
}

const readProbeState = () => {
  return (globalThis as typeof globalThis & {capturePageRenderProbe?: ProbeState}).capturePageRenderProbe
}
const inspectDirectCanvases = async (): Promise<CanvasInspection> => {
  const canvases = [...document.querySelectorAll('canvas')].filter(canvas => {
    const rectangle = canvas.getBoundingClientRect()
    const style = getComputedStyle(canvas)
    return canvas.width > 1 && canvas.height > 1 && rectangle.width > 1 && rectangle.height > 1 && rectangle.bottom > 0 && rectangle.right > 0 && rectangle.top < innerHeight && rectangle.left < innerWidth && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
  })
  const analyze = (data: Uint8ClampedArray): PixelStats => {
    const colors = new Set<number>
    let visible = 0
    let minimum = 255
    let maximum = 0
    let sum = 0
    let squares = 0
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3]
      if (alpha <= 4) {
        continue
      }
      const red = data[index]
      const green = data[index + 1]
      const blue = data[index + 2]
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
      visible++
      minimum = Math.min(minimum, luminance)
      maximum = Math.max(maximum, luminance)
      sum += luminance
      squares += luminance * luminance
      colors.add(red >> 4 << 8 | green >> 4 << 4 | blue >> 4)
    }
    const total = data.length / 4
    const mean = visible ? sum / visible : 0
    return {
      distinctColors: colors.size,
      luminanceRange: visible ? maximum - minimum : 0,
      variance: visible ? Math.max(0, squares / visible - mean * mean) : 0,
      visibleFraction: total ? visible / total : 0,
    }
  }
  let best: PixelStats | undefined
  for (const canvas of canvases) {
    let source: string
    try {
      source = canvas.toDataURL('image/png')
    } catch {
      continue
    }
    if (!source || source === 'data:,') {
      continue
    }
    const image = new Image
    image.src = source
    try {
      await image.decode()
    } catch {
      continue
    }
    const sample = document.createElement('canvas')
    sample.width = 48
    sample.height = 48
    const context = sample.getContext('2d', {willReadFrequently: true})
    if (!context) {
      continue
    }
    context.drawImage(image, 0, 0, 48, 48)
    const stats = analyze(context.getImageData(0, 0, 48, 48).data)
    if (!best || stats.variance > best.variance) {
      best = stats
    }
    if (isMeaningfulStats(stats)) {
      return {
        canvasCount: canvases.length,
        meaningful: true,
        stats,
      }
    }
  }
  return {
    canvasCount: canvases.length,
    meaningful: false,
    stats: best,
  }
}
const visibleCanvasRectangles = () => {
  return [...document.querySelectorAll('canvas')].flatMap(canvas => {
    const rectangle = canvas.getBoundingClientRect()
    const style = getComputedStyle(canvas)
    if (canvas.width < 2 || canvas.height < 2 || rectangle.width < 2 || rectangle.height < 2 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0) {
      return []
    }
    const left = Math.max(0, rectangle.left)
    const top = Math.max(0, rectangle.top)
    const right = Math.min(innerWidth, rectangle.right)
    const bottom = Math.min(innerHeight, rectangle.bottom)
    if (right - left < 2 || bottom - top < 2) {
      return []
    }
    return [
      {
        height: bottom - top,
        width: right - left,
        x: left,
        y: top,
      },
    ]
  })
}
const inspectImageUrl = async (source: string): Promise<PixelStats> => {
  const image = new Image
  image.src = source
  await image.decode()
  const sample = document.createElement('canvas')
  sample.width = 48
  sample.height = 48
  const context = sample.getContext('2d', {willReadFrequently: true})
  if (!context) {
    return {
      distinctColors: 0,
      luminanceRange: 0,
      variance: 0,
      visibleFraction: 0,
    }
  }
  context.drawImage(image, 0, 0, 48, 48)
  const data = context.getImageData(0, 0, 48, 48).data
  const colors = new Set<number>
  let visible = 0
  let minimum = 255
  let maximum = 0
  let sum = 0
  let squares = 0
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]
    if (alpha <= 4) {
      continue
    }
    const red = data[index]
    const green = data[index + 1]
    const blue = data[index + 2]
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    visible++
    minimum = Math.min(minimum, luminance)
    maximum = Math.max(maximum, luminance)
    sum += luminance
    squares += luminance * luminance
    colors.add(red >> 4 << 8 | green >> 4 << 4 | blue >> 4)
  }
  const mean = visible ? sum / visible : 0
  return {
    distinctColors: colors.size,
    luminanceRange: visible ? maximum - minimum : 0,
    variance: visible ? Math.max(0, squares / visible - mean * mean) : 0,
    visibleFraction: visible / (data.length / 4),
  }
}
const sleep = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason)
    return
  }
  const timer = setTimeout(resolve, milliseconds)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    reject(signal.reason)
  }, {once: true})
})
const inspectCompositedCanvases = async (page: Page): Promise<CanvasInspection> => {
  const rectangles = await page.evaluate(visibleCanvasRectangles)
  let best: PixelStats | undefined
  for (const rectangle of rectangles) {
    const screenshot = await page.screenshot({
      captureBeyondViewport: false,
      clip: rectangle,
      type: 'png',
    }).catch(() => {})
    if (!screenshot) {
      continue
    }
    const source = `data:image/png;base64,${Buffer.from(screenshot).toString('base64')}`
    const stats = await page.evaluate(inspectImageUrl, source).catch(() => {})
    if (!stats) {
      continue
    }
    if (!best || stats.variance > best.variance) {
      best = stats
    }
    if (isMeaningfulStats(stats)) {
      return {
        canvasCount: rectangles.length,
        meaningful: true,
        stats,
      }
    }
  }
  return {
    canvasCount: rectangles.length,
    meaningful: false,
    stats: best,
  }
}

export const waitForRenderedCanvas = async (page: Page, timeout: number, signal?: AbortSignal) => {
  const deadline = Date.now() + timeout
  let directSamples = 0
  let compositorSamples = 0
  let lastCompositorCheck = 0
  let lastDirect: CanvasInspection | null = null
  let lastComposited: CanvasInspection | null = null
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw signal.reason
    }
    const probe = await page.evaluate(readProbeState).catch(() => {})
    if (probe?.ready) {
      return
    }
    lastDirect = await page.evaluate(inspectDirectCanvases).catch(() => null)
    if (lastDirect?.meaningful) {
      directSamples++
      if (directSamples >= 2) {
        return
      }
    } else {
      directSamples = 0
    }
    if (Date.now() - lastCompositorCheck >= 750) {
      lastCompositorCheck = Date.now()
      lastComposited = await inspectCompositedCanvases(page)
      if (lastComposited.meaningful) {
        compositorSamples++
        if (compositorSamples >= 2) {
          return
        }
      } else {
        compositorSamples = 0
      }
    }
    await sleep(180, signal)
  }
  const probe = await page.evaluate(readProbeState).catch(() => {})
  throw new Error(`Timed out waiting for meaningful rendered canvas content. Diagnostics: ${JSON.stringify({
    compositor: lastComposited,
    direct: lastDirect,
    probe,
  })}`)
}

export const settleRenderedCanvas = async (page: Page, timeout: number) => {
  await page.waitForNetworkIdle({
    concurrency: 2,
    idleTime: 250,
    timeout: Math.min(timeout, 2000),
  }).catch(() => {})
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })).catch(() => {})
}
