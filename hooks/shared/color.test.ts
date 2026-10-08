import { expect, test } from 'claude-code/testing'

import { lastAgentColor, mixHex, parseColorAnswer } from './color'

test('parseColorAnswer reads /color answers', () => {
  expect(parseColorAnswer('Session color set to: orange')).toBe('orange')
  expect(parseColorAnswer('Session color reset to default')).toBe('')
  expect(parseColorAnswer('Unknown color')).toBeUndefined()
})

test('lastAgentColor takes the last entry of a transcript', () => {
  const out =
    '{"type":"agent-color","agentColor":"green","sessionId":"x"}\n' +
    '{"type":"agent-color","agentColor":"pink","sessionId":"x"}\n'
  expect(lastAgentColor(out)).toBe('pink')
  expect(lastAgentColor('')).toBeUndefined()
})

test('mixHex: the ends, halfway, and a non-hex color left alone', () => {
  expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
  expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
  expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  expect(mixHex('red', '#ffffff', 0.5)).toBe('red')
})
