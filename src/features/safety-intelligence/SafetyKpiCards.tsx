import type { ReactNode } from 'react'
import type { SafetySnapshot } from '../../../supabase/functions/_shared/safetyIntelligenceContracts'
import { Badge, Icon, type IconProps } from '../../components/ui'
import { cn } from '../../lib/utils'

// Round for presentation only; the server already assigned the band using the unrounded score.
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 1 })
const signed = (value: number) => `${value > 0 ? '+' : ''}${number(value)}`

type Tone = 'teal' | 'blue' | 'green' | 'amber' | 'red'
const TONE_CLASS: Record<Tone, string> = {
  teal: 'bg-brand/10 text-brand',
  blue: 'bg-ink/5 text-foreground',
  green: 'bg-brand/10 text-brand',
  amber: 'bg-caution/10 text-caution',
  red: 'bg-danger/10 text-danger',
}
const BAND_TONE = { High: 'danger', Medium: 'warning', Low: 'success' } as const

function MetricCard({ title, value, children, band, tone = 'blue', icon }: {
  title: string
  value: ReactNode
  children: ReactNode
  band?: 'High' | 'Medium' | 'Low' | null
  tone?: Tone
  icon: IconProps['name']
}) {
  return <article className={cn(
    'safety-kpi flex min-h-[148px] min-w-0 flex-col gap-2 break-words rounded-card border border-line bg-surface p-4 shadow-none',
    `safety-kpi-${tone}`,
    band && `safety-risk-${band.toLowerCase()}`,
  )}>
    <div className="flex items-start justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', TONE_CLASS[tone])}>
        <Icon name={icon} size={16} />
      </span>
    </div>
    <strong className="safety-kpi-value break-words font-display text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</strong>
    <div className="safety-kpi-description grid gap-1.5 text-xs text-muted">
      {band && <Badge tone={BAND_TONE[band]} className="w-fit">{band}</Badge>}
      {children}
    </div>
  </article>
}

function Reasons({ reasons }: { reasons: string[] }) {
  return reasons.length
    ? <ul className="safety-kpi-reasons grid gap-1 pl-4">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    : null
}

export function SafetyKpiCards({ snapshot }: { snapshot: SafetySnapshot }) {
  const { metrics, coverage, dataQuality } = snapshot
  const { risk, highRisk, category, resolution } = metrics
  const { incidentCounts } = metrics
  const hasReports = category.denominator > 0
  const complete = (source: SafetySnapshot['coverage'][number]['source']) => coverage.some((entry) => entry.source === source && entry.complete)
  const riskAvailable = risk.state === 'available' && risk.score !== null && risk.band !== null
  // Partial counts can be useful if labeled; a missing metric must never become an invented zero.
  const highKnown = hasReports && (highRisk.state === 'available' || highRisk.state === 'incomplete')
  // Only canonical rankings are used; never infer "highest" from a truncated or unknown cohort.
  const location = snapshot.locations.find((entry) => entry.level === 'site' && entry.highRiskCount > 0)
  const locationAvailable = Boolean(location && complete('incidents') && complete('sites'))
  return <div className="safety-kpi-grid grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Safety Intelligence metrics">
    {(['total', 'open', 'closed'] as const).map((kind) => <MetricCard key={kind}
      tone={kind === 'total' ? 'blue' : kind === 'open' ? 'amber' : 'green'}
      icon={kind === 'total' ? 'incidents' : kind === 'open' ? 'warning' : 'success'}
      title={`${kind === 'total' ? 'Total' : kind === 'open' ? 'Open' : 'Closed'} Incidents`}
      value={incidentCounts ? number(incidentCounts[kind]) : 'Unavailable'}>
      {incidentCounts?.state === 'incomplete' && <span>Known counts only</span>}
      {incidentCounts?.state === 'incomplete' && <small>Known counts only; incomplete reporting coverage.</small>}
      {!incidentCounts && <small>The deployed snapshot endpoint does not yet provide incident counts.</small>}
      {incidentCounts && <Reasons reasons={incidentCounts.reasons} />}
    </MetricCard>)}
    <MetricCard title="Drafts" icon="file" tone="teal" value={incidentCounts?.draftScope === 'organization_open' && incidentCounts.drafts !== undefined ? number(incidentCounts.drafts) : 'Unavailable'}>
      <small>{incidentCounts?.draftScope === 'organization_open'
        ? 'Open drafts across the organization; dashboard filters do not apply.'
        : 'The deployed analytics service does not yet provide an organization-wide draft total.'}</small>
    </MetricCard>
    <MetricCard title="AI Risk Level" icon="target" tone={riskAvailable ? risk.band === 'High' ? 'red' : risk.band === 'Medium' ? 'amber' : 'green' : 'teal'}
      value={riskAvailable && risk.score !== null ? `${number(risk.score)} / 100` : 'Insufficient data'} band={riskAvailable ? risk.band : null}>
      {!riskAvailable && <span>{risk.state === 'incomplete' ? 'Incomplete coverage' : 'Risk index unavailable'}</span>}
      <small>{risk.sampleSize} classified reports. Not ML or accident probability.</small>
    </MetricCard>
    <MetricCard title="High-Risk Incidents" tone="red" icon="danger" value={highKnown ? number(highRisk.count) : 'Unavailable'}>
      {highKnown && <small>{number(highRisk.openCount)} still open</small>}
      {highKnown && <small>{number(highRisk.closedCount ?? Math.max(0, highRisk.count - highRisk.openCount))} closed</small>}
      {highKnown && highRisk.state === 'incomplete' && <small>Known counts only; incomplete coverage.</small>}
      {!hasReports && <small>No eligible reports in this window.</small>}
      <Reasons reasons={highRisk.reasons} />
    </MetricCard>
    <MetricCard title="Near Miss" tone="teal" icon="trendingUp" value={incidentCounts?.nearMiss !== undefined ? number(incidentCounts.nearMiss) : 'Unavailable'}>
      <small>Near-miss reports in the selected reporting window.</small>
      {incidentCounts?.state === 'incomplete' && <small>Known counts only; incomplete reporting coverage.</small>}
    </MetricCard>
    <MetricCard title="Most Common Reported Category" tone="blue" icon="layers" value={category.state === 'available' && category.label ? category.label : 'Unavailable'}>
      {category.state === 'available' && category.share !== null && <span>{number(category.share)}% of {category.denominator} reported events</span>}
      <Reasons reasons={category.reasons} />
    </MetricCard>
    <MetricCard title="Highest Risk Site" tone="red" icon="location" value={locationAvailable ? location?.name : 'Unavailable'}>
      {locationAvailable && location && <span>{number(location.highRiskCount)} High/Critical incidents · {number(location.count)} total incidents</span>}
      {!locationAvailable && <small>{!hasReports ? 'No eligible reports in this window.' : 'Complete incident and site retrieval is required for a reliable ranking.'}</small>}
      {dataQuality.unassignedFacility > 0 && <small>{dataQuality.unassignedFacility} reports lack an available site assignment and are excluded from site rankings.</small>}
    </MetricCard>
    <MetricCard title="Average Resolution Time" tone="teal" icon="clock"
      value={resolution.state === 'available' && resolution.averageDays !== null ? `${number(resolution.averageDays)} days` : 'Unavailable'}>
      {resolution.state === 'available' && resolution.sampleSize > 0 && <small>{number(resolution.sampleSize)} valid closures in this window</small>}
      {resolution.state === 'incomplete' && <small>Known counts only; incomplete closure coverage.</small>}
      {resolution.state === 'available' && resolution.changeDays !== null && resolution.previousSampleSize > 0 && <small>{signed(resolution.changeDays)} days versus previous period ({resolution.previousSampleSize} closures)</small>}
    </MetricCard>
  </div>
}
