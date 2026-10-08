import { expect, test } from 'claude-code/testing'
import type { RenderElement } from 'claude-code'

import { GIT_PREFIX, MIN_HALF_ROWS, gitKeyOf, prefixKeys, splitColumns, splitRows } from './layout'

test('splitColumns: a fifth of the window, never under the minimum', () => {
  expect(splitColumns(200)).toBe(40)
  expect(splitColumns(250)).toBe(50)
  expect(splitColumns(100)).toBe(24)
  expect(splitColumns(0)).toBe(24)
})

test('splitRows: the Explorer takes 70% of the rows besides the seam, Git the rest', () => {
  expect(splitRows(41, undefined)).toEqual({ top: 28, bottom: 12, gitTop: 29 })
  expect(splitRows(41, 0.5)).toEqual({ top: 20, bottom: 20, gitTop: 21 })
  // each half keeps its minimum
  expect(splitRows(41, 0.99).bottom).toBe(MIN_HALF_ROWS)
  expect(splitRows(41, 0.01).top).toBe(MIN_HALF_ROWS)
  // outside a repo Git keeps its 3 rows, whatever the fraction
  expect(splitRows(41, 0.5, false)).toEqual({ top: 37, bottom: 3, gitTop: 38 })
})

test('prefixKeys: every key at any depth, everything else kept', () => {
  const press = () => {}
  const tree = {
    type: 'Box',
    props: {
      key: 'header',
      children: [
        { type: 'Button', props: { key: 'refresh', label: 'refresh', onPress: press } },
        [{ type: 'Text', props: { children: 'plain' } }],
        'text',
        null,
      ],
    },
  } as unknown as RenderElement
  const out = prefixKeys(tree, GIT_PREFIX) as unknown as { props: { key: string; children: unknown[] } }
  expect(out.props.key).toBe('git/header')
  const [button, nested, text, none] = out.props.children as [
    { props: { key: string; onPress: unknown } },
    { props: { key?: string; children: string } }[],
    string,
    null,
  ]
  expect(button.props.key).toBe('git/refresh')
  expect(button.props.onPress).toBe(press)
  expect(nested[0]?.props.key).toBeUndefined()
  expect(nested[0]?.props.children).toBe('plain')
  expect(text).toBe('text')
  expect(none).toBeNull()
  // the tree given is not changed
  expect((tree as unknown as { props: { key: string } }).props.key).toBe('header')
})

test('gitKeyOf: a Git key without its prefix, undefined for the Explorer\'s', () => {
  expect(gitKeyOf('git/commit:abc')).toBe('commit:abc')
  expect(gitKeyOf('row:/proj/a')).toBeUndefined()
  expect(gitKeyOf(undefined)).toBeUndefined()
})
