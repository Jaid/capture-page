import type {Options} from './types.ts'
import type {Browser, SupportedBrowser} from 'puppeteer'

import fs from 'node:fs'
import path from 'node:path'

import puppeteer from 'puppeteer'

type BrowserLease = {
  browser: Browser
  owned: boolean
}

const verifiedExecutables = new Set<string>
const verifyBrowser = async (browser: Browser, executablePath: string) => {
  if (verifiedExecutables.has(executablePath)) {
    return
  }
  const page = await browser.newPage()
  try {
    await page.setViewport({
      width: 32,
      height: 32,
    })
    await page.setContent('<style>html,body{margin:0;background:#123}</style>')
    const screenshot = await page.screenshot({type: 'png'})
    if (screenshot.byteLength < 8) {
      throw new Error('Screenshot probe returned no image data.')
    }
    verifiedExecutables.add(executablePath)
  } finally {
    await page.close().catch(() => {})
  }
}
const isBrowser = (value: unknown): value is Browser => {
  return typeof value === 'object' && value !== null && 'newPage' in value && 'close' in value
}
const isPathLike = (value: string) => value.includes('/') || value.includes('\\') || /^[A-Za-z]:/u.test(value)
const executableNames = (name: string) => {
  const normalized = name.toLowerCase()
  const aliases: Record<string, Array<string>> = {
    chrome: ['google-chrome', 'google-chrome-stable', 'chrome', 'chrome.exe'],
    chromium: ['chromium', 'chromium-browser', 'chromium.exe'],
    edge: ['msedge', 'microsoft-edge', 'msedge.exe'],
    firefox: ['firefox', 'firefox-devedition', 'firefox.exe'],
  }
  return aliases[normalized] ?? [name]
}
const fromPath = (name: string) => {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  for (const candidateName of executableNames(name)) {
    for (const folder of pathEntries) {
      const candidateHasExtension = Boolean(path.extname(candidateName))
      for (const extension of candidateHasExtension ? [''] : extensions) {
        const candidate = path.resolve(folder, candidateName + extension.toLowerCase())
        if (fs.existsSync(candidate)) {
          return candidate
        }
      }
    }
  }
}
const knownLocations = () => {
  if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES ?? 'C:/Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA
    return [
      path.join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      path.join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
      path.join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
      localAppData ? path.join(localAppData, 'Google/Chrome/Application/chrome.exe') : undefined,
      path.join(programFiles, 'Mozilla Firefox/firefox.exe'),
    ].filter((value): value is string => value !== undefined)
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Firefox.app/Contents/MacOS/firefox',
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/firefox',
    '/usr/bin/firefox-devedition',
  ]
}
const resolveExecutable = (candidate: string) => {
  if (isPathLike(candidate)) {
    const absolute = path.resolve(candidate)
    return fs.existsSync(absolute) ? absolute : undefined
  }
  return fromPath(candidate) ?? knownLocations().find(location => {
    if (!fs.existsSync(location)) {
      return false
    }
    const basename = path.basename(location).toLowerCase()
    return executableNames(candidate).some(name => basename === path.basename(name).toLowerCase())
  })
}
const browserKind = (executablePath: string): SupportedBrowser => {
  return path.basename(executablePath).toLowerCase().includes('firefox') ? 'firefox' : 'chrome'
}
const defaultCandidates = async () => {
  const result = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
  ].filter((value): value is string => value !== undefined)
  result.push('chrome', 'chromium', 'edge')
  try {
    const bundled = await puppeteer.executablePath()
    if (bundled) {
      result.push(bundled)
    }
  } catch {
    // Puppeteer may have been installed without downloading a browser.
  }
  return result
}
const unique = <T>(values: Iterable<T>) => [...new Set(values)]

export const acquireBrowser = async (input: Options['browser'], options: Pick<Options, 'args' | 'sandbox' | 'timeout'>): Promise<BrowserLease> => {
  if (isBrowser(input)) {
    return {
      browser: input,
      owned: false,
    }
  }
  let requested: Array<string>
  if (input === undefined) {
    requested = await defaultCandidates()
  } else if (Array.isArray(input)) {
    requested = input
  } else {
    requested = [input]
  }
  const failures: Array<string> = []
  const candidates = unique(requested)
  for (const candidate of candidates) {
    const executablePath = resolveExecutable(candidate)
    if (!executablePath) {
      failures.push(`${candidate}: executable not found`)
      continue
    }
    const args = [
      ...options.sandbox === false ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
      ...options.args ?? [],
    ]
    try {
      const browser = await puppeteer.launch({
        args,
        browser: browserKind(executablePath),
        executablePath,
        headless: true,
        timeout: options.timeout,
      })
      try {
        await verifyBrowser(browser, executablePath)
      } catch (error) {
        await browser.close().catch(() => {})
        failures.push(`${candidate}: launched but screenshot probe failed: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      return {
        browser,
        owned: true,
      }
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Could not launch a browser. Tried:\n${failures.map(line => `- ${line}`).join('\n')}`)
}

export const releaseBrowser = async ({browser, owned}: BrowserLease) => {
  if (owned) {
    await browser.close()
  }
}
