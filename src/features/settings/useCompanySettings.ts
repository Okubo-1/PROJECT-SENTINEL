import { useEffect, useMemo, useState } from 'react'

import { recordActivity } from '../../lib/activity'
import { notifyCompanySettingsUpdated } from '../../lib/companySettingsSync'
import { normalizeIncidentCategoryName } from '../../lib/incidentCategory'
import { supabase } from '../../lib/supabase'
import {
  defaultDepartmentSuggestions,
  defaultIncidentCategorySuggestions,
  defaultSeveritySuggestions,
  defaultShiftTemplates,
  hasDuplicateNames,
  isValidEmail,
  normalizeDepartmentSettings,
  normalizeEmergencyContacts,
  normalizeIncidentCategorySettings,
  normalizeSeveritySettings,
  normalizeShiftSettings,
  normalizeSiteSettings,
  type CompanySettingsState,
  type CompanyShiftSetting,
  type DepartmentOption,
  type EmergencyContact,
  type IncidentCategoryOption,
  type SeverityOption,
  type SiteOption,
} from './companySettingsTypes'

type SettingsSnapshot = {
  shifts: CompanyShiftSetting[]
  departments: DepartmentOption[]
  sites: SiteOption[]
  contacts: EmergencyContact[]
  severities: SeverityOption[]
  categories: IncidentCategoryOption[]
}

type DeletableCategory = 'shift' | 'department' | 'site' | 'severity' | 'incident_category'
type EditableNameCategory = Exclude<DeletableCategory, 'shift' | 'site'>
type DeletableOption = CompanyShiftSetting | DepartmentOption | SiteOption | SeverityOption | IncidentCategoryOption
type RestoreCandidate = { id: string; name: string; category: DeletableCategory }

function settingsSaveErrorMessage(code: string | undefined, errorMessage: string | undefined) {
  const message = errorMessage?.toLowerCase() || ''
  if (message.includes('cannot_create_archived_item')) {
    return 'An archived setting could not be saved with the current changes. Reload settings and try again.'
  }
  if (message.includes('configuration_restore_required')) {
    return 'Archived configuration must be restored from Archive before it can be used again.'
  }
  if (message.includes('archived_item_exists')) {
    return 'A configuration item with this name is archived. Restore it from Archive before reusing the name.'
  }
  if (message.includes('duplicate_configuration_name') || message.includes('duplicate_site_name') || code === '23505') {
    return 'A configuration item with this name already exists. Choose a different name and try again.'
  }
  if (code === '42501') {
    return 'You do not have permission to save these company settings. Ask an organization administrator for access.'
  }
  if (code === '40001' || code === '40P01' || code === '55P03' || code === '57014') {
    return 'The settings could not be saved because the update was interrupted or conflicted with another change. Retry; if it continues, reload settings first.'
  }
  if (/failed to fetch|network|connection|timed? out|timeout/i.test(message)) {
    return 'Unable to reach the settings service. Check your connection and try again. Your changes are still on this page.'
  }
  if (code === '23514' || code?.startsWith('22')) {
    return 'One or more settings are not valid for this organization. Review the values and try again.'
  }
  return `Company settings could not be saved${code ? ` (error ${code})` : ''}. Your changes are still on this page. Retry, and share this error code with support if it happens again.`
}

function markDeleted<T extends { id: string; deleted?: boolean }>(items: T[], id: string) {
  return items.map((item) => item.id === id ? { ...item, deleted: true } : item)
}

function omitDeletedItems<T extends { deleted?: boolean }>(items: T[]) {
  // Archiving is persisted through the archive RPC; the database trigger retains archived entries on normal settings updates.
  return items.filter((item) => !item.deleted)
}

function upsertRestored<T extends { id: string; deleted?: boolean }>(items: T[], restoredItem: T) {
  const activeItem = { ...restoredItem, deleted: false }
  return items.some((item) => item.id === restoredItem.id)
    ? items.map((item) => item.id === restoredItem.id ? activeItem : item)
    : [...items, activeItem]
}

function getSnapshotItem(snapshot: SettingsSnapshot, category: DeletableCategory, id: string): DeletableOption | undefined {
  switch (category) {
    case 'shift': return snapshot.shifts.find((item) => item.id === id)
    case 'department': return snapshot.departments.find((item) => item.id === id)
    case 'site': return snapshot.sites.find((item) => item.id === id)
    case 'severity': return snapshot.severities.find((item) => item.id === id)
    case 'incident_category': return snapshot.categories.find((item) => item.id === id)
  }
}

function markSnapshotItemDeleted(snapshot: SettingsSnapshot, category: DeletableCategory, id: string): SettingsSnapshot {
  switch (category) {
    case 'shift': return { ...snapshot, shifts: markDeleted(snapshot.shifts, id) }
    case 'department': return { ...snapshot, departments: markDeleted(snapshot.departments, id) }
    case 'site': return { ...snapshot, sites: markDeleted(snapshot.sites, id) }
    case 'severity': return { ...snapshot, severities: markDeleted(snapshot.severities, id) }
    case 'incident_category': return { ...snapshot, categories: markDeleted(snapshot.categories, id) }
  }
}

const emptyContact: EmergencyContact = { id: '', name: '', role: '', phone: '', email: '', active: true }
const emptyShift: CompanyShiftSetting = { id: '', name: 'Day', start: '07:00', end: '19:00', active: true }

function defaultSnapshot(): SettingsSnapshot {
  return {
    shifts: defaultShiftTemplates,
    departments: defaultDepartmentSuggestions.map((name) => ({ id: `default:department:${name.toLowerCase()}`, name, active: true })),
    sites: [],
    contacts: [],
    severities: defaultSeveritySuggestions.map((name) => ({ id: `default:severity:${name.toLowerCase()}`, name, active: true })),
    categories: defaultIncidentCategorySuggestions.map((name) => ({ id: `default:incident_category:${name.toLowerCase()}`, name, active: true })),
  }
}

export function useCompanySettings({ organizationId, userId }: { organizationId: string; userId: string }) {
  const [settings, setSettings] = useState<CompanySettingsState>({ working_hours: '{}', departments: '[]', operational_sites: '[]', emergency_contacts: '[]', incident_categories: '[]', risk_categories: '[]', severity_levels: '[]', inspection_templates: '[]' })
  const [shifts, setShifts] = useState<CompanyShiftSetting[]>(defaultShiftTemplates)
  const [departments, setDepartments] = useState<DepartmentOption[]>(defaultDepartmentSuggestions.map((name) => ({ id: `default:department:${name.toLowerCase()}`, name, active: true })))
  const [sites, setSites] = useState<SiteOption[]>([])
  const [contacts, setContacts] = useState<EmergencyContact[]>([])
  const [severities, setSeverities] = useState<SeverityOption[]>(defaultSeveritySuggestions.map((name) => ({ id: `default:severity:${name.toLowerCase()}`, name, active: true })))
  const [categories, setCategories] = useState<IncidentCategoryOption[]>(defaultIncidentCategorySuggestions.map((name) => ({ id: `default:incident_category:${name.toLowerCase()}`, name, active: true })))
  const [departmentDraft, setDepartmentDraft] = useState('')
  const [siteDraft, setSiteDraft] = useState('')
  const [siteCodeDraft, setSiteCodeDraft] = useState('')
  const [severityDraft, setSeverityDraft] = useState('')
  const [categoryDraft, setCategoryDraft] = useState('')
  const [contactDraft, setContactDraft] = useState<EmergencyContact>(emptyContact)
  const [shiftDraft, setShiftDraft] = useState<CompanyShiftSetting>(emptyShift)
  const [shiftOpen, setShiftOpen] = useState(false)
  const [siteOpen, setSiteOpen] = useState(false)
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null)
  const [nameEditTarget, setNameEditTarget] = useState<{ category: EditableNameCategory; id: string } | null>(null)
  const [nameEditDraft, setNameEditDraft] = useState('')
  const [contactOpen, setContactOpen] = useState(false)
  const [contactToRemove, setContactToRemove] = useState<EmergencyContact | null>(null)
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<RestoreCandidate | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [baseline, setBaseline] = useState<SettingsSnapshot | null>(null)

  useEffect(() => {
    let active = true
    const loadSettings = async () => {
      setLoading(true)
      setError('')
      const { data, error: settingsError } = await supabase
        .from('company_settings')
        .select('working_hours, departments, operational_sites, emergency_contacts, incident_categories, risk_categories, severity_levels, inspection_templates')
        .eq('organization_id', organizationId)
        .maybeSingle()
      if (!active) return
      if (settingsError) {
        setError(settingsError.message)
        setBaseline(defaultSnapshot())
        setLoading(false)
        return
      }
      if (data) {
        setSettings(Object.fromEntries(Object.entries(data).map(([key, value]) => [key, JSON.stringify(value, null, 2)])) as CompanySettingsState)
        const loadedShifts = normalizeShiftSettings(data.working_hours)
        const nextShifts = loadedShifts.length ? loadedShifts : defaultShiftTemplates
        const loadedDepartments = normalizeDepartmentSettings(data.departments)
        const nextDepartments = loadedDepartments.length ? loadedDepartments : defaultDepartmentSuggestions.map((name) => ({ id: `default:department:${name.toLowerCase()}`, name, active: true }))
        const nextSites = normalizeSiteSettings(data.operational_sites)
        const nextContacts = normalizeEmergencyContacts(data.emergency_contacts)
        const loadedSeverities = normalizeSeveritySettings(data.severity_levels)
        const nextSeverities = data.severity_levels == null ? defaultSeveritySuggestions.map((name) => ({ id: `default:severity:${name.toLowerCase()}`, name, active: true })) : loadedSeverities
        const loadedCategories = normalizeIncidentCategorySettings(data.incident_categories)
        const nextCategories = data.incident_categories == null ? defaultIncidentCategorySuggestions.map((name) => ({ id: `default:incident_category:${name.toLowerCase()}`, name, active: true })) : loadedCategories
        setShifts(nextShifts)
        setDepartments(nextDepartments)
        setSites(nextSites)
        setContacts(nextContacts)
        setSeverities(nextSeverities)
        setCategories(nextCategories)
        setBaseline({ shifts: nextShifts, departments: nextDepartments, sites: nextSites, contacts: nextContacts, severities: nextSeverities, categories: nextCategories })
      } else {
        setBaseline(defaultSnapshot())
      }
      setLoading(false)
    }
    void loadSettings()
    return () => { active = false }
  }, [organizationId])

  const snapshot = useMemo<SettingsSnapshot>(() => ({ shifts, departments, sites, contacts, severities, categories }), [shifts, departments, sites, contacts, severities, categories])
  const dirtySections = useMemo(() => {
    if (!baseline) return []
    const changed: string[] = []
    if (JSON.stringify(snapshot.shifts) !== JSON.stringify(baseline.shifts)) changed.push('shifts')
    if (JSON.stringify(snapshot.departments) !== JSON.stringify(baseline.departments)) changed.push('departments')
    if (JSON.stringify(snapshot.sites) !== JSON.stringify(baseline.sites)) changed.push('sites')
    if (JSON.stringify(snapshot.contacts) !== JSON.stringify(baseline.contacts)) changed.push('contacts')
    if (JSON.stringify(snapshot.severities) !== JSON.stringify(baseline.severities)) changed.push('severity')
    if (JSON.stringify(snapshot.categories) !== JSON.stringify(baseline.categories)) changed.push('categories')
    return changed
  }, [baseline, snapshot])
  const dirty = dirtySections.length > 0

  useEffect(() => {
    if (!dirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  const clearFeedback = () => {
    setError('')
    setMessage('')
  }

  const checkArchivedName = async (category: DeletableCategory, name: string) => {
    const { data, error: lookupError } = await supabase.rpc('find_company_configuration_archive_match', {
      p_organization_id: organizationId,
      p_category: category,
      p_name: name.trim(),
    })
    if (lookupError) {
      setError('Unable to check archived configuration. Check your connection and try again.')
      return false
    }
    if (data === null) return true

    if (typeof data !== 'object' || !('id' in data) || !('name' in data)) {
      setError('Unable to verify archived configuration. Reload settings and try again.')
      return false
    }
    const match = data as { id: unknown; name: unknown }
    if (typeof match.id !== 'string' || typeof match.name !== 'string') {
      setError('Unable to verify archived configuration. Reload settings and try again.')
      return false
    }
    setPendingRestore({ id: match.id, name: match.name, category })
    return false
  }

  const toggleShift = (id: string) => {
    clearFeedback()
    setShifts((current) => current.map((shift) => shift.id === id && !shift.deleted ? { ...shift, active: !shift.active } : shift))
  }

  const toggleDepartment = (name: string) => {
    clearFeedback()
    setDepartments((current) => current.map((department) => department.name.toLowerCase() === name.toLowerCase() && !department.deleted ? { ...department, active: !department.active } : department))
  }

  const toggleSite = (name: string) => {
    clearFeedback()
    setSites((current) => current.map((site) => site.name.toLowerCase() === name.toLowerCase() && !site.deleted ? { ...site, active: !site.active } : site))
  }

  const toggleContact = (id: string) => {
    clearFeedback()
    setContacts((current) => current.map((contact) => contact.id === id ? { ...contact, active: !contact.active } : contact))
  }

  const toggleSeverity = (name: string) => {
    clearFeedback()
    setSeverities((current) => current.map((severity) => severity.name.toLowerCase() === name.toLowerCase() && !severity.deleted ? { ...severity, active: !severity.active } : severity))
  }

  const toggleCategory = (name: string) => {
    clearFeedback()
    setCategories((current) => current.map((category) => category.name.toLowerCase() === name.toLowerCase() && !category.deleted ? { ...category, active: !category.active } : category))
  }

  const openSiteEditor = (site?: SiteOption) => {
    clearFeedback()
    setEditingSiteId(site?.id ?? null)
    setSiteDraft(site?.name ?? '')
    setSiteCodeDraft(site?.code ?? '')
    setSiteOpen(true)
  }

  const closeSiteEditor = () => {
    setSiteOpen(false)
    setEditingSiteId(null)
    setSiteDraft('')
    setSiteCodeDraft('')
    clearFeedback()
  }

  const openNameEditor = (category: EditableNameCategory, item: DepartmentOption | SeverityOption | IncidentCategoryOption) => {
    clearFeedback()
    setNameEditTarget({ category, id: item.id })
    setNameEditDraft(item.name)
  }

  const closeNameEditor = () => {
    setNameEditTarget(null)
    setNameEditDraft('')
    clearFeedback()
  }

  const saveNameEdit = async () => {
    if (!nameEditTarget) return false
    const { category, id } = nameEditTarget
    const rawName = nameEditDraft.trim()
    const name = category === 'incident_category' ? normalizeIncidentCategoryName(rawName) : rawName
    clearFeedback()
    if (!name) {
      setError('A name is required.')
      return false
    }

    const currentItems = category === 'department' ? departments : category === 'severity' ? severities : categories
    const currentItem = currentItems.find((item) => item.id === id)
    if (!currentItem) {
      setError('This configuration item is no longer available. Reload settings and try again.')
      return false
    }
    if (currentItems.some((item) => item.id !== id && !item.deleted && item.name.trim().toLowerCase() === name.toLowerCase())) {
      setError(`That ${category === 'department' ? 'department' : category === 'severity' ? 'severity level' : 'incident category'} already exists.`)
      return false
    }
    if (name.toLowerCase() !== currentItem.name.trim().toLowerCase() && !await checkArchivedName(category, name)) return false

    const updateName = <T extends { id: string; name: string }>(items: T[]) =>
      items.map((item) => item.id === id ? { ...item, name } : item)
    if (category === 'department') setDepartments((items) => updateName(items))
    else if (category === 'severity') setSeverities((items) => updateName(items))
    else setCategories((items) => updateName(items))

    setNameEditTarget(null)
    setNameEditDraft('')
    setMessage(`${name} updated — save to apply.`)
    return true
  }

  const deleteSettingItem = async (category: DeletableCategory, item: DeletableOption) => {
    if (item.deleted) {
      setError('This configuration item has already been deleted.')
      return false
    }

    setDeleting(true)
    clearFeedback()
    try {
      const savedItem = baseline ? getSnapshotItem(baseline, category, item.id) : undefined
      if (!savedItem || savedItem.name !== item.name) {
        const saved = await saveSettings()
        if (!saved) return false
      }

      const { error: deleteError } = await supabase.rpc('delete_company_setting_item', {
        p_organization_id: organizationId,
        p_category: category,
        p_item_id: item.id,
        p_item_name: item.name,
      })
      if (deleteError) {
        const message = deleteError.message.toLowerCase()
        if (deleteError.code === 'PGRST202' || deleteError.code === '42883') {
          setError('Configuration deletion is not installed in the database yet. Apply migration 202611040001_company_configuration_soft_delete.sql, then retry.')
        } else if (deleteError.code === '42501' || message.includes('not_authorized') || message.includes('not_authenticated')) {
          setError('You do not have permission to delete this configuration item.')
        } else if (message.includes('already_deleted')) {
          setError('This configuration item has already been deleted.')
        } else if (message.includes('item_not_found')) {
          setError('This configuration item no longer exists. Reload settings and try again.')
        } else {
          setError('Unable to delete this configuration item. Check your connection and try again.')
        }
        return false
      }

      const deletedId = item.id
      switch (category) {
        case 'shift':
          setShifts((current) => markDeleted(current, deletedId))
          break
        case 'department':
          setDepartments((current) => markDeleted(current, deletedId))
          break
        case 'site':
          setSites((current) => markDeleted(current, deletedId))
          break
        case 'severity':
          setSeverities((current) => markDeleted(current, deletedId))
          break
        case 'incident_category':
          setCategories((current) => markDeleted(current, deletedId))
          break
      }
      setBaseline((current) => current ? markSnapshotItemDeleted(current, category, deletedId) : current)
      notifyCompanySettingsUpdated(organizationId)
      setLastSavedAt(new Date())
      setMessage(`${item.name} deleted from future configuration options.`)
      return true
    } catch {
      setError('Unable to delete this configuration item. Check your connection and try again.')
      return false
    } finally {
      setDeleting(false)
    }
  }

  const restoreSettingItem = async (category: DeletableCategory, id: string, name: string) => {
    setRestoring(true)
    clearFeedback()
    try {
      const { data, error: restoreError } = await supabase.rpc('restore_company_configuration_item', {
        p_organization_id: organizationId,
        p_category: category,
        p_item_id: id,
      })
      if (restoreError) {
        const message = restoreError.message.toLowerCase()
        if (restoreError.code === 'PGRST202' || restoreError.code === '42883') {
          setError('Configuration archive restoration is not installed in the database yet. Apply migration 202611040002_company_configuration_archive_restore.sql after migration 202611040001_company_configuration_soft_delete.sql.')
        } else if (restoreError.code === '42501' || message.includes('not_authorized') || message.includes('not_authenticated')) {
          setError('You do not have permission to restore this configuration item.')
        } else if (message.includes('not_archived') || message.includes('item_not_found')) {
          setError('This archived item is no longer available. Reload the archive and try again.')
        } else if (message.includes('archived_item_exists') || message.includes('duplicate_configuration_name')) {
          setError('An item with this name already exists in this category. Resolve the duplicate before restoring it.')
        } else {
          setError('Unable to restore this configuration item. Check your connection and try again.')
        }
        return false
      }

      const response = data as { item?: unknown } | null
      if (!response?.item) {
        setError('The item was restored, but its settings could not be refreshed. Reload the page to see it.')
        return false
      }

      switch (category) {
        case 'shift': {
          const restored = normalizeShiftSettings({ shifts: [response.item] })[0]
          if (!restored) break
          setShifts((current) => upsertRestored(current, restored))
          setBaseline((current) => current ? { ...current, shifts: upsertRestored(current.shifts, restored) } : current)
          break
        }
        case 'department': {
          const restored = normalizeDepartmentSettings([response.item])[0]
          if (!restored) break
          setDepartments((current) => upsertRestored(current, restored))
          setBaseline((current) => current ? { ...current, departments: upsertRestored(current.departments, restored) } : current)
          break
        }
        case 'site': {
          const restored = normalizeSiteSettings([response.item])[0]
          if (!restored) break
          setSites((current) => upsertRestored(current, restored))
          setBaseline((current) => current ? { ...current, sites: upsertRestored(current.sites, restored) } : current)
          break
        }
        case 'severity': {
          const restored = normalizeSeveritySettings([response.item])[0]
          if (!restored) break
          setSeverities((current) => upsertRestored(current, restored))
          setBaseline((current) => current ? { ...current, severities: upsertRestored(current.severities, restored) } : current)
          break
        }
        case 'incident_category': {
          const restored = normalizeIncidentCategorySettings([response.item])[0]
          if (!restored) break
          setCategories((current) => upsertRestored(current, restored))
          setBaseline((current) => current ? { ...current, categories: upsertRestored(current.categories, restored) } : current)
          break
        }
      }
      notifyCompanySettingsUpdated(organizationId)
      setLastSavedAt(new Date())
      setMessage(`${name} restored to company configuration.`)
      return true
    } catch {
      setError('Unable to restore this configuration item. Check your connection and try again.')
      return false
    } finally {
      setRestoring(false)
    }
  }

  const restorePendingItem = async () => {
    if (!pendingRestore) return false
    const restored = await restoreSettingItem(pendingRestore.category, pendingRestore.id, pendingRestore.name)
    if (!restored) return false

    switch (pendingRestore.category) {
      case 'shift':
        setShiftOpen(false)
        setEditingShiftId(null)
        setShiftDraft(emptyShift)
        break
      case 'department':
        setDepartmentDraft('')
        break
      case 'site':
        setSiteDraft('')
        setSiteCodeDraft('')
        setSiteOpen(false)
        break
      case 'severity':
        setSeverityDraft('')
        break
      case 'incident_category':
        setCategoryDraft('')
        break
    }
    setPendingRestore(null)
    return true
  }

  const addDepartment = async () => {
    const name = departmentDraft.trim()
    setError('')
    setMessage('')
    if (!name) {
      setError('Department name is required.')
      return false
    }
    if (!await checkArchivedName('department', name)) return false
    if (departments.some((department) => !department.deleted && department.name.trim().toLowerCase() === name.toLowerCase())) {
      setError('That department already exists.')
      return false
    }
    setDepartments((current) => [...current, { id: crypto.randomUUID(), name, active: true }])
    setDepartmentDraft('')
    setMessage('Department added — save to apply.')
    return true
  }

  const openShiftEditor = (shift?: CompanyShiftSetting) => {
    setShiftDraft(shift ? { ...shift } : emptyShift)
    setEditingShiftId(shift ? shift.id : null)
    setError('')
    setMessage('')
    setShiftOpen(true)
  }

  const saveShift = async () => {
    const name = shiftDraft.name.trim()
    setError('')
    if (!name) {
      setError('Shift name is required.')
      return
    }
    if (!editingShiftId && !await checkArchivedName('shift', name)) return
    if (shifts.some((shift) => !shift.deleted && shift.id !== editingShiftId && shift.name.trim().toLowerCase() === name.toLowerCase())) {
      setError('That shift already exists.')
      return
    }
    const nextShift: CompanyShiftSetting = {
      ...shiftDraft,
      id: shiftDraft.id || crypto.randomUUID(),
      name,
      active: shiftDraft.active !== false,
    }
    setShifts((current) => editingShiftId ? current.map((shift) => shift.id === editingShiftId ? nextShift : shift) : [...current, nextShift])
    setShiftOpen(false)
    setEditingShiftId(null)
    setShiftDraft(emptyShift)
    setMessage('Shift saved — save to apply.')
  }

  const addSite = async () => {
    const name = siteDraft.trim()
    setError('')
    setMessage('')
    if (!name) {
      setError('Site name is required.')
      return false
    }
    const editingSite = editingSiteId ? sites.find((site) => site.id === editingSiteId) : null
    if (!editingSite && !await checkArchivedName('site', name)) return false
    if (editingSite && name.toLowerCase() !== editingSite.name.trim().toLowerCase()
      && !await checkArchivedName('site', name)) return false
    if (sites.some((site) => site.id !== editingSiteId && !site.deleted && site.name.trim().toLowerCase() === name.toLowerCase())) {
      setError('That site already exists.')
      return false
    }
    if (!siteCodeDraft) {
      setError('Generate a site code before adding the site.')
      return false
    }
    setSites((current) => editingSiteId
      ? current.map((site) => site.id === editingSiteId ? { ...site, name, code: siteCodeDraft } : site)
      : [...current, { id: crypto.randomUUID(), name, active: true, code: siteCodeDraft }])
    setSiteDraft('')
    setSiteCodeDraft('')
    setSiteOpen(false)
    setEditingSiteId(null)
    setMessage(editingSite ? 'Site updated — save to apply.' : 'Site added — save to apply.')
    return true
  }

  const openContactEditor = (contact?: EmergencyContact) => {
    setContactDraft(contact ? { ...contact } : emptyContact)
    setError('')
    setMessage('')
    setContactOpen(true)
  }

  const saveContact = () => {
    const name = contactDraft.name.trim()
    const phone = contactDraft.phone.trim()
    const email = contactDraft.email.trim()
    setError('')
    if (!name || !phone) {
      setError('Contact name and phone number are required.')
      return
    }
    if (!isValidEmail(email)) {
      setError('Enter a valid contact email address.')
      return
    }
    if (contacts.some((contact) => contact.id !== contactDraft.id && contact.name.toLowerCase() === name.toLowerCase())) {
      setError('That emergency contact already exists.')
      return
    }
    const nextContact: EmergencyContact = { ...contactDraft, id: contactDraft.id || `contact-${Date.now()}`, name, role: contactDraft.role.trim(), phone, email }
    setContacts((current) => contactDraft.id ? current.map((contact) => contact.id === contactDraft.id ? nextContact : contact) : [...current, nextContact])
    setContactOpen(false)
    setMessage('Emergency contact saved — save to apply.')
  }

  const removeContact = () => {
    if (!contactToRemove) return
    setContacts((current) => current.filter((contact) => contact.id !== contactToRemove.id))
    setContactToRemove(null)
    setMessage('Emergency contact removed — save to apply.')
  }

  const addSeverity = async () => {
    const name = severityDraft.trim()
    setError('')
    setMessage('')
    if (!name) {
      setError('Severity name is required.')
      return
    }
    if (!await checkArchivedName('severity', name)) return
    if (severities.some((severity) => !severity.deleted && severity.name.trim().toLowerCase() === name.toLowerCase())) {
      setError('That severity level already exists.')
      return
    }
    setSeverities((current) => [...current, { id: crypto.randomUUID(), name, active: true }])
    setSeverityDraft('')
    setMessage('Severity level added — save to apply.')
  }

  const addIncidentCategory = async () => {
    const name = normalizeIncidentCategoryName(categoryDraft)
    setError('')
    setMessage('')
    if (!name) {
      setError('Incident category is required.')
      return
    }
    if (!await checkArchivedName('incident_category', name)) return
    if (categories.some((category) => !category.deleted && category.name.trim().toLowerCase() === name.toLowerCase())) {
      setError('That incident category already exists.')
      return
    }
    setCategories((current) => [...current, { id: crypto.randomUUID(), name, active: true }])
    setCategoryDraft('')
    setMessage('Incident category added — save to apply.')
  }

  const discardChanges = () => {
    if (!baseline) return
    setShifts(baseline.shifts)
    setDepartments(baseline.departments)
    setSites(baseline.sites)
    setContacts(baseline.contacts)
    setSeverities(baseline.severities)
    setCategories(baseline.categories)
    setDepartmentDraft('')
    setSeverityDraft('')
    setCategoryDraft('')
    setShiftOpen(false)
    setSiteOpen(false)
    setEditingSiteId(null)
    setNameEditTarget(null)
    setNameEditDraft('')
    setContactOpen(false)
    setContactToRemove(null)
    setError('')
    setMessage('Unsaved changes discarded.')
  }

  const saveSettings = async (): Promise<boolean> => {
    setError('')
    setMessage('')
    setSaving(true)
    try {
      const nextShifts = omitDeletedItems(shifts)
      const nextWorkingHours = { shifts: nextShifts }
      const nextDepartments = omitDeletedItems(departments).filter((department) => department.name.trim())
      const nextSites = omitDeletedItems(sites).filter((site) => site.name.trim())
      const nextContacts = contacts.filter((contact) => contact.name.trim() && contact.phone.trim())
      const nextSeverities = omitDeletedItems(severities).filter((severity) => severity.name.trim())
      const nextCategories = omitDeletedItems(categories).filter((category) => category.name.trim())
      if (hasDuplicateNames(nextDepartments) || hasDuplicateNames(nextSites) || hasDuplicateNames(nextSeverities) || hasDuplicateNames(nextCategories) || hasDuplicateNames(nextContacts)) {
        setError('Duplicate configuration names are not allowed.')
        return false
      }
      if (shifts.some((shift) => !shift.name.trim())) {
        setError('Each shift must have a name.')
        return false
      }
      if (contacts.some((contact) => !contact.name.trim() || !contact.phone.trim() || !isValidEmail(contact.email.trim()))) {
        setError('Each emergency contact requires a name, phone number, and valid email if provided.')
        return false
      }
      const mergedSettings = {
        ...settings,
        working_hours: JSON.stringify(nextWorkingHours, null, 2),
        departments: JSON.stringify(nextDepartments, null, 2),
        operational_sites: JSON.stringify(nextSites, null, 2),
        emergency_contacts: JSON.stringify(nextContacts, null, 2),
        incident_categories: JSON.stringify(nextCategories, null, 2),
        risk_categories: settings.risk_categories || JSON.stringify([], null, 2),
        severity_levels: JSON.stringify(nextSeverities, null, 2),
        inspection_templates: settings.inspection_templates || JSON.stringify([], null, 2),
      }

      let parsed: Record<string, unknown>
      try {
        parsed = Object.fromEntries(Object.entries(mergedSettings).map(([key, value]) => [key, JSON.parse(value)]))
      } catch {
        setError('Each settings field must contain valid JSON.')
        return false
      }

      const { data: existingSites, error: existingSitesError } = await supabase
        .from('sites')
        .select('id, name, code')
        .eq('organization_id', organizationId)
      if (existingSitesError) {
        setError(settingsSaveErrorMessage(existingSitesError.code, existingSitesError.message))
        return false
      }

      const existingSiteNames = new Set((existingSites || []).map((site) => site.name.trim().toLowerCase()))
      for (const site of nextSites) {
        const previous = baseline?.sites.find((candidate) => candidate.id === site.id && !candidate.deleted)
        const existing = previous
          ? (existingSites || []).find((candidate) => candidate.name.trim().toLowerCase() === previous.name.trim().toLowerCase())
          : undefined
        if (!existing || (existing.name === site.name && (!site.code || existing.code === site.code))) continue
        const { error: siteUpdateError } = await supabase.from('sites')
          .update({ name: site.name.trim(), ...(site.code ? { code: site.code } : {}) })
          .eq('organization_id', organizationId)
          .eq('id', existing.id)
        if (siteUpdateError) {
          setError(settingsSaveErrorMessage(siteUpdateError.code, siteUpdateError.message))
          return false
        }
        existingSiteNames.delete(existing.name.trim().toLowerCase())
        existingSiteNames.add(site.name.trim().toLowerCase())
      }

      const sitesToCreate = nextSites.filter((site) => site.active && !site.deleted && !existingSiteNames.has(site.name.trim().toLowerCase()))
      if (sitesToCreate.length) {
        const { error: siteSyncError } = await supabase.from('sites').insert(sitesToCreate.map((site) => ({
          organization_id: organizationId,
          name: site.name.trim(),
          ...(site.code ? { code: site.code } : {}),
        })))
        if (siteSyncError) {
          setError(settingsSaveErrorMessage(siteSyncError.code, siteSyncError.message))
          return false
        }
      }

      const { error: saveError } = await supabase.from('company_settings').upsert({ organization_id: organizationId, ...parsed })
      if (saveError) {
        setError(settingsSaveErrorMessage(saveError.code, saveError.message))
        return false
      }
      await recordActivity(organizationId, userId, 'Company settings changed')
      notifyCompanySettingsUpdated(organizationId)
      setMessage('Company settings saved.')
      setLastSavedAt(new Date())
      setBaseline(snapshot)
      return true
    } catch (saveError) {
      setError(saveError instanceof TypeError
        ? settingsSaveErrorMessage(undefined, saveError.message || 'network error')
        : 'An unexpected error interrupted the save. Your changes are still on this page. Retry, and contact support if it happens again.')
      return false
    } finally {
      setSaving(false)
    }
  }

  return {
    loading,
    saving,
    deleting,
    restoring,
    pendingRestore,
    clearPendingRestore: () => setPendingRestore(null),
    error,
    message,
    lastSavedAt,
    dirty,
    dirtySections,
    shifts,
    departments,
    sites,
    contacts,
    severities,
    categories,
    departmentDraft,
    setDepartmentDraft,
    siteDraft,
    setSiteDraft,
    siteCodeDraft,
    setSiteCodeDraft,
    severityDraft,
    setSeverityDraft,
    categoryDraft,
    setCategoryDraft,
    contactDraft,
    setContactDraft,
    shiftDraft,
    setShiftDraft,
    shiftOpen,
    setShiftOpen,
    siteOpen,
    setSiteOpen,
    editingSiteId,
    nameEditTarget,
    nameEditDraft,
    setNameEditDraft,
    contactOpen,
    setContactOpen,
    contactToRemove,
    setContactToRemove,
    editingShiftId,
    toggleShift,
    toggleDepartment,
    toggleSite,
    toggleContact,
    toggleSeverity,
    toggleCategory,
    deleteSettingItem,
    restoreSettingItem,
    restorePendingItem,
    addDepartment,
    addSite,
    openSiteEditor,
    closeSiteEditor,
    openNameEditor,
    closeNameEditor,
    saveNameEdit,
    addSeverity,
    addIncidentCategory,
    openShiftEditor,
    saveShift,
    openContactEditor,
    saveContact,
    removeContact,
    discardChanges,
    saveSettings,
    clearFeedback,
  }
}
