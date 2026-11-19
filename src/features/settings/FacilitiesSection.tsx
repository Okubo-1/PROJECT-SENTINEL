import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

import { Alert, Button, Field, Input, Select, Toggle } from '../../components/ui'
import { notifyCompanySettingsUpdated } from '../../lib/companySettingsSync'
import { recordActivity } from '../../lib/activity'
import type { DepartmentOption, SiteOption } from './companySettingsTypes'
import { SettingsSectionShell } from './SettingsSectionShell'

type Facility = {
  id: string
  name: string
  site_id: string | null
  department_key: string | null
  active: boolean
  archived_at: string | null
}
type PersistedSite = { id: string; name: string }

export function FacilitiesSection({ client, organizationId, userId, sites, departments, initialParent = '' }: {
  client: SupabaseClient
  organizationId: string
  userId: string
  sites: SiteOption[]
  departments: DepartmentOption[]
  initialParent?: string
}) {
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [persistedSites, setPersistedSites] = useState<PersistedSite[]>([])
  const [parent, setParent] = useState(initialParent)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const fetchFacilities = useCallback(async () => {
    const [facilityResult, siteResult] = await Promise.all([
      client.from('facilities').select('id, name, site_id, department_key, active, archived_at').eq('organization_id', organizationId).order('name'),
      client.from('sites').select('id, name').eq('organization_id', organizationId).order('name'),
    ])
    if (facilityResult.error || siteResult.error) throw new Error(facilityResult.error?.message || siteResult.error?.message || 'Unable to load facilities.')
    return { facilities: facilityResult.data || [], sites: siteResult.data || [] }
  }, [client, organizationId])

  useEffect(() => {
    let active = true
    void fetchFacilities().then((result) => {
      if (!active) return
      setFacilities(result.facilities)
      setPersistedSites(result.sites)
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load facilities.')
    })
    return () => { active = false }
  }, [fetchFacilities])

  const load = async () => {
    const result = await fetchFacilities()
    setFacilities(result.facilities)
    setPersistedSites(result.sites)
  }

  const availableSites = persistedSites.filter((site) => sites.some((configured) => !configured.deleted && configured.active && configured.name.trim().toLowerCase() === site.name.trim().toLowerCase()))
  const visible = facilities.filter((facility) => !facility.archived_at && (parent.startsWith('site:') ? facility.site_id === parent.slice(5) : parent.startsWith('department:') && facility.department_key === parent.slice(11)))

  const save = async () => {
    const trimmed = name.trim()
    if (!parent || !trimmed) {
      setError('Select a site or department and enter a facility name.')
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = editing
        ? await client.from('facilities').update({ name: trimmed }).eq('organization_id', organizationId).eq('id', editing).select('id').single()
        : await client.from('facilities').insert({
            organization_id: organizationId,
            site_id: parent.startsWith('site:') ? parent.slice(5) : null,
            department_key: parent.startsWith('department:') ? parent.slice(11) : null,
            name: trimmed,
            code: crypto.randomUUID(),
          }).select('id').single()
      if (result.error) throw new Error(result.error.message)
      setName('')
      setEditing(null)
      await load()
      notifyCompanySettingsUpdated(organizationId)
      setMessage(editing ? 'Facility updated.' : 'Facility added.')
      await recordActivity(organizationId, userId, editing ? 'Facility updated' : 'Facility added', { facility_id: result.data.id })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save the facility.')
    } finally {
      setBusy(false)
    }
  }

  const update = async (facility: Facility, values: { active?: boolean; archived_at?: string }) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { error: updateError } = await client.from('facilities').update(values).eq('organization_id', organizationId).eq('id', facility.id).select('id').single()
      if (updateError) throw new Error(updateError.message)
      await load()
      notifyCompanySettingsUpdated(organizationId)
      setMessage(values.archived_at ? 'Facility archived.' : 'Facility status updated.')
      await recordActivity(organizationId, userId, values.archived_at ? 'Facility archived' : 'Facility status updated', { facility_id: facility.id, active: values.active })
      if (editing === facility.id && values.archived_at) { setEditing(null); setName('') }
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update the facility.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSectionShell title="Facilities and areas" description="Manage facilities for saved, enabled sites and departments." dirty={false}>
      {error && <Alert tone="danger">{error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}
      <Field label="Site or department" htmlFor="facility-parent">
        <Select id="facility-parent" value={parent} disabled={Boolean(initialParent)} onChange={(event) => { setParent(event.target.value); setEditing(null); setName('') }}>
          <option value="">Select a site or department</option>
          <optgroup label="Sites">{availableSites.map((site) => <option key={site.id} value={`site:${site.id}`}>{site.name}</option>)}</optgroup>
          <optgroup label="Departments">{departments.filter((department) => department.active && !department.deleted).map((department) => <option key={department.id} value={`department:${department.id}`}>{department.name}</option>)}</optgroup>
        </Select>
      </Field>
      {parent && (
        <>
          {visible.length ? visible.map((facility) => (
            <div key={facility.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-4 py-3">
              <span className="text-sm text-foreground">{facility.name}</span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{facility.active ? 'Enabled' : 'Disabled'}</span>
                <Toggle checked={facility.active} onCheckedChange={(active) => void update(facility, { active })} disabled={busy} aria-label={`Enable ${facility.name}`} />
                <Button variant="outline" size="sm" disabled={busy} onClick={() => { setEditing(facility.id); setName(facility.name) }}>Edit</Button>
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void update(facility, { archived_at: new Date().toISOString(), active: false })}>Archive</Button>
              </div>
            </div>
          )) : <p className="text-sm text-muted">No facilities configured for this parent.</p>}
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save() }}>
            <Field label={editing ? 'Edit facility name' : 'Add facility / area'} htmlFor="facility-name" className="min-w-[220px] flex-1">
              <Input id="facility-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={240} />
            </Field>
            <Button type="submit" loading={busy}>{editing ? 'Save' : 'Add another facility'}</Button>
            {editing && <Button variant="outline" disabled={busy} onClick={() => { setEditing(null); setName('') }}>Cancel</Button>}
          </form>
        </>
      )}
    </SettingsSectionShell>
  )
}
