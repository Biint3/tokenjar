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
  /** The default_bucket, named but not listed under buckets (often a rename that missed default_bucket). */
  unlisted?: boolean
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

export type PanelAllocation = {
  total: number
  over: boolean
  text: string | null
  unknown: string[]
}

export type PanelData = {
  metric: string
  allocation?: PanelAllocation
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

/** The "new bucket" form while it is being filled in. */
export type BucketDraft = {
  open: boolean
  name: string
  paths: string
  limit: string
  period: string
  reset: string
  mode: string
}

declare module 'claude-code' {
  interface PluginState {
    'tokenjar-pane': { view: Shaped<PanelView>; draft: Shaped<BucketDraft> }
  }
}
