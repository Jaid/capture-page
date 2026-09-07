import type {Target} from './types.ts'
import type {Page} from 'puppeteer'

import path from 'node:path'
import {pathToFileURL} from 'node:url'

import fs from 'fs-extra'

export type NormalizedTarget = {
  kind: 'file' | 'html' | 'url'
  value: string
}

const looksLikeHtml = (value: string) => /^\s*</u.test(value)
const looksLikeHost = (value: string) => /^(?:localhost|127\.0\.0\.1|\[?::1\]?|[^\s/]+\.[^\s/]+)(?::\d+)?(?:[#/?].*)?$/u.test(value)

export const normalizeTarget = async (target: Target): Promise<NormalizedTarget> => {
  if (target instanceof URL) {
    return {
      kind: 'url',
      value: target.href,
    }
  }
  if (typeof target === 'object') {
    if ('html' in target) {
      return {
        kind: 'html',
        value: target.html,
      }
    }
    return {
      kind: 'file',
      value: path.resolve(target.path),
    }
  }
  if (looksLikeHtml(target)) {
    return {
      kind: 'html',
      value: target,
    }
  }
  if (await fs.pathExists(target)) {
    const stats = await fs.stat(target)
    if (stats.isFile()) {
      return {
        kind: 'file',
        value: path.resolve(target),
      }
    }
  }
  if (looksLikeHost(target) && !/^[+\-.0-9A-Za-z]+:/u.test(target)) {
    return {
      kind: 'url',
      value: `http://${target}`,
    }
  }
  let url: URL
  try {
    url = new URL(target)
  } catch (error) {
    throw new TypeError('String targets must be URLs, existing file paths, or HTML strings.', {cause: error})
  }
  if (!['about:', 'data:', 'file:', 'http:', 'https:'].includes(url.protocol)) {
    throw new TypeError(`Unsupported target URL protocol: ${url.protocol}`)
  }
  return {
    kind: 'url',
    value: url.href,
  }
}

export const injectPreloadScript = (html: string, source: string) => {
  const script = `<script>${source.replaceAll('</script', String.raw`<\/script`)}</script>`
  const head = /<head(?:\s[^>]*)?>/iu.exec(html)
  if (head?.index !== undefined) {
    const position = head.index + head[0].length
    return html.slice(0, position) + script + html.slice(position)
  }
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html)
  if (doctype) {
    return html.slice(0, doctype[0].length) + script + html.slice(doctype[0].length)
  }
  return script + html
}

export const navigate = async (page: Page, target: NormalizedTarget, timeout: number) => {
  if (target.kind === 'html') {
    await page.setContent(target.value, {
      timeout,
      waitUntil: 'domcontentloaded',
    })
    return
  }
  const url = target.kind === 'file' ? pathToFileURL(target.value).href : target.value
  await page.goto(url, {
    timeout,
    waitUntil: 'domcontentloaded',
  })
}
