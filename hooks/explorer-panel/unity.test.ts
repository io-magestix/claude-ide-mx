import { expect, test } from 'claude-code/testing'

import { classify, hasRefs, parseGrep, refsOf } from './unity'

const A = 'a'.repeat(32)

test('parseGrep maps guids to root-joined asset paths', () => {
  const out = [
    `Assets/Scenes/SampleScene.unity.meta:guid: ${A}`,
    'Assets/odd: name/x.png.meta:guid: ' + 'b'.repeat(32),
    'garbage',
    '',
  ].join('\n')
  const index = parseGrep(out, '/p')
  expect(index.get(A)).toBe('/p/Assets/Scenes/SampleScene.unity')
  expect(index.get('b'.repeat(32))).toBe('/p/Assets/odd: name/x.png')
  expect(index.size).toBe(2)
})

test('refsOf returns unique guids; classify tags built-in, resolved, unresolved', () => {
  const builtin = ['0000000000000000e000000000000000', '0000000000000000f000000000000000']
  const unknown = 'c'.repeat(32)
  const yaml = [A, ...builtin, unknown, A].map(g => `m: {guid: ${g}, type: 0}`).join('\n')
  const refs = refsOf(yaml)
  expect(refs).toEqual([A, ...builtin, unknown])
  const out = classify(refs, new Map([[A, '/p/Assets/a.mat']]))
  expect(out.map(r => r.kind)).toEqual(['resolved', 'builtin', 'builtin', 'unresolved'])
})

test('hasRefs matches the Unity YAML extensions', () => {
  expect(hasRefs('a.prefab')).toBe(true)
  expect(hasRefs('a.overrideController')).toBe(true)
  expect(hasRefs('a.cs')).toBe(false)
})
