import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, MouseEvent, ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useQueryClient } from '@tanstack/react-query'

import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  FileUpload,
  FilterBar,
  FormActions,
  FormFull,
  FormGrid,
  FormSection,
  Icon,
  Input,
  PageHeader,
  SearchField,
  Select,
  Tabs,
  Textarea,
  buttonVariants,
} from '../../components/ui'
import type { DataTableColumn, FileUploadItem } from '../../components/ui'
import { createInspection, downloadQhseFile, getInspectionWorkspace, validateQhseFile } from './inspectionActionService'
import type { InspectionRecord, QhsePerson, QhseSite } from './inspectionActionService'
import { companySettingsEventMatchesOrganization, companySettingsUpdatedEvent } from '../../lib/companySettingsSync'
import { InvestigationRegister } from './InvestigationRegister'

const acceptedFileTypes = 'image/jpeg,image/png,image/webp,application/pdf'

function localDateTime() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid min-w-[180px] gap-1 text-[11px] font-medium text-muted">
      {label}
      {children}
    </label>
  )
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-line sm:border-l sm:pl-5 sm:first:border-l-0 sm:first:pl-0">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</span>
      <span className="font-display text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</span>
    </div>
  )
}

export function InspectionNavigationButtons({ canManageActions }: { canManageActions: boolean }) {
  const openActions = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    const returnKey = crypto.randomUUID()
    sessionStorage.setItem(`actions-return:${returnKey}`, 'inspections')
    window.location.hash = `#corrective-actions?return=${returnKey}`
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canManageActions && (
        <a
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          href="#corrective-actions"
          onClick={openActions}
        >
          <Icon name="correctiveActions" size={15} />
          Actions
        </a>
      )}
      <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href="#dashboard">
        <Icon name="dashboard" size={15} />
        Dashboard
      </a>
    </div>
  )
}

export function InspectionWorkspace({
  supabase,
  canManageActions = false,
  canCreate = true,
  canViewInvestigations = false,
}: {
  supabase: SupabaseClient
  canManageActions?: boolean
  canCreate?: boolean
  canViewInvestigations?: boolean
}) {
  const queryClient = useQueryClient()
  const [sites, setSites] = useState<QhseSite[]>([])
  const [activeSites, setActiveSites] = useState<QhseSite[]>([])
  const [people, setPeople] = useState<QhsePerson[]>([])
  const [inspections, setInspections] = useState<InspectionRecord[]>([])
  const [siteId, setSiteId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [findings, setFindings] = useState('')
  const [inspectionDate, setInspectionDate] = useState(localDateTime)
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'success' | 'warning'>('success')
  const [organizationId, setOrganizationId] = useState('')
  const [activeTab, setActiveTab] = useState(canCreate ? 'log' : 'recent')
  const [query, setQuery] = useState('')
  const [siteFilter, setSiteFilter] = useState('all')
  const [rangeFilter, setRangeFilter] = useState<'30' | '90' | 'all'>('all')
  const [currentTime, setCurrentTime] = useState(() => Date.now())

  const refresh = useCallback(async (background = false) => {
    if (!background) setLoading(true)
    try {
      const data = await getInspectionWorkspace(supabase)
      setOrganizationId(data.organizationId)
      setSites(data.sites)
      setActiveSites(data.activeSites)
      setPeople(data.people)
      setInspections(data.inspections)
      setSiteId((current) => current || data.activeSites[0]?.id || '')
      setError('')
    } finally {
      if (!background) setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    let active = true
    void getInspectionWorkspace(supabase)
      .then((data) => {
        if (!active) return
        setError('')
        setOrganizationId(data.organizationId)
        setSites(data.sites)
        setActiveSites(data.activeSites)
        setPeople(data.people)
        setInspections(data.inspections)
        setSiteId(data.activeSites[0]?.id || '')
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load inspections.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [supabase])

  useEffect(() => {
    if (!organizationId) return
    const handleSettingsUpdated = (event: Event) => {
      if (!companySettingsEventMatchesOrganization(event, organizationId)) return
      void refresh(true).catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : 'Unable to refresh inspections.')
      })
    }
    window.addEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    return () => window.removeEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
  }, [organizationId, refresh])

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const reload = () => {
    setError('')
    setMessage('')
    void refresh().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load inspections.')
    })
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      validateQhseFile(file)
      const result = await createInspection(supabase, { siteId, title, description, findings, inspectionDate, file })
      await refresh()
      if (organizationId) await queryClient.invalidateQueries({ queryKey: ['dashboard', organizationId] })
      setTitle('')
      setDescription('')
      setFindings('')
      setInspectionDate(localDateTime())
      setFile(null)
      setMessageTone(result.uploadWarning ? 'warning' : 'success')
      setMessage(result.uploadWarning || 'Inspection logged successfully.')
      setActiveTab('recent')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to log this inspection.')
    } finally {
      setBusy(false)
    }
  }

  const siteName = (id: string) => sites.find((site) => site.id === id)?.name || 'Site unavailable'
  const inspectorName = (id: string) => people.find((person) => person.id === id)?.full_name || 'Organization user'

  const filteredInspections = inspections.filter((inspection) => {
    const searchText = [
      inspection.inspection_title,
      inspection.description,
      siteName(inspection.site_id),
      inspectorName(inspection.inspected_by),
    ]
      .join(' ')
      .toLowerCase()
    if (query.trim() && !searchText.includes(query.trim().toLowerCase())) return false
    if (siteFilter !== 'all' && inspection.site_id !== siteFilter) return false
    if (rangeFilter !== 'all' && new Date(inspection.inspection_date).getTime() < currentTime - Number(rangeFilter) * 86_400_000) return false
    return true
  })

  const last30Count = inspections.filter(
    (inspection) => new Date(inspection.inspection_date).getTime() >= currentTime - 30 * 86_400_000,
  ).length
  const sitesCovered = new Set(inspections.map((inspection) => inspection.site_id)).size
  const filesAttached = inspections.filter((inspection) => inspection.file_storage_path && inspection.file_name).length
  const uploadedFiles: FileUploadItem[] = file
    ? [{ id: 'inspection-file', name: file.name, size: file.size, type: file.type }]
    : []

  const resetFilters = () => {
    setQuery('')
    setSiteFilter('all')
    setRangeFilter('all')
  }

  const download = (inspection: InspectionRecord) => {
    const path = inspection.file_storage_path
    const name = inspection.file_name
    if (!path || !name) return
    void downloadQhseFile(supabase, path, name).catch((downloadError: unknown) => {
      setError(downloadError instanceof Error ? downloadError.message : 'Unable to download this file.')
    })
  }

  const columns: DataTableColumn<InspectionRecord>[] = [
    {
      id: 'inspection',
      header: 'Inspection',
      cell: (inspection) => (
        <div className="grid min-w-[260px] gap-0.5">
          <strong className="text-sm font-medium text-foreground">{inspection.inspection_title}</strong>
          <span className="line-clamp-2 text-xs text-muted">{inspection.description}</span>
        </div>
      ),
    },
    {
      id: 'site',
      header: 'Site',
      cell: (inspection) => <span className="whitespace-nowrap text-sm">{siteName(inspection.site_id)}</span>,
    },
    {
      id: 'inspector',
      header: 'Inspector',
      cell: (inspection) => <span className="whitespace-nowrap text-sm">{inspectorName(inspection.inspected_by)}</span>,
    },
    {
      id: 'inspectionDate',
      header: 'Inspection date',
      cell: (inspection) => (
        <span className="whitespace-nowrap font-mono text-xs tabular-nums">{formatDateTime(inspection.inspection_date)}</span>
      ),
    },
    {
      id: 'created',
      header: 'Created',
      cell: (inspection) => (
        <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted">{formatDate(inspection.created_at)}</span>
      ),
    },
    {
      id: 'file',
      header: 'File',
      align: 'right',
      cell: (inspection) =>
        inspection.file_storage_path && inspection.file_name ? (
          <Button type="button" variant="outline" size="sm" onClick={() => download(inspection)}>
            <Icon name="download" size={14} />
            View
          </Button>
        ) : (
          <span className="text-xs text-muted">None</span>
        ),
    },
  ]

  const logTab = (
    <Card className="p-5 sm:p-6">
      <form className="grid gap-6" onSubmit={(event) => void submit(event)}>
        <FormSection
          title="Inspection details"
          description="Record what was inspected and what you found. Required fields are validated before the inspection is saved."
        >
          <FormGrid>
            <Field
              label="Site"
              htmlFor="inspection-site"
              required
              hint={!loading && !sites.length ? 'Add a site in Settings before logging an inspection.' : undefined}
            >
              <Select
                id="inspection-site"
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
                disabled={loading || !sites.length}
                required
              >
                <option value="">Select a site</option>
                {activeSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Inspection date and time" htmlFor="inspection-date" required>
              <Input
                id="inspection-date"
                type="datetime-local"
                value={inspectionDate}
                onChange={(event) => setInspectionDate(event.target.value)}
                required
              />
            </Field>
            <FormFull>
              <Field label="Inspection title" htmlFor="inspection-title" required hint="A short name for the inspection.">
                <Input
                  id="inspection-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  minLength={3}
                  maxLength={160}
                  placeholder="e.g. Daily rig walkaround"
                  required
                />
              </Field>
            </FormFull>
            <FormFull>
              <Field label="Inspection description" htmlFor="inspection-description" required>
                <Textarea
                  id="inspection-description"
                  rows={4}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What was inspected, and where?"
                  required
                />
              </Field>
            </FormFull>
            <FormFull>
              <Field label="Findings and conclusions" htmlFor="inspection-findings" required>
                <Textarea
                  id="inspection-findings"
                  rows={5}
                  value={findings}
                  onChange={(event) => setFindings(event.target.value)}
                  placeholder="What did you find? Note anything that needs follow-up."
                  required
                />
              </Field>
            </FormFull>
            <FormFull>
              <Field label="Optional photo or file" hint="JPG, PNG, WebP, or PDF up to 10 MB.">
                <FileUpload
                  files={uploadedFiles}
                  onFilesSelected={(files) => setFile(files[0] || null)}
                  onRemove={() => setFile(null)}
                  accept={acceptedFileTypes}
                  maxSizeMb={10}
                  variant="compact"
                  label="Attach a photo or file"
                  disabled={busy}
                />
              </Field>
            </FormFull>
          </FormGrid>
        </FormSection>
        <FormActions>
          <Button type="submit" loading={busy} disabled={loading || !sites.length}>
            {busy ? 'Saving inspection...' : 'Log inspection'}
          </Button>
        </FormActions>
      </form>
    </Card>
  )

  const recentTab = (
    <div className="grid gap-5">
      <section className="border-y border-line">
        <div className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-4">
          <SummaryStat label="Inspections" value={loading ? '—' : String(inspections.length)} />
          <SummaryStat label="Last 30 days" value={loading ? '—' : String(last30Count)} />
          <SummaryStat label="Sites covered" value={loading ? '—' : String(sitesCovered)} />
          <SummaryStat label="Files attached" value={loading ? '—' : String(filesAttached)} />
        </div>
      </section>

      {(loading || inspections.length > 0) && (
        <FilterBar
          actions={
            <>
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                Reset filters
              </Button>
              <Button variant="outline" size="sm" onClick={reload} loading={loading}>
                <Icon name="refresh" size={15} />
                Refresh
              </Button>
            </>
          }
        >
          <label className="grid min-w-[240px] flex-1 gap-1 text-[11px] font-medium text-muted">
            Search
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Title, site, or inspector"
              label="Search inspections"
            />
          </label>
          <FilterField label="Site">
            <Select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)}>
              <option value="all">All sites</option>
              {activeSites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField label="Inspection date">
            <Select
              value={rangeFilter}
              onChange={(event) => setRangeFilter(event.target.value as '30' | '90' | 'all')}
            >
              <option value="all">All time</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </Select>
          </FilterField>
        </FilterBar>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">Inspection register</h2>
          <p className="text-sm text-muted">
            {loading
              ? 'Loading inspection records…'
              : `${filteredInspections.length} of ${inspections.length} records · latest 100`}
          </p>
        </div>
      </div>

      {!loading && inspections.length === 0 ? (
        <EmptyState
          icon="inspections"
          title="No inspections logged yet"
          description={
            canCreate
              ? 'Log the first field inspection to start the register.'
              : 'Inspections logged for this organization will appear here.'
          }
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setActiveTab('log')}>
                <Icon name="plus" size={15} />
                Log inspection
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={filteredInspections}
          rowKey={(inspection) => inspection.id}
          loading={loading}
          loadingRows={5}
          empty={
            <div className="grid justify-items-center gap-1">
              <strong className="text-sm font-semibold text-foreground">No inspections match these filters</strong>
              <span className="text-sm text-muted">Try a different site, date range, or search.</span>
            </div>
          }
        />
      )}
    </div>
  )

  const tabs = [
    ...(canCreate ? [{ id: 'log', label: 'Log inspection', content: logTab }] : []),
    { id: 'recent', label: 'Recent inspections', content: recentTab },
    ...(canViewInvestigations && organizationId
      ? [{ id: 'investigations', label: 'Investigations', content: <InvestigationRegister client={supabase} organizationId={organizationId} /> }]
      : []),
  ]

  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Operations & QHSE"
        title="Inspections"
        description="Log field inspections and review the latest records for your organization."
        actions={<InspectionNavigationButtons canManageActions={canManageActions} />}
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {message && <Alert tone={messageTone}>{message}</Alert>}

      <Tabs
        items={tabs}
        value={canCreate || canViewInvestigations ? activeTab : 'recent'}
        onChange={(id) => setActiveTab(id)}
        className="gap-5"
      />
    </div>
  )
}
