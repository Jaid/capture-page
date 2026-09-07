import type {Arrayable, Body, Options, Style, StyleProperties} from './types.ts'
import type {Page} from 'puppeteer'

const NORMALIZE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html { line-height: 1.15; -webkit-text-size-adjust: 100%; }
body { margin: 0; }
img, picture, video, canvas, svg { max-width: 100%; }
button, input, select, textarea { font: inherit; }`
const toArray = <T>(value: Arrayable<T>): Array<T> => {
  return Array.isArray(value) ? value : [value]
}
const kebabCase = (value: string) => {
  if (value.startsWith('--')) {
    return value
  }
  return value.replaceAll(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)
}
const propertiesToCss = (properties: StyleProperties) => {
  return Object.entries(properties).map(([name, value]) => `${kebabCase(name)}: ${value};`).join(' ')
}
const compileSass = async (code: string) => {
  const sass = await import('sass').catch(error => {
    throw new Error('Sass styles require the optional sass dependency.', {cause: error})
  })
  const result = await sass.compileStringAsync(code)
  return result.css
}
const compileStyle = async (style: Style): Promise<string> => {
  if (typeof style === 'string') {
    return style
  }
  if ('content' in style && style.type !== 'style') {
    return style.type === 'sass' ? compileSass(style.content) : style.content
  }
  if ('code' in style) {
    return style.type === 'sass' ? compileSass(style.code) : style.code
  }
  return toArray(style.content).map(({properties, rule}) => `${toArray(rule).join(', ')} { ${propertiesToCss(properties)} }`).join('\n')
}

export const injectStyles = async (page: Page, options: Pick<Options, 'normalizeCss' | 'style'>) => {
  const blocks: Array<string> = []
  if (options.normalizeCss) {
    blocks.push(NORMALIZE_CSS)
  }
  if (options.style !== undefined) {
    for (const style of toArray(options.style)) {
      blocks.push(await compileStyle(style))
    }
  }
  if (blocks.length) {
    await page.addStyleTag({content: blocks.join('\n')})
  }
}

const normalizeBody = (body: Body | 'auto' | boolean | undefined): Body | undefined => {
  if (body === undefined || body === false) {
    return undefined
  }
  if (body === true || body === 'auto') {
    return {when: body}
  }
  return {
    ...body,
    when: body.when ?? 'auto',
  }
}

export const applyBody = async (page: Page, bodyInput: Options['body']) => {
  const bodyOptions = normalizeBody(bodyInput)
  if (!bodyOptions || bodyOptions.when === false) {
    return
  }
  const background = bodyOptions.style && typeof bodyOptions.style === 'string' ? bodyOptions.style : bodyOptions.background
  const declarations = bodyOptions.style && typeof bodyOptions.style === 'object' ? bodyOptions.style : undefined
  await page.evaluate(({bodyBackground, bodyDeclarations}) => {
    let bodyElement = document.querySelector('body')
    if (!bodyElement) {
      bodyElement = document.createElement('body')
      document.documentElement.append(bodyElement)
    }
    if (bodyBackground !== undefined) {
      bodyElement.style.background = bodyBackground
    }
    if (bodyDeclarations) {
      for (const [name, value] of Object.entries(bodyDeclarations)) {
        const cssName = name.startsWith('--') ? name : name.replaceAll(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)
        bodyElement.style.setProperty(cssName, String(value))
      }
    }
  }, {
    bodyBackground: background,
    bodyDeclarations: declarations,
  })
}
