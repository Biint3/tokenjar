import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { BucketDraft, PanelBucket, PanelData, PanelView } from '../types'

// The pane reads from and acts through the tokenjar CLI. Everything stays on
// this machine: it runs `node <tokenjar config>/cli.js ...` and draws what that
// prints. tokenjar rewrites cli.js on every session start to point at the
// installed plugin version, since a plugin's own folder moves on each update.
const PANE = 'tokenjar'
const TITLE = 'tokenjar'
const REFRESH_MS = 60_000
const BAR = 10

// Change the tag when PanelView changes: it declines what an older version stored.
const view = atom(
  { plugin: 'tokenjar-pane', key: 'view' } as const,
  { data: null, problem: null, updatedAt: null, notice: null },
  { shape: 'view-2' },
)

const EMPTY_DRAFT: BucketDraft = { open: false, name: '', paths: '', limit: '', period: 'weekly', reset: '', mode: 'warn' }
const draft = atom({ plugin: 'tokenjar-pane', key: 'draft' } as const, EMPTY_DRAFT, { shape: 'draft-1' })

/** Plan windows from Claude Code, in the status line's `rate_limits` shape tokenjar reads. */
function planArg(limits: readonly SessionRateLimit[]): string | null {
  const out: Record<string, { used_percentage: number; resets_at: number }> = {}
  for (const w of limits) {
    if ((w.kind !== 'seven_day' && w.kind !== 'five_hour') || !w.resetsAt) continue
    const at = Date.parse(w.resetsAt)
    if (Number.isFinite(at)) out[w.kind] = { used_percentage: w.percentUsed, resets_at: Math.round(at / 1000) }
  }
  return Object.keys(out).length ? JSON.stringify({ rate_limits: out }) : null
}

/** The limit field's hint: what is still unallocated of the plan, when known. */
function limitHint(data: PanelData | null): string {
  const total = data?.allocation?.total
  if (total === undefined || total === null || !data?.allocation?.text) return '20M, 25% of plan, or empty to just track'
  const free = Math.max(0, Math.round(100 - total))
  return free > 0 ? `e.g. ${free}% of plan (unallocated), 20M, or empty` : 'plan fully allocated: 20M, N% of plan, or empty'
}

function bar(fraction: number): string {
  const full = Math.max(0, Math.min(BAR, Math.round(fraction * BAR)))
  return '▓'.repeat(full) + '░'.repeat(BAR - full)
}

const LEVEL_COLOR = { ok: 'success', warn: 'warning', over: 'error', none: 'inactive' } as const

/** Colour for a plan window's % used. */
function planColor(pct: number): 'success' | 'warning' | 'error' {
  return pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success'
}

function detail(b: PanelBucket): string {
  if (b.limit !== null) return `${b.used} of ${b.limit} · ${b.left} left · ${b.blocking ? 'BLOCKED' : b.mode}`
  if (b.mode === 'calibrating') return `${b.used} · limit ${b.planPct}% of plan once calibrated`
  if (!b.configured) return `${b.used} · not in budgets.yaml · renamed it? /budget rename ${b.name} <new name>`
  if (b.unlisted) return `${b.used} · default_bucket, but not listed under buckets · renamed it? /budget rename ${b.name} <new name>`
  return `${b.used} · no limit (tracked)`
}

/** <tokenjar config dir>/cli.js, found the way tokenjar finds its config dir. */
async function cliPath($: EngineInterface): Promise<string> {
  const own = await $.env.get('TOKENJAR_HOME')
  if (own) return `${own}/cli.js`
  const appData = await $.env.get('APPDATA') // Windows
  if (appData) return `${appData}/tokenjar/cli.js`
  const xdg = await $.env.get('XDG_CONFIG_HOME')
  if (xdg && xdg.startsWith('/')) return `${xdg}/tokenjar/cli.js`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '~'
  return `${home}/.config/tokenjar/cli.js`
}

let busy = false
let again: string | null | undefined

async function refresh($: EngineInterface, plan: string | null = null) {
  if (busy) {
    again = plan ?? again ?? null
    return
  }
  busy = true
  try {
    const argv = ['node', await cliPath($), 'panel', '--session', await $.session.id(), '--cwd', await $.session.cwd()]
    if (plan) argv.push(`--plan=${plan}`)
    const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs: 20_000 })
    const now = await $.clock.now()
    try {
      const parsed = JSON.parse(stdout) as PanelData | { error: string }
      if ('error' in parsed) throw new Error(parsed.error)
      const data = parsed
      await update($, view, v => ({ ...v, data, problem: null, updatedAt: now }))
    } catch (err) {
      const said = err instanceof Error && !(err instanceof SyntaxError) ? err.message : ''
      const problem = (said || stdout.trim() || stderr.trim() || `exit ${exitCode}`).slice(0, 300)
      await update($, view, v => ({ ...v, problem, updatedAt: now }))
    }
  } catch (err) {
    const problem = `cannot run tokenjar: ${String(err).slice(0, 200)}`
    await update($, view, v => ({ ...v, problem }))
  } finally {
    busy = false
  }
  if (again !== undefined) {
    const next = again
    again = undefined
    await refresh($, next)
  }
}

/** Runs one `/budget` subcommand for this session, shows its answer, then refreshes. */
async function act($: EngineInterface, args: string[]): Promise<string> {
  await update($, view, v => ({ ...v, notice: 'Working…' }))
  let notice: string
  try {
    const argv = ['node', await cliPath($), 'budget', ...args, '--session', await $.session.id(), '--cwd', await $.session.cwd()]
    const { stdout, stderr } = await $.process.run(argv, { timeoutMs: 20_000 })
    notice = ((stdout.trim() || stderr.trim() || 'Done.').split('\n')[0] ?? '').slice(0, 200)
  } catch (err) {
    notice = `tokenjar failed: ${String(err).slice(0, 150)}`
  }
  await update($, view, v => ({ ...v, notice }))
  await refresh($)
  return notice
}

async function useBucket($: EngineInterface, name: string) {
  await act($, ['set', name])
}

async function backToFolderRules($: EngineInterface) {
  await act($, ['set', 'auto'])
}

async function extendBucket($: EngineInterface, name: string, amount: string) {
  await act($, ['extend', name, amount])
}

async function editBudgets($: EngineInterface) {
  await act($, ['edit'])
}

async function toggleForm($: EngineInterface) {
  await update($, draft, d => ({ ...d, open: !d.open }))
}

async function setDraft($: EngineInterface, field: keyof Omit<BucketDraft, 'open'>, value: string) {
  await update($, draft, d => ({ ...d, [field]: value }))
}

async function useThisFolder($: EngineInterface) {
  const cwd = await $.session.cwd()
  await update($, draft, d => ({ ...d, paths: cwd }))
}

async function createBucket($: EngineInterface) {
  const d = await read($, draft)
  const notice = await act($, [
    'add',
    d.name.trim(),
    `--path=${d.paths}`,
    `--limit=${d.limit}`,
    `--period=${d.period}`,
    `--reset=${d.reset}`,
    `--mode=${d.mode}`,
  ])
  if (notice.startsWith('Added bucket')) await update($, draft, () => EMPTY_DRAFT)
}

async function refreshNow($: EngineInterface) {
  await update($, view, v => ({ ...v, notice: null }))
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'budget-pane', description: 'Show the tokenjar budgets pane' })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  on('command.run', { command: 'budget-pane' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    return { text: opened.isPlaced ? 'tokenjar pane opened.' : `tokenjar pane is waiting for room: ${opened.reason}` }
  })

  // After each turn, and whenever the plan % moves: refresh, and hand tokenjar
  // the plan reading so its plan estimate works without a status line.
  on('session.measure', async ($, e, next) => {
    void refresh($, planArg(e.rateLimits))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const { data, problem, updatedAt, notice } = await read($, view)
    const form = await read($, draft)

    if (!data) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{problem ? `tokenjar: ${problem}` : 'Reading tokenjar…'}</Text>
          {problem && <Button key="refresh" label="↻ Try again" onPress={() => refreshNow($)} />}
        </Box>
      )
    }

    const p = data.plan
    const planLine =
      p.weeklyPct !== null
        ? `Plan: weekly ${p.weeklyPct}%${p.fiveHourPct !== null ? ` · 5-hour ${p.fiveHourPct}%` : ''}${p.weeklyResets ? ` · resets ${p.weeklyResets}` : ''}`
        : 'Plan: no weekly % reported yet'
    const calLine = p.perPct
      ? `1% of plan ≈ ${p.perPct}${p.claudeCodePct !== null ? ` · Claude Code ≈${p.claudeCodePct}% of it` : ''}`
      : `Calibrating: ${p.points} of ${p.needed} plan points seen`
    const time = updatedAt ? new Date(updatedAt).toTimeString().slice(0, 5) : ''

    return (
      <Box flexDirection="column">
        {data.session && (
          <Box flexDirection="row" gap={1}>
            <Text>
              This session → <Text weight="bold">{data.session.bucket}</Text>
            </Text>
            {data.session.isSet && (
              <Button key="auto" label="back to folder rules" dimColor onPress={() => backToFolderRules($)} />
            )}
          </Box>
        )}
        <Text dimColor>{data.metric}</Text>
        <Text> </Text>
        {data.buckets.map(b => (
          <Box key={`row-${b.name}`} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Text>
                <Text weight={b.isSession ? 'bold' : 'regular'}>
                  {b.isSession ? '▶ ' : '  '}
                  {b.name}
                  {b.isDefault ? '*' : ''}
                </Text>
                {'  '}
                {b.fraction !== null ? (
                  <Text color={LEVEL_COLOR[b.level]}>
                    {bar(b.fraction)} {b.percent}
                  </Text>
                ) : (
                  <Text dimColor>{b.mode === 'calibrating' ? 'calibrating' : 'tracking'}</Text>
                )}
                <Text dimColor>{`  resets ${b.resets}`}</Text>
              </Text>
              {!b.isSession && (
                <Button key={`use-${b.name}`} label="use here" dimColor onPress={() => useBucket($, b.name)} />
              )}
              {b.extendBy && (b.level === 'warn' || b.level === 'over') && (
                <Button
                  key={`ext-${b.name}`}
                  label={`+${b.extendBy}`}
                  variant="primary"
                  onPress={() => extendBucket($, b.name, b.extendBy ?? '')}
                />
              )}
            </Box>
            <Text dimColor>{`    ${detail(b)}`}</Text>
          </Box>
        ))}
        {data.allocation?.text && (
          <Text color={data.allocation.over ? 'warning' : undefined} dimColor={!data.allocation.over}>
            {data.allocation.over ? `⚠ ${data.allocation.text} More than the whole plan.` : data.allocation.text}
          </Text>
        )}
        {data.allocation?.text && <Text> </Text>}
        {p.weeklyPct !== null || p.fiveHourPct !== null ? (
          <Box flexDirection="column">
            <Text weight="bold">Claude plan</Text>
            {p.weeklyPct !== null && (
              <Text>
                {'  weekly  '}
                <Text color={planColor(p.weeklyPct)}>
                  {bar(p.weeklyPct / 100)} {`${p.weeklyPct}%`}
                </Text>
                <Text dimColor>{p.weeklyResets ? `  resets ${p.weeklyResets}` : ''}</Text>
              </Text>
            )}
            {p.fiveHourPct !== null && (
              <Text>
                {'  5-hour  '}
                <Text color={planColor(p.fiveHourPct)}>
                  {bar(p.fiveHourPct / 100)} {`${p.fiveHourPct}%`}
                </Text>
              </Text>
            )}
          </Box>
        ) : (
          <Text>{planLine}</Text>
        )}
        <Text dimColor>{calLine}</Text>
        {data.errors.length > 0 && <Text color="warning">{`budgets.yaml: ${data.errors[0]}`}</Text>}
        {problem && <Text color="warning">{`last refresh failed: ${problem}`}</Text>}
        {notice && <Text color="suggestion">{notice}</Text>}
        {form.open && (
          <Box key="form" flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
            <Text weight="bold">New bucket</Text>
            <Input key="f-name" label="name   " placeholder="e.g. writing" value={form.name} autoFocus
              onInput={v => setDraft($, 'name', v)} onSubmit={() => createBucket($)} submitLabel="create" />
            <Box flexDirection="row" gap={1}>
              <Input key="f-paths" label="folders" placeholder="optional, e.g. ~/writing, ~/notes" value={form.paths}
                onInput={v => setDraft($, 'paths', v)} onSubmit={() => createBucket($)} submitLabel="create" />
              <Button key="f-here" label="this folder" dimColor onPress={() => useThisFolder($)} />
            </Box>
            <Input key="f-limit" label="limit  " placeholder={limitHint(data)} value={form.limit}
              onInput={v => setDraft($, 'limit', v)} onSubmit={() => createBucket($)} submitLabel="create" />
            <Select key="f-period" label="period " value={form.period}
              options={[{ value: 'weekly' }, { value: 'monthly' }, { value: 'daily' }]}
              onSelect={v => setDraft($, 'period', v)} />
            {form.period !== 'daily' && (
              <Input key="f-reset" label="resets " placeholder={form.period === 'monthly' ? 'day 1-31 (default 1)' : 'weekday (default mon)'}
                value={form.reset} onInput={v => setDraft($, 'reset', v)} onSubmit={() => createBucket($)} submitLabel="create" />
            )}
            <Select key="f-mode" label="mode   " value={form.mode}
              options={[{ value: 'warn', label: 'warn (never blocks)' }, { value: 'block', label: 'block at 100%' }]}
              onSelect={v => setDraft($, 'mode', v)} />
            <Box flexDirection="row" gap={1}>
              <Button key="f-create" label="Create bucket" variant="primary" onPress={() => createBucket($)} />
              <Button key="f-cancel" label="Cancel" dimColor onPress={() => toggleForm($)} />
            </Box>
          </Box>
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="refresh" label="↻ refresh" dimColor onPress={() => refreshNow($)} />
          {!form.open && <Button key="new" label="＋ new bucket" dimColor onPress={() => toggleForm($)} />}
          <Button key="edit" label="✎ edit budgets" dimColor onPress={() => editBudgets($)} />
        </Box>
        <Text dimColor>{`updated ${time} · * default bucket · /budget-pane reopens`}</Text>
      </Box>
    )
  })
}
