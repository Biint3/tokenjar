export type PanelBucket = {
  name: string
  period: string
  used: string
  limit: string | null
  planPct: number | null
  fraction: number | null
  percent: string | null
  left: string | null
  level: 'none' | 'ok' | 'warn' | 'over'
  mode: string
  blocking: boolean
  resets: string
  isDefault: boolean
  isSession: boolean
  configured: boolean
  extendBy: string | null
}

export type PanelPlan = {
  weeklyPct: number | null
  weeklyResets: string | null
  fiveHourPct: number | null
  perPct: string | null
  points: number
  needed: number
  shares: { bucket: string; pct: number }[] | null
  claudeCodePct: number | null
}

export type PanelData = {
  metric: string
  session: { bucket: string; reason: string | null; isSet: boolean } | null
  buckets: PanelBucket[]
  plan: PanelPlan
  errors: string[]
  generated: string
}

export type PanelView = {
  data: PanelData | null
  problem: string | null
  updatedAt: number | null
  notice: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'tokenjar-pane': { view: Shaped<PanelView> }
  }
}
