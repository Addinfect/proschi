import { expect, mock, test } from 'claude-code/testing'

import { LAYOUT } from './fixture'

const pane = {
  plugin: 'proschi',
  component: 'Pane',
  requestId: 'proschi-view',
  surface: 'terminal',
  props: { title: 'Proschi', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const ROOT = '/proj'
const FILE = `${ROOT}/app.proschi`
const SPEC = 'git:github.com/acme/infra//db.proschi@main'
// The team file as `proschi imports sync` cached it, under its sha256.
const DB = 'db "Orders DB" [PostgreSQL]\n'
const DB_BASE64 = 'ZGIgIk9yZGVycyBEQiIgW1Bvc3RncmVTUUxdCg=='
const DB_HASH = '0970b150f6b3451ac515582ddf2d187d64ab5d10928580881962c62ec44cd183'
const LOCK = JSON.stringify({ version: 1, git: { 'github.com/acme/infra@main': { commit: 'a'.repeat(40), files: { 'db.proschi': DB_HASH } } }, https: {} })

type On = Parameters<Parameters<typeof test>[1]>[1]

/** A project with a remote import, its lock and cache as given; what each layout was sent is kept in `sent`. */
function project(on: On, files: Record<string, string | { base64: string }>, sent: { imports?: Record<string, string> }[]) {
  mock.clock(on)
  const all: Record<string, string | { base64: string }> = { [FILE]: `import "${SPEC}"\napi [REST API]\napi -> db\n`, [`${ROOT}/proschi.json`]: '{}', ...files }
  on('fs.exists', (_, e) => ({ value: e.path in all }))
  on('fs.read', (_, e) => {
    const file = all[e.path]
    if (file === undefined) return { error: { name: 'Error', message: `ENOENT: ${e.path}` } }
    const bytes = (e as { as?: string }).as === 'bytes'
    return { value: typeof file === 'string' ? (bytes ? { base64: btoa(file) } : file) : bytes ? file : atob(file.base64) }
  })
  on('fs.stat', () => ({ value: { mtimeMs: 1 } }))
  on('process.run', (_, e) => {
    sent.push(JSON.parse(String((e as { init?: { stdin?: unknown } }).init?.stdin)))
    return { value: { exitCode: 0, stdout: LAYOUT, stderr: '' } }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.scroll', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'proschi' } }))
}

async function drawn($: Parameters<Parameters<typeof test>[1]>[0]) {
  expect((await $.command.run({ command: 'proschi', args: `view ${FILE}` })).text).toBe(`Showing ${FILE} in the Proschi pane.`)
  await (await $.ui.mount(pane)).unmount()
  return $.ui.mount(pane)
}

test('a remote import is read from proschi.lock and the cache, never the network', async ($, on) => {
  const sent: { imports?: Record<string, string> }[] = []
  project(on, { [`${ROOT}/proschi.lock`]: LOCK, [`${ROOT}/.proschi/cache/${DB_HASH}`]: { base64: DB_BASE64 } }, sent)
  const ui = await drawn($)
  expect(sent.at(-1)?.imports?.[SPEC]).toBe(DB)
  expect(await ui.find({ type: 'Text', text: /Not found|imports sync/ })).toBeUndefined()
  await ui.unmount()
})

const escape = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

for (const [what, files, reason] of [
  ['there is no lock', {}, `'${SPEC}' is a remote import and there is no proschi.lock; run proschi imports sync`],
  ['the lock does not pin it', { [`${ROOT}/proschi.lock`]: JSON.stringify({ version: 1, git: {}, https: {} }) }, `'${SPEC}' is not in proschi.lock; run proschi imports sync`],
  ['it is not in the cache', { [`${ROOT}/proschi.lock`]: LOCK }, `'${SPEC}' is not in the import cache (.proschi/cache); run proschi imports sync`],
  // A cached copy changed after sync is refused.
  ['its cached copy was changed', { [`${ROOT}/proschi.lock`]: LOCK, [`${ROOT}/.proschi/cache/${DB_HASH}`]: 'db "Evil DB" [PostgreSQL]\n' }, `The cached copy of '${SPEC}' does not match its hash in proschi.lock; run proschi imports sync`],
] as const) {
  test(`a remote import says why it was not read when ${what}, as proschi check does`, async ($, on) => {
    const sent: { imports?: Record<string, string> }[] = []
    project(on, files, sent)
    const ui = await drawn($)
    expect(await ui.find({ type: 'Text', text: escape(reason) })).toBeDefined()
    expect(sent.every(s => !s.imports?.[SPEC])).toBe(true)
    await ui.unmount()
  })
}
