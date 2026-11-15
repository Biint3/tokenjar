import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'tokenjar-pane',
  component: 'Pane',
  requestId: 'tokenjar',
  props: {
    title: 'tokenjar',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const DATA = {
  metric: 'weighted tokens (input-token equivalents)',
  session: { bucket: 'work', reason: 'set by /budget set', isSet: true },
  buckets: [
    { name: 'work', period: 'weekly (mon)', used: '17M', limit: '20M', planPct: null, fraction: 0.85, percent: '85%', left: '3M', level: 'warn', mode: 'block', blocking: false, resets: 'Mon', isDefault: false, isSession: true, configured: true, extendBy: '5M' },
    { name: 'fun', period: 'weekly (mon)', used: '1M', limit: null, planPct: 25, fraction: null, percent: null, left: null, level: 'none', mode: 'calibrating', blocking: false, resets: 'Mon', isDefault: true, isSession: false, configured: true, extendBy: null },
  ],
  plan: { weeklyPct: 34, weeklyResets: 'Thu 09:00', fiveHourPct: 12, perPct: null, points: 1, needed: 2, shares: null, claudeCodePct: null },
  errors: [],
  generated: '2026-11-15T00:00:00Z',
}

function engine(on: (event: string, hook: (...a: any[]) => unknown) => void, runs: string[][]) {
  on('command.register', () => ({ value: { command: 'budget-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abc' }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'APPDATA' ? 'C:/Users/me/AppData/Roaming' : undefined }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: {} }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    const isPanel = e.argv[2] === 'panel'
    const stdout = isPanel ? JSON.stringify(DATA) : `answer to ${e.argv.slice(3, 6).join(' ')}\nsecond line`
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
}

test('the pane draws buckets from tokenjar and passes the plan reading on', async ($, on) => {
  const runs: string[][] = []
  engine(on as never, runs)

  await $.session.start({ cwd: '/work/app', surface: 'vscode', isInteractive: true })
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 34, resetsAt: '2026-11-20T09:00:00Z' }],
    changed: ['rateLimits'],
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /85%/ }))?.text).toContain('▓▓▓▓▓▓▓▓▓░')
  expect((await ui.find({ type: 'Text', text: /of plan once calibrated/ }))?.text).toContain('25%')
  expect((await ui.find({ type: 'Text', text: /weekly/ }))?.text).toContain('▓▓▓░░░░░░░ 34%')
  expect((await ui.find({ type: 'Text', text: /5-hour/ }))?.text).toContain('12%')
  await ui.unmount()

  const withPlan = runs.find(argv => argv.some(a => a.startsWith('--plan=')))
  expect(withPlan?.includes('--session')).toBe(true)
  expect(withPlan?.[1]).toBe('C:/Users/me/AppData/Roaming/tokenjar/cli.js')
  expect(withPlan?.find(a => a.startsWith('--plan='))).toContain('"seven_day":{"used_percentage":34,"resets_at":1795165200}')
})

test('the buttons move the session, extend a bucket near its limit, and refresh', async ($, on) => {
  const runs: string[][] = []
  engine(on as never, runs)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The session's own bucket has no "use here"; others do.
    expect(await ui.find({ key: 'use-work' })).toBeUndefined()
    expect(await ui.find({ key: 'use-fun' })).toBeDefined()
    // Extend only shows where a limit is near or past.
    expect(await ui.find({ key: 'ext-fun' })).toBeUndefined()
    expect(await ui.find({ key: 'ext-work' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'use-fun' })
  expect(runs.some(a => a.slice(2, 5).join(' ') === 'budget set fun' && a.includes('abc'))).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^answer to/ }))?.text).toBe('answer to set fun --session')

  await ui.press({ key: 'ext-work' })
  expect(runs.some(a => a.slice(2, 6).join(' ') === 'budget extend work 5M')).toBe(true)

  await ui.press({ key: 'auto' })
  expect(runs.some(a => a.slice(2, 5).join(' ') === 'budget set auto')).toBe(true)

  const before = runs.length
  await ui.press({ key: 'refresh' })
  expect(runs.slice(before).some(a => a[2] === 'panel')).toBe(true)
  await ui.unmount()
})

test('before any data, the pane says it is reading', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Reading tokenjar…')
  await ui.unmount()
})
