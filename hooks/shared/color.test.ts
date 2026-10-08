import { expect, test } from 'claude-code/testing'

import { lastAgentColor, parseColorAnswer } from './color'

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
