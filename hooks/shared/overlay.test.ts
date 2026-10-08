import { expect, test } from 'claude-code/testing'

import { centerOffset, darken } from './overlay'

test('centerOffset', () => {
  expect(centerOffset(20, 10)).toBe(5)
  expect(centerOffset(21, 10)).toBe(5)
  expect(centerOffset(5, 10)).toBe(0)
})

test('darken', () => {
  expect(darken('#ffffff', 0.5)).toBe('#808080')
  expect(darken('red', 0.5)).toBe('red')
})
