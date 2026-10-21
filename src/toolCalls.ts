import type {ToolCall} from './types.ts'
import type {Page} from 'puppeteer-core'

type ModelContextLike = {
  executeTool: (tool: {name: string}, input?: object) => Promise<string>
  getTools: () => Promise<Array<{name: string}>>
}

const parseResult = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** Runs WebMCP tools one after another through the page’s own `document.modelContext`. JSON results are parsed. */
export const runToolCalls = async (page: Page, toolCalls: Array<ToolCall>, timeout: number) => {
  const results: Array<unknown> = []
  for (const {name, input} of toolCalls) {
    // Pages usually register their tools asynchronously, e.g. after their first render.
    await page.waitForFunction(async (toolName: string) => {
      const context = (document as unknown as {modelContext?: ModelContextLike}).modelContext
      const tools = await context?.getTools()
      return tools?.some(tool => tool.name === toolName) ?? false
    }, {timeout}, name).catch((error: unknown) => {
      throw new Error(`WebMCP tool ${name} was not registered in time. Without a reused browser, capture-page enables WebMCP itself.`, {cause: error})
    })
    const text = await page.evaluate(async (toolName: string, toolInput: object) => {
      const context = (document as unknown as {modelContext: ModelContextLike}).modelContext
      const tools = await context.getTools()
      const tool = tools.find(candidate => candidate.name === toolName)!
      return context.executeTool(tool, toolInput)
    }, name, input ?? {}).catch((error: unknown) => {
      throw new Error(`WebMCP tool ${name} failed.`, {cause: error})
    })
    results.push(parseResult(text))
  }
  return results
}
