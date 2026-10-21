import type {Browser, BrowserContext} from 'puppeteer-core'

import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'

export type Download = {
  buffer: Buffer
  suggestedFilename: string
}

type Started = {
  guid: string
  suggestedFilename: string
}

/** Routes the context’s downloads into a private temporary folder and waits for the first one to complete. */
export const prepareDownload = async (browser: Browser, context: BrowserContext, timeout: number) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-page-download-'))
  const session = await browser.target().createCDPSession()
  // A cancellation resolves with its error, since it can arrive before anyone waits.
  const completed = Promise.withResolvers<Error | Started>()
  let first: Started | undefined
  session.on('Browser.downloadWillBegin', event => {
    first ??= {
      guid: event.guid,
      suggestedFilename: event.suggestedFilename,
    }
  })
  session.on('Browser.downloadProgress', event => {
    if (event.guid !== first?.guid) {
      return
    }
    if (event.state === 'completed') {
      completed.resolve(first)
    } else if (event.state === 'canceled') {
      completed.resolve(new Error(`The download of ${first.suggestedFilename} was canceled.`))
    }
  })
  await session.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    browserContextId: context.id,
    downloadPath: folder,
    eventsEnabled: true,
  })
  return {
    async wait(): Promise<Download> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const started = await Promise.race([
          completed.promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`No download completed within ${timeout} ms.`)), timeout)
          }),
        ])
        if (Error.isError(started)) {
          throw started
        }
        const {guid, suggestedFilename} = started
        return {
          // allowAndName stores the file under its GUID.
          buffer: await fs.readFile(path.join(folder, guid)),
          suggestedFilename,
        }
      } finally {
        clearTimeout(timer)
      }
    },
    async dispose() {
      await session.detach().catch(() => {})
      await fs.remove(folder)
    },
  }
}
