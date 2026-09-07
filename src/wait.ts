import type {WaitBehavior, WaitEvent} from './types.ts'
import type {Page, PuppeteerLifeCycleEvent} from 'puppeteer'

import {settleRenderedCanvas, waitForRenderedCanvas} from './render.ts'

const lifecycle = new Set<PuppeteerLifeCycleEvent>(['domcontentloaded', 'load', 'networkidle0', 'networkidle2'])
const isSelectorWait = (event: WaitEvent): event is Extract<WaitEvent, {selector: string}> => {
  return typeof event === 'object' && !Array.isArray(event) && 'selector' in event
}

export const includesThreeWait = (wait: WaitBehavior | undefined) => {
  if (wait === 'three') {
    return true
  }
  if (typeof wait === 'object' && !Array.isArray(wait) && 'rules' in wait) {
    return wait.rules.includes('three')
  }
  return false
}

const waitLifecycle = async (page: Page, event: PuppeteerLifeCycleEvent, timeout: number, signal: AbortSignal) => {
  if (event === 'domcontentloaded') {
    await page.waitForFunction(() => document.readyState !== 'loading', {
      signal,
      timeout,
    })
    return
  }
  if (event === 'load') {
    await page.waitForFunction(() => document.readyState === 'complete', {
      signal,
      timeout,
    })
    return
  }
  await page.waitForNetworkIdle({
    concurrency: event === 'networkidle0' ? 0 : 2,
    idleTime: 500,
    signal,
    timeout,
  })
}
const waitEvent = async (page: Page, event: WaitEvent, timeout: number, signal: AbortSignal): Promise<void> => {
  if (event === 'three') {
    await waitForRenderedCanvas(page, timeout, signal)
    await settleRenderedCanvas(page, timeout)
    return
  }
  if (Array.isArray(event)) {
    await Promise.all(event.map(item => waitEvent(page, item, timeout, signal)))
    return
  }
  if (isSelectorWait(event)) {
    await page.waitForSelector(event.selector, {
      signal,
      timeout,
      visible: event.visible ?? true,
    })
    return
  }
  if (!lifecycle.has(event)) {
    throw new TypeError(`Unsupported wait event: ${String(event)}`)
  }
  await waitLifecycle(page, event, timeout, signal)
}
const parseWait = (wait: WaitBehavior | undefined) => {
  if (wait === undefined) {
    return {
      count: 1,
      rules: ['networkidle2' as const],
    }
  }
  if (typeof wait === 'object' && !Array.isArray(wait) && 'rules' in wait) {
    const count = wait.count === 'all' ? wait.rules.length : wait.count
    if (!wait.rules.length || !Number.isSafeInteger(count) || count < 1 || count > wait.rules.length) {
      throw new RangeError('Wait count must be an integer between 1 and the number of rules.')
    }
    return {
      count,
      rules: wait.rules,
    }
  }
  return {
    count: 1,
    rules: [wait],
  }
}

export const waitForReadiness = async (page: Page, wait: WaitBehavior | undefined, timeout: number) => {
  const {count, rules} = parseWait(wait)
  const controller = new AbortController
  try {
    await new Promise<void>((resolve, reject) => {
      let failures = 0
      let successes = 0
      const errors: Array<unknown> = []
      for (const rule of rules) {
        waitEvent(page, rule, timeout, controller.signal)
          .then(() => {
            successes++
            if (successes >= count) {
              resolve()
            }
          })
          .catch(error => {
            failures++
            errors.push(error)
            if (failures > rules.length - count) {
              reject(new AggregateError(errors, 'Page readiness requirements were not satisfied.'))
            }
          })
      }
    })
  } finally {
    controller.abort(new Error('Readiness quorum settled.'))
  }
}

export const waitForFonts = async (page: Page, timeout: number) => {
  await page.waitForFunction(() => document.fonts.status === 'loaded', {
    timeout: Math.min(timeout, 5000),
  }).catch(() => {})
}
