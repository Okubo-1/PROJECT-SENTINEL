import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

import { Alert, Badge, Button, Card, DetailList, EmptyState, Icon, PageHeader, Skeleton, buttonVariants } from '../../components/ui'
import type { IconName } from '../../lib/icons'
import type { Role } from '../../types'
import { companySettingsEventMatchesOrganization, companySettingsUpdatedEvent } from '../../lib/companySettingsSync'
import { incidentReportTypes, type IncidentReportType } from './incidentTypes'
import { IncidentReportForm } from './IncidentReportForm'
import { useIncident, useIncidentOrganization } from './useIncidentData'
import { getOfflineAnonymousDraft, listOfflineAnonymousDrafts } from './anonymousDraftQueue'
import type { AnonymousDraftQueueItem } from './anonymousDraftQueue'
import { getAnonymousDraftOwnerToken, getIncident } from './incidentService'

const reportTypeDetails: Record<IncidentReportType, { label: string; description: string; icon: IconName }> = {
  incident: {
    label: 'Report Incident',
    description: 'Record an actual undesired event involving injury, damage, environmental impact, or operational disruption.',
    icon: 'reportIncident',
  },
  near_miss: {
    label: 'Report Near Miss',
    description: 'Capture an event that could reasonably have caused harm, damage, or loss but did not.',
    icon: 'eye',
  },
  unsafe_act: {
    label: 'Report Unsafe Act',
    description: 'Report an unsafe behavior or action observed during work.',
    icon: 'warning',
  },
  unsafe_condition: {
    label: 'Report Unsafe Condition',
    description: 'Report an unsafe physical, environmental, or workplace condition.',
    icon: 'construction',
  },
  environmental_incident: {
    label: 'Report Environmental Incident',
    description: 'Record an event involving actual or potential environmental impact.',
    icon: 'leaf',
  },
}

// Report types are gated by the caller's report_incident permission, not by a
// hardcoded role list: custom roles and management roles can report too.
const defaultReportTypes: IncidentReportType[] = [...incidentReportTypes]

export type QuickIncidentOption = {
  id: string
  title: string
  reportType: IncidentReportType
  category: string
  environmentalImpact?: boolean
}

// New reports start here: the user's role controls available report types, and active organization categories become quick options.
// Choosing a quick option pre-fills the form; opening an existing draft skips this chooser and restores that report directly.
export function IncidentTypeSelectionPage({ role, supabase, draftId, reportTypes = defaultReportTypes }: { role: Role; supabase: SupabaseClient; draftId?: string | null; reportTypes?: IncidentReportType[] }) {
  const allowedTypes = useMemo(() => reportTypes, [reportTypes])
  const organization = useIncidentOrganization(supabase)
  const initialType = allowedTypes[0] || null
  const [selectedType, setSelectedType] = useState<IncidentReportType | null>(initialType)
  const [selectedQuickId, setSelectedQuickId] = useState<string | null>(null)
  const [selectedTitle, setSelectedTitle] = useState<string>(initialType ? reportTypeDetails[initialType].label.replace('Report ', '') : 'Incident')
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [selectedEnvironmentalImpact, setSelectedEnvironmentalImpact] = useState<boolean>(initialType === 'environmental_incident')
  const [isFormOpen, setIsFormOpen] = useState(false)
  const draft = useIncident(supabase, draftId || null)
  const [configuredCategories, setConfiguredCategories] = useState<string[]>([])
  const [offlineDrafts, setOfflineDrafts] = useState<AnonymousDraftQueueItem[]>([])
  const [selectedOfflineDraft, setSelectedOfflineDraft] = useState<AnonymousDraftQueueItem | null>(null)
  const [offlineError, setOfflineError] = useState('')

  useEffect(() => {
    if (!organization.data?.userId || draftId) return
    let active = true
    const load = () => {
      void listOfflineAnonymousDrafts(supabase).then((drafts) => {
        if (active) { setOfflineDrafts(drafts); setOfflineError('') }
      }).catch(() => {
        if (active) setOfflineError('Connect to the internet to verify ownership and recover anonymous drafts saved on this device.')
      })
    }
    load()
    window.addEventListener('online', load)
    return () => { active = false; window.removeEventListener('online', load) }
  }, [organization.data?.userId, draftId, supabase])

  useEffect(() => {
    if (!organization.data?.organizationId) return
    let active = true
    const organizationId = organization.data.organizationId
    const loadCategories = () => {
      void supabase
        .from('company_settings')
        .select('incident_categories')
        .eq('organization_id', organizationId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (!active || error) return
          const categories = Array.isArray(data?.incident_categories) ? data.incident_categories.flatMap((item: unknown) => {
            if (typeof item === 'string') return item.trim() ? [item.trim()] : []
            if (!item || typeof item !== 'object') return []
            const entry = item as { name?: unknown; active?: unknown; deleted?: unknown }
            return typeof entry.name === 'string' && entry.name.trim() && entry.active !== false && entry.deleted !== true ? [entry.name.trim()] : []
          }) : []
          setConfiguredCategories(categories)
        })
    }
    const handleSettingsUpdated = (event: Event) => {
      if (companySettingsEventMatchesOrganization(event, organizationId)) loadCategories()
    }
    loadCategories()
    window.addEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    return () => {
      active = false
      window.removeEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    }
  }, [organization.data?.organizationId, supabase])

  const quickIncidentOptions: QuickIncidentOption[] = configuredCategories.map((category) => ({
    id: category.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    title: category,
    reportType: 'incident',
    category,
    environmentalImpact: /environment|spill|chemical|oil/i.test(category),
  }))

  const handleSelectReportType = (type: IncidentReportType) => {
    setSelectedType(type)
    setSelectedQuickId(null)
    const label = reportTypeDetails[type]?.label.replace('Report ', '') || 'Incident'
    setSelectedTitle(label)
    setSelectedCategory('')
    setSelectedEnvironmentalImpact(type === 'environmental_incident')
  }

  const handleSelectQuickOption = (option: QuickIncidentOption) => {
    setSelectedQuickId(option.id)
    setSelectedType(option.reportType)
    setSelectedTitle(option.title)
    setSelectedCategory(option.category)
    setSelectedEnvironmentalImpact(!!option.environmentalImpact)
  }

  const continueToReport = () => {
    if (!selectedType) return
    setIsFormOpen(true)
  }

  const resumeOfflineDraft = async (id: string) => {
    if (!navigator.onLine) {
      setOfflineError('Saved anonymous drafts can only be reopened online after verifying their owner.')
      return
    }
    try {
      const ownerToken = await getAnonymousDraftOwnerToken(supabase)
      const item = await getOfflineAnonymousDraft(id, ownerToken)
      if (item.serverDraftId) {
        const serverDraft = await getIncident(supabase, item.serverDraftId)
        if (!serverDraft.isAnonymous || serverDraft.status !== 'draft') throw new Error('Draft unavailable.')
        if (!item.pending) {
          window.location.assign(`#report-incident?draft=${item.serverDraftId}`)
          return
        }
      }
      setSelectedOfflineDraft(item)
      setOfflineError('')
    } catch {
      setOfflineError('Unable to verify or reopen this draft. Connect to the internet and try again.')
    }
  }

  if (!allowedTypes.length) {
    return (
      <EmptyState
        icon="reportIncident"
        title="Reporting is not available"
        description="Your current role does not have permission to create incident reports. Contact your organization administrator if your access should change."
        action={<a href="#dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Return to dashboard</a>}
      />
    )
  }

  if (draftId) {
    if (!navigator.onLine) {
      return (
        <EmptyState
          icon="incidents"
          title="Draft unavailable offline"
          description="Saved drafts can only be reopened online. Anonymous draft ownership must be verified before access."
          action={<a href="#report-incident" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Return to reporting</a>}
        />
      )
    }
    if (draft.isLoading) {
      return (
        <div className="grid gap-5">
          <PageHeader eyebrow="Report incident" title="Report an incident" description="Restoring the draft." />
          <Skeleton className="h-[320px] rounded-card" />
        </div>
      )
    }
    if (draft.isError || !draft.data || draft.data.status !== 'draft') {
      return (
        <EmptyState
          icon="incidents"
          title="Draft unavailable"
          description="This draft could not be loaded or is no longer editable."
          action={<a href="#my-reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Return to My Reports</a>}
        />
      )
    }
    return <IncidentReportForm supabase={supabase} reportType={draft.data.reportType} draftId={draft.data.id} initialIncident={draft.data} />
  }

  if (selectedOfflineDraft) {
    return <IncidentReportForm supabase={supabase} reportType={selectedOfflineDraft.input.reportType} offlineDraft={selectedOfflineDraft} />
  }

  if (isFormOpen && selectedType) {
    return (
      <IncidentReportForm
        supabase={supabase}
        reportType={selectedType}
        initialTitle={selectedTitle}
        initialCategory={selectedCategory}
        initialEnvironmentalImpact={selectedEnvironmentalImpact}
      />
    )
  }

  const selectedDetail = selectedType ? reportTypeDetails[selectedType] : null

  return (
    <div className="grid gap-5 pb-24 lg:pb-0">
      <PageHeader
        eyebrow="Report incident"
        title="What would you like to report?"
        description={<><span className="block text-foreground">Reporting helps us fix problems and keep everyone safe. This is not about blame.</span><span className="block">Select the report type or a quick field event. Each selection pre-fills the report.</span></>}
        actions={<a href="#my-reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>My reports</a>}
      />

      {offlineError && <Alert tone="danger">{offlineError}</Alert>}
      {offlineDrafts.length > 0 && (
        <Card className="p-5 shadow-none">
          <h2 className="font-display text-base font-semibold">Anonymous drafts on this device</h2>
          <p className="mt-1 text-sm text-muted">Only drafts belonging to your verified account are shown.</p>
          <div className="mt-3 grid gap-2">
            {offlineDrafts.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3">
                <span className="text-sm">{item.input.title || 'Untitled draft'} · {item.pending ? 'Pending sync' : 'Synced'}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void resumeOfflineDraft(item.id)}>Resume</Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {allowedTypes.map((type) => {
              const detail = reportTypeDetails[type]
              const selected = selectedType === type && !selectedQuickId
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => handleSelectReportType(type)}
                  aria-pressed={selected}
                  className={`flex items-start gap-3 rounded-card border p-4 text-left transition-colors ${selected ? 'border-brand bg-brand/5' : 'border-line bg-surface hover:border-brand/40'}`}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                    <Icon name={detail.icon} size={20} />
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <strong className="text-sm font-semibold text-foreground">{detail.label}</strong>
                    <span className="text-xs leading-relaxed text-muted">{detail.description}</span>
                  </span>
                  <span className={`ml-auto mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-brand bg-brand text-white' : 'border-line'}`} aria-hidden="true">
                    {selected && <Icon name="check" size={10} />}
                  </span>
                </button>
              )
            })}
          </div>

          {quickIncidentOptions.length > 0 && (
            <Card className="p-5 shadow-none">
              <div className="grid gap-0.5">
                <h2 className="font-display text-base font-semibold text-foreground">Quick classifications</h2>
                <p className="text-sm text-muted">Optional. Selecting one pre-fills the incident category.</p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {quickIncidentOptions.map((option) => {
                  const selected = selectedQuickId === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => handleSelectQuickOption(option)}
                      aria-pressed={selected}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${selected ? 'border-brand bg-brand/10 text-brand-dark' : 'border-line bg-surface text-muted hover:text-foreground'}`}
                    >
                      {option.title}
                    </button>
                  )
                })}
              </div>
            </Card>
          )}
        </div>

        <Card className="sticky top-24 hidden h-fit p-5 shadow-none lg:block">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Your report</span>
            <Badge tone="neutral">Selection</Badge>
          </div>
          <div className="mt-3 grid gap-1">
            <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">{selectedTitle}</h2>
            <p className="text-sm text-muted">{selectedDetail?.description || 'Choose a report type to continue.'}</p>
          </div>
          <DetailList
            className="mt-4"
            columns={1}
            items={[
              { label: 'Report type', value: selectedDetail?.label || 'Not selected' },
              { label: 'Category', value: selectedCategory || 'Not set' },
              { label: 'Reporting as', value: role },
            ]}
          />
          <div className="mt-5 grid gap-2">
            <Button onClick={continueToReport} disabled={!selectedType}>
              Continue to report <Icon name="arrowRight" size={15} />
            </Button>
            <a href="#dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Cancel</a>
          </div>
        </Card>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-line bg-surface/95 p-3 backdrop-blur lg:hidden">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Selected</span>
          <strong className="truncate text-sm font-medium text-foreground">{selectedTitle}</strong>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a href="#dashboard" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>Cancel</a>
          <Button size="sm" onClick={continueToReport} disabled={!selectedType}>Continue</Button>
        </div>
      </div>
    </div>
  )
}
