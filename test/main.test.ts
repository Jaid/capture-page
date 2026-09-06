import {expect, test} from 'bun:test'

const {default: capturePage} = await import('#src/main.ts')

test('should run', () => {
  const result = capturePage()
  expect(result).toBe('capture-page') // TODO Test actual functionality
})
