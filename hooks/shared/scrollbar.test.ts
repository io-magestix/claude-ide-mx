import { expect, test } from 'claude-code/testing'

import { H_EDGE, H_INNER, barRuns, scrollbar } from './scrollbar'

// A vertical bar's cells spelled one letter each: T thumb, t track.
const v = (cells: string): string => cells.replace(/T/g, '▐▌').replace(/t/g, '▕▏')

test('scrollbar: horizontal glyphs, the inner row over the border', () => {
  expect(scrollbar(20, 10, 0, 10, H_EDGE).join('')).toBe('▀▀▀▀▀─────')
  expect(scrollbar(20, 10, 10, 10, H_EDGE).join('')).toBe('─────▀▀▀▀▀')
  expect(scrollbar(20, 10, 5, 10, H_EDGE).join('')).toBe('───▀▀▀▀▀──')
  expect(scrollbar(20, 10, 5, 10, H_INNER).join('')).toBe('   ▄▄▄▄▄  ')
  expect(scrollbar(5, 5, 0, 3, H_EDGE)).toEqual([' ', ' ', ' '])
})

test('scrollbar: blank when everything fits', () => {
  expect(scrollbar(5, 5, 0, 4)).toEqual(['  ', '  ', '  ', '  '])
  expect(scrollbar(3, 10, 0, 2)).toEqual(['  ', '  '])
  expect(scrollbar(10, 5, 0, 0)).toEqual([])
})

test('scrollbar: proportional thumb, at least one row, two columns', () => {
  expect(scrollbar(20, 10, 0, 10).join('')).toBe(v('TTTTTttttt'))
  expect(scrollbar(1000, 10, 0, 10).join('')).toBe(v('Tttttttttt'))
})

test('scrollbar: thumb follows the offset to the end', () => {
  expect(scrollbar(20, 10, 10, 10).join('')).toBe(v('tttttTTTTT'))
  expect(scrollbar(20, 10, 5, 10).join('')).toBe(v('tttTTTTTtt'))
  expect(scrollbar(20, 10, 99, 10).join('')).toBe(v('tttttTTTTT'))
  expect(scrollbar(20, 10, -3, 10).join('')).toBe(v('TTTTTttttt'))
})

test('barRuns: cells merged into thumb and track runs', () => {
  expect(barRuns(['▀', '▀', '─', '─', '─'], '▀')).toEqual([
    { text: '▀▀', isThumb: true },
    { text: '───', isThumb: false },
  ])
  expect(barRuns([], '▀')).toEqual([])
})
