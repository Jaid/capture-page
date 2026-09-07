import type {Page} from 'puppeteer'

import {afterAll, describe, expect, test} from 'bun:test'
import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import puppeteer from 'puppeteer'

import capturePage from '#src/main.ts'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-page-'))
const base = {
  height: 180,
  timeout: 5000,
  wait: 'load' as const,
  width: 320,
}
afterAll(async () => {
  await fs.remove(folder)
})
const dimensions = (buffer: Buffer) => {
  expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)]
}
const renderWebgl = async (page: Page, draw: boolean) => {
  await page.evaluate(async shouldDraw => {
    let canvas = document.querySelector('canvas') as HTMLCanvasElement
    let gl: WebGL2RenderingContext | null = null
    for (let attempt = 0; attempt < 40 && !gl; attempt++) {
      gl = canvas.getContext('webgl2')
      if (!gl) {
        const replacement = document.createElement('canvas')
        replacement.width = canvas.width
        replacement.height = canvas.height
        canvas.replaceWith(replacement)
        canvas = replacement
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    if (!gl) {
      throw new Error('WebGL2 unavailable')
    }
    const vertex = gl.createShader(gl.VERTEX_SHADER)!
    gl.shaderSource(vertex, '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}')
    gl.compileShader(vertex)
    if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(vertex) || 'Vertex shader failed')
    }
    const fragment = gl.createShader(gl.FRAGMENT_SHADER)!
    gl.shaderSource(fragment, '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(gl_FragCoord.x/320.,gl_FragCoord.y/180.,0.5,1.);}')
    gl.compileShader(fragment)
    if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(fragment) || 'Fragment shader failed')
    }
    const program = gl.createProgram()
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Program link failed')
    }
    gl.useProgram(program)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (shouldDraw) {
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    gl.finish()
  }, draw)
}
const systemBrowser = async () => {
  let candidates: Array<string>
  if (process.platform === 'win32') {
    candidates = ['C:/Program Files/Google/Chrome/Application/chrome.exe']
  } else if (process.platform === 'darwin') {
    candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  } else {
    candidates = ['/usr/bin/google-chrome', '/usr/bin/chromium']
  }
  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return candidate
    }
  }
  return puppeteer.executablePath()
}
describe('capturePage', () => {
  test('captures inline HTML with exact viewport dimensions', async () => {
    const result = await capturePage('<h1>Hello</h1>', base)
    expect(dimensions(result.buffer)).toEqual([320, 180])
    expect(result.passedTime).toBeGreaterThan(0)
  }, 15_000)
  test('supports legacy and modern style inputs, Sass, body styling, and normalization', async () => {
    const result = await capturePage({html: '<h1 id="title">Hello</h1>'}, {
      ...base,
      body: {
        background: 'rgb(1, 2, 3)',
        style: {margin: 0},
      },
      normalizeCss: true,
      style: [
        {
          content: 'h1 { color: red; }',
          type: 'css',
        },
        {
          code: '$bg: rgb(4, 5, 6); h1 { background: $bg; }',
          type: 'sass',
        },
        {
          content: {
            properties: {
              fontSize: '24px',
              '--capture-test': 1,
            },
            rule: ['h1', '.title'],
          },
          type: 'style',
        },
      ],
      hook: async page => {
        const values = await page.$eval('#title', element => {
          const style = getComputedStyle(element)
          return [style.color, style.backgroundColor, style.fontSize, getComputedStyle(document.body).margin, getComputedStyle(document.body).backgroundColor]
        })
        expect(values).toEqual(['rgb(255, 0, 0)', 'rgb(4, 5, 6)', '24px', '0px', 'rgb(1, 2, 3)'])
      },
    })
    expect(dimensions(result.buffer)).toEqual([320, 180])
  }, 15_000)
  test('keeps media type and preference features active together', async () => {
    await capturePage({html: '<p>media</p>'}, {
      ...base,
      colorScheme: 'dark',
      mediaType: 'print',
      motion: 'reduced',
      hook: async page => {
        expect(await page.evaluate(() => [
          matchMedia('print').matches,
          matchMedia('(prefers-color-scheme: dark)').matches,
          matchMedia('(prefers-reduced-motion: reduce)').matches,
        ])).toEqual([true, true, true])
      },
    })
  }, 15_000)
  test('runs hooks before readiness and counts only successful quorum rules', async () => {
    const started = performance.now()
    await capturePage({html: '<p>wait</p>'}, {
      ...base,
      hook: async page => {
        await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="hooked">ready</div>'))
      },
      wait: {
        count: 2,
        rules: [{selector: '#hooked'}, 'load', {selector: '#never'}],
      },
    })
    expect(performance.now() - started).toBeLessThan(5000)
    await expect(capturePage({html: '<p>never</p>'}, {
      ...base,
      timeout: 500,
      wait: {
        count: 2,
        rules: [{selector: '#missing-a'}, {selector: '#missing-b'}],
      },
    })).rejects.toThrow('readiness')
  }, 15_000)
  test('captures local files and saves JPEG/WebP with extension inference', async () => {
    const input = path.join(folder, 'input #.html')
    await fs.writeFile(input, '<h1>File</h1>')
    const local = await capturePage(input, base)
    expect(dimensions(local.buffer)).toEqual([320, 180])
    const jpegPath = path.join(folder, 'nested', 'shot.JPG')
    const jpeg = await capturePage.save({path: input}, jpegPath, {
      ...base,
      quality: 88,
    })
    expect(jpeg.buffer.subarray(0, 3).toString('hex')).toBe('ffd8ff')
    expect(Buffer.from(await fs.readFile(jpegPath)).equals(jpeg.buffer)).toBe(true)
    const webp = await capturePage.save({html: '<p>webp</p>'}, path.join(folder, 'shot.webp'), base)
    expect(webp.buffer.subarray(8, 12).toString()).toBe('WEBP')
  }, 20_000)
  test('supports full-page capture and physical pixel scaling', async () => {
    const result = await capturePage({html: '<style>html,body{margin:0}body{height:400px}</style>'}, {
      ...base,
      deviceScaleFactor: 2,
      fullPage: true,
    })
    expect(dimensions(result.buffer)).toEqual([640, 800])
  }, 15_000)
  test('detects a meaningful single WebGL frame without preserveDrawingBuffer', async () => {
    const result = await capturePage({html: '<canvas width="320" height="180"></canvas>'}, {
      ...base,
      hook: page => renderWebgl(page, true),
      wait: 'three',
    })
    expect(dimensions(result.buffer)).toEqual([320, 180])
    await capturePage({html: `<img id="shot" src="data:image/png;base64,${result.buffer.toString('base64')}">`}, {
      ...base,
      hook: async page => {
        const pixels = await page.$eval('#shot', async image => {
          const element = image as HTMLImageElement
          await element.decode()
          const canvas = document.createElement('canvas')
          canvas.width = element.naturalWidth
          canvas.height = element.naturalHeight
          const context = canvas.getContext('2d')!
          context.drawImage(element, 0, 0)
          return [20, 250].map(x => [...context.getImageData(x, 90, 1, 1).data])
        })
        expect(pixels[0][0]).toBeLessThan(40)
        expect(pixels[1][0]).toBeGreaterThan(170)
        expect(pixels[0][2]).toBeGreaterThan(100)
      },
    })
  }, 20_000)
  test('does not mistake a blank canvas for meaningful rendering', async () => {
    await expect(capturePage({html: '<canvas width="320" height="180"></canvas>'}, {
      ...base,
      hook: page => renderWebgl(page, false),
      timeout: 1200,
      wait: 'three',
    })).rejects.toThrow('readiness')
  }, 15_000)
  test('falls through unusable browser candidates and accepts reusable Browser instances', async () => {
    const executablePath = await systemBrowser()
    const fallback = await capturePage({html: '<p>fallback</p>'}, {
      ...base,
      browser: ['C:/definitely/missing/browser.exe', executablePath],
    })
    expect(dimensions(fallback.buffer)).toEqual([320, 180])
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
    })
    try {
      const reused = await capturePage({html: '<p>reuse</p>'}, {
        ...base,
        browser,
      })
      expect(dimensions(reused.buffer)).toEqual([320, 180])
      expect(browser.connected).toBe(true)
    } finally {
      await browser.close()
    }
  }, 30_000)
  test('validates impossible inputs before browser launch', async () => {
    await expect(capturePage({html: ''}, {width: 0})).rejects.toThrow('width')
    await expect(capturePage({html: ''}, {quality: 80})).rejects.toThrow('quality')
    await expect(capturePage({html: ''}, {
      wait: {
        count: 2,
        rules: ['load'],
      },
    })).rejects.toThrow('Wait count')
    await expect(capturePage.save({html: ''}, 'image.unknown')).rejects.toThrow('infer')
  })
})
test.skipIf(!process.env.CAPTURE_PAGE_LIVE)('captures Slop Gallery after meaningful renderer output', async () => {
  const result = await capturePage.save('https://gpt.slop-gallery.mage.build?ai=false', path.join(folder, 'slop-gallery.png'), {
    height: 1080,
    timeout: 90_000,
    wait: {
      count: 'all',
      rules: ['three', 'networkidle2'],
    },
    width: 1920,
  })
  expect(dimensions(result.buffer)).toEqual([1920, 1080])
  expect(result.buffer.byteLength).toBeGreaterThan(100_000)
}, 120_000)
