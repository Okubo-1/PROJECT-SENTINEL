import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'

import heroFacility from '../../assets/hero-facility.jpg'
import { executiveAnalyticsAccessMessage } from '../../app/messages'
import { futureModuleRoutes, primaryNavigation, secondaryNavigation } from '../../app/navigation'
import { getAppRoute, type AppRoute } from '../../app/routes'
import { BrandMark } from '../../components/brand/BrandMark'
import { Alert, Button, Card, DropdownMenu, Spinner, Tooltip } from '../../components/ui'
import type { DropdownMenuItem } from '../../components/ui'
import { CommandPalette, type CommandItem } from '../../components/ui/command-palette'
import { Icon } from '../../components/ui/icon'
import { BUILT_IN_BACKEND_ROLES, USER_MANAGEMENT_BACKEND_TO_ROLE, hasPermission } from '../../data/userManagementConfig'
import type { PermissionKey } from '../../data/userManagementConfig'
import { recordActivity } from '../../lib/activity'
import { companySettingsEventMatchesOrganization, companySettingsUpdatedEvent, notifyCompanySettingsUpdated } from '../../lib/companySettingsSync'
import { supabase } from '../../lib/supabase'
import type { Role } from '../../types'
import { AdministrationLandingPage } from '../administration/AdministrationLandingPage'
import { RolesPermissionsWorkspace } from '../administration/roles/RolesPermissionsWorkspace'
import { UsersWorkspace } from '../administration/users/UsersWorkspace'
import { DashboardPage } from '../dashboard/DashboardPage'
import { LegalComplianceObligationsRegisterPage } from '../compliance/LegalComplianceObligationsRegisterPage'
import { SettingsPage } from '../settings/SettingsPage'
import { IncidentDetailPage } from '../incidents/IncidentDetailPage'
import { IncidentTypeSelectionPage } from '../incidents/IncidentTypeSelectionPage'
import { MyReportsPage } from '../incidents/MyReportsPage'
import { useIncidentClosureAccess, useIncidentOfflineSync } from '../incidents/useIncidentData'
import { KnowledgePage } from '../knowledge/KnowledgePage'
import { MarketplacePage } from '../marketplace/MarketplacePage'
import { ActionsWorkspace } from '../qhse/ActionsWorkspace'
import { InspectionWorkspace } from '../qhse/InspectionWorkspace'
import { SafetyIntelligencePage } from '../safety-intelligence/SafetyIntelligencePage'
import { normalizeEmergencyContacts, type EmergencyContact } from '../settings/companySettingsTypes'
import { OrganizationSetupPage } from '../setup/OrganizationSetupPage'
import { SafetyPolicyAcknowledgement } from '../safety-policy/SafetyPolicyAcknowledgement'
import { MyAccountWorkspace, MyWorkspace } from './AccountWorkspaces'
import { PolicyObjectivesRegisterPage } from '../safety-policy/PolicyObjectivesRegisterPage'
import { acknowledgeSafetyPolicy, getSafetyPolicyStatus, type SafetyPolicyStatus } from '../safety-policy/safetyPolicyService'
import { getPolicyObjectivesCapabilities } from '../safety-policy/policyObjectivesService'
import { getLegalComplianceCapabilities } from '../compliance/legalComplianceService'
import { WorkspaceLoadingState } from './WorkspaceLoadingState'


function IntelligenceCoveragePending() {
  return <Card className="flex items-center gap-3 p-5" role="status">
    <Spinner size={18} fill="currentColor" />
    <span className="text-sm text-muted">Verifying intelligence coverage...</span>
  </Card>
}

export function ProtectedApp({ session, isDarkMode, onToggleTheme }: { session: Session; isDarkMode: boolean; onToggleTheme: () => void }) {
  const queryClient = useQueryClient()
  const [route, setRoute] = useState<AppRoute>(() => getAppRoute())
  const [previousRoute, setPreviousRoute] = useState<AppRoute | null>(null)
  const routeRef = useRef(route)

  const [role, setRole] = useState<string | null>(null)
  const [customRolePermissions, setCustomRolePermissions] = useState<string[] | null>([])
  const [rolePermissionsLoaded, setRolePermissionsLoaded] = useState(false)
  const [policyObjectivesAccess, setPolicyObjectivesAccess] = useState({ canView: false, canManage: false, loaded: false })
  const [legalComplianceAccess, setLegalComplianceAccess] = useState({ canView: false, canManage: false, loaded: false })
  const [organizationId, setOrganizationId] = useState('')
  const [policyStatus, setPolicyStatus] = useState<SafetyPolicyStatus | null>(null)
  const [policyStatusLoaded, setPolicyStatusLoaded] = useState(false)
  const [policyCheckLoading, setPolicyCheckLoading] = useState(true)
  const [policyError, setPolicyError] = useState('')
  const policyRequestGeneration = useRef(0)
  const policyRequest = useRef<{
    userId: string
    generation: number
    promise: Promise<SafetyPolicyStatus | null>
  } | null>(null)
  const activePolicyUserId = useRef(session.user.id)
  const policyVerified = policyStatusLoaded && !policyCheckLoading && !policyError && policyStatus?.required === false
  useIncidentOfflineSync(supabase, policyVerified)
  const closureAccess = useIncidentClosureAccess(supabase, organizationId, session.user.id, policyVerified)
  const [profileName, setProfileName] = useState(session.user.email || 'User')
  const [organizationName, setOrganizationName] = useState('Organization workspace')
  const [loading, setLoading] = useState(true)
  const [loadingGateComplete, setLoadingGateComplete] = useState(false)
  const [proceedToWorkspace, setProceedToWorkspace] = useState(false)
  const [autoProceedSeconds, setAutoProceedSeconds] = useState(5)
  const [error, setError] = useState('')
  const [needsSetup, setNeedsSetup] = useState(false)
  const [navResetKey, setNavResetKey] = useState(0)
  const [accountExpanded, setAccountExpanded] = useState<boolean>(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sentinel-sidebar-collapsed') === 'true')
  const [isPhoneViewport, setIsPhoneViewport] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const mobileSidebarRef = useRef<HTMLElement>(null)
  const mobileSidebarBackdropRef = useRef<HTMLButtonElement>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [emergencyContacts, setEmergencyContacts] = useState<EmergencyContact[]>([])

  const visibleEmergencyContacts = emergencyContacts.filter((contact) => contact.active && contact.name.trim() && contact.phone.trim())
  const primaryEmergencyContact = visibleEmergencyContacts[0] ?? null
  const sidebarIconOnly = sidebarCollapsed && !isPhoneViewport

  useEffect(() => {
    const phoneQuery = window.matchMedia('(max-width: 640px)')
    const handleViewportChange = (event: MediaQueryListEvent) => {
      setIsPhoneViewport(event.matches)
      if (!event.matches) setMobileSidebarOpen(false)
    }
    phoneQuery.addEventListener('change', handleViewportChange)
    return () => phoneQuery.removeEventListener('change', handleViewportChange)
  }, [])

  useEffect(() => {
    if (!mobileSidebarOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusFrame = window.requestAnimationFrame(() => mobileSidebarRef.current?.querySelector<HTMLElement>('.workspace-nav a')?.focus())
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileSidebarOpen(false)
        window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus())
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(mobileSidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])
        .filter((element) => {
          const bounds = element.getBoundingClientRect()
          return bounds.width > 0 && bounds.height > 0
        })
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const backdrop = mobileSidebarBackdropRef.current
      if (!first || !last || !backdrop) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        backdrop.focus()
      } else if (event.shiftKey && document.activeElement === backdrop) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        backdrop.focus()
      } else if (!event.shiftKey && document.activeElement === backdrop) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [mobileSidebarOpen])

  const handleNavClick = (targetRoute: AppRoute) => {
    if (targetRoute === route) {
      setNavResetKey((prev) => prev + 1)
    }
  }

  const toggleSidebar = () => setSidebarCollapsed((current) => {
    const collapsed = !current
    localStorage.setItem('sentinel-sidebar-collapsed', String(collapsed))
    return collapsed
  })

  const closeMobileSidebar = () => {
    setMobileSidebarOpen(false)
    if (isPhoneViewport) window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus())
  }

  const verifySafetyPolicy = useCallback(async () => {
    const userId = session.user.id
    const activeRequest = policyRequest.current
    if (activeRequest?.userId === userId) return activeRequest.promise

    const generation = ++policyRequestGeneration.current
    setPolicyCheckLoading(true)
    setPolicyError('')
    const promise = (async () => {
      try {
        const currentStatus = await getSafetyPolicyStatus(supabase)
        if (generation !== policyRequestGeneration.current || activePolicyUserId.current !== userId) return null
        setPolicyStatus(currentStatus)
        setPolicyStatusLoaded(true)
        return currentStatus
      } catch (caught) {
        if (generation !== policyRequestGeneration.current || activePolicyUserId.current !== userId) return null
        setPolicyStatus(null)
        setPolicyStatusLoaded(false)
        setPolicyError(caught instanceof Error ? caught.message : 'Unable to verify the Safety Policy.')
        return null
      } finally {
        if (generation === policyRequestGeneration.current && activePolicyUserId.current === userId) {
          setPolicyCheckLoading(false)
        }
        if (policyRequest.current?.generation === generation) policyRequest.current = null
      }
    })()
    policyRequest.current = { userId, generation, promise }
    return promise
  }, [session.user.id])

  useEffect(() => {
    // Load only identity and membership before policy verification; other workspace data waits for the gate.
    let active = true
    activePolicyUserId.current = session.user.id

    const loadMembership = async () => {
      const { data: profile, error: profileError } = await supabase.from('profiles').select('full_name, organization_id, account_status').eq('id', session.user.id).maybeSingle()
      if (profileError) {
        if (!active) return
        setError(profileError.message)
        setLoading(false)
        return
      }
      if (!active) return
      if (!profile) {
        setNeedsSetup(true)
        setLoading(false)
        return
      }
      if (profile.account_status === 'pending') {
        setLoading(false)
        window.location.hash = '#/invite-signup'
        return
      }
      if (profile?.full_name) setProfileName(profile.full_name)
      if (profile?.organization_id) {
        const { data: membership, error: membershipError } = await supabase
          .from('memberships')
          .select('role')
          .eq('user_id', session.user.id)
          .eq('organization_id', profile.organization_id)
          .maybeSingle()
        if (!active) return
        if (membershipError) {
          setError(membershipError.message)
          setLoading(false)
          return
        }
        if (!membership?.role) {
          setLoading(false)
          return
        }
        const membershipRole = String(membership.role)
        setOrganizationId(profile.organization_id)
        setRole(membershipRole)
        if (membershipRole === 'Super Administrator') {
          setCustomRolePermissions(null)
        }
        await verifySafetyPolicy()
      }
      if (active) setLoading(false)
    }
    void loadMembership().catch((caught: unknown) => {
      if (!active) return
      if (import.meta.env.DEV) {
        console.error('[Auth] Organization membership loading failed', {
          message: caught instanceof Error ? caught.message : 'Unknown membership loading failure',
        })
      }
      setError('Unable to load your organization membership. Please retry.')
      setLoading(false)
    })
    return () => {
      active = false
      if (activePolicyUserId.current === session.user.id) activePolicyUserId.current = ''
    }
  }, [session.user.id, verifySafetyPolicy])

  useEffect(() => {
    const verifyAfterNavigation = () => {
      const nextRoute = getAppRoute()
      setPreviousRoute(routeRef.current)
      routeRef.current = nextRoute
      setRoute(nextRoute)
    }
    const verifyOnFocus = () => {
      if (organizationId && policyStatusLoaded) void verifySafetyPolicy()
    }
    window.addEventListener('hashchange', verifyAfterNavigation)
    window.addEventListener('focus', verifyOnFocus)
    window.addEventListener('safety-policy-updated', verifyOnFocus)
    return () => {
      window.removeEventListener('hashchange', verifyAfterNavigation)
      window.removeEventListener('focus', verifyOnFocus)
      window.removeEventListener('safety-policy-updated', verifyOnFocus)
    }
  }, [organizationId, policyStatusLoaded, verifySafetyPolicy])

  useEffect(() => {
    if (loading) {
      setLoadingGateComplete(false)
      setProceedToWorkspace(false)
      return
    }
    const gateTimer = window.setTimeout(() => setLoadingGateComplete(true), 5000)
    return () => window.clearTimeout(gateTimer)
  }, [loading])

  useEffect(() => {
    if (!loadingGateComplete || proceedToWorkspace) return
    setAutoProceedSeconds(5)
    const countdown = window.setInterval(() => setAutoProceedSeconds((seconds) => Math.max(0, seconds - 1)), 1000)
    const autoProceed = window.setTimeout(() => setProceedToWorkspace(true), 5000)
    return () => {
      window.clearInterval(countdown)
      window.clearTimeout(autoProceed)
    }
  }, [loadingGateComplete, proceedToWorkspace])

// Closure authority comes from the database's user delegation, not a frontend role checkbox.
  // Inspections and corrective actions are gated purely on their catalog permissions, matching the
  // database gates (has_inspection_action_permission / can_create_corrective_action).
  const canAccess = (permission: PermissionKey) => {
    if (permission === 'close_incidents') return closureAccess.data === true
    if (permission === 'view_all_incidents' && closureAccess.data === true) return true
    if (permission === 'view_policy_objectives_register') return role === 'Super Administrator' || (policyObjectivesAccess.loaded && policyObjectivesAccess.canView)
    if (permission === 'manage_policy_objectives') return role === 'Super Administrator' || (policyObjectivesAccess.loaded && policyObjectivesAccess.canManage)
    if (permission === 'view_legal_compliance_register') return role === 'Super Administrator' || (legalComplianceAccess.loaded && legalComplianceAccess.canView)
    if (permission === 'manage_legal_compliance_obligations') return role === 'Super Administrator' || (legalComplianceAccess.loaded && legalComplianceAccess.canManage)
    return role ? hasPermission(role, permission, customRolePermissions) : false
  }
  const canManageCompanySettings = role === 'Super Administrator' || canAccess('manage_settings')
  const canManagePolicyObjectives = canAccess('manage_policy_objectives')
  const canManageLegalCompliance = canAccess('manage_legal_compliance_obligations')
  const canOpenSettings = canManageCompanySettings || canManagePolicyObjectives || canManageLegalCompliance
  const canCreateInspections = canAccess('create_inspection')
  const canManageActions = canAccess('create_corrective_action') || canAccess('manage_corrective_actions')
  const legacyFeatureRole = role && BUILT_IN_BACKEND_ROLES.includes(role as typeof BUILT_IN_BACKEND_ROLES[number]) ? role as Role : 'Field Worker'
  const visiblePrimaryNavigation = primaryNavigation.filter((item) => item.route === 'inspections'
    ? canCreateInspections || canManageActions : canAccess(item.permission))
  const visibleSecondaryNavigation = secondaryNavigation.filter((item) => {
    if (item.route === 'my-account') return canAccess('view_profile') || canAccess('view_activity')
    if (item.route === 'my-workspace') return canAccess('view_own_reports')
    if (item.route === 'settings') return canOpenSettings && (canManageCompanySettings ? canAccess(item.permission) : canManagePolicyObjectives || canManageLegalCompliance)
    return canAccess(item.permission)
  })
  const currentNavigation = [...primaryNavigation, ...secondaryNavigation, ...futureModuleRoutes].find((item) => item.route === route)
  const currentRouteAuthorized = route === 'my-account'
    ? canAccess('view_profile') || canAccess('view_activity')
    : route === 'my-workspace'
    ? canAccess('view_own_reports')
    : route === 'policy-objectives-register' || route === 'legal-compliance-obligations-register'
    ? true
    : route === 'settings'
    ? canOpenSettings
    : route === 'inspections'
    ? canCreateInspections || canManageActions
    : route === 'corrective-actions'
    ? canManageActions
    : route === 'incident-detail'
    ? canAccess('view_own_reports') || canAccess('view_all_incidents')
    : Boolean(currentNavigation && canAccess(currentNavigation.permission))
  const fallbackRoute = visiblePrimaryNavigation[0]?.route || 'dashboard'

  // Global search (⌘K / Ctrl+K) over the routes the current user can reach.
  const paletteItems: CommandItem[] = [
    ...visiblePrimaryNavigation.map((item) => ({
      id: `nav-${item.route}`,
      label: item.label,
      hint: item.route,
      icon: item.icon,
      onSelect: () => { window.location.hash = `#${item.route}` },
    })),
    ...visibleSecondaryNavigation.map((item) => ({
      id: `nav-${item.route}`,
      label: item.label,
      hint: item.route,
      onSelect: () => { window.location.hash = `#${item.route}` },
    })),
    ...futureModuleRoutes
      .filter((item) => item.route === 'corrective-actions' ? canManageActions : canAccess(item.permission))
      .map((item) => ({
        id: `nav-${item.route}`,
        label: item.label,
        hint: item.route,
        onSelect: () => { window.location.hash = `#${item.route}` },
      })),
    ...(import.meta.env.DEV
      ? [
          {
            id: 'route-ui-builder',
            label: 'UI Builder',
            hint: 'ui-builder',
            icon: 'layers' as const,
            onSelect: () => { window.location.hash = '#ui-builder' },
          },
        ]
      : []),
  ]

  useEffect(() => {
    if (!policyVerified) return
    if (!loading && route === 'settings' && !rolePermissionsLoaded) return
    if (!loading && (route === 'my-account' || route === 'my-workspace') && !rolePermissionsLoaded) return
    if (!loading && route === 'settings' && !canManageCompanySettings && (!policyObjectivesAccess.loaded || !legalComplianceAccess.loaded)) return
    if (!loading && route === 'settings' && !canOpenSettings) {
      if (route !== fallbackRoute) window.location.hash = `#${fallbackRoute}`
      return
    }

// Analytics has its own denial screen; a direct link must not redirect away from it.
    if (!loading && route !== 'executive-analytics' && !(route === 'incidents' && closureAccess.isPending) && !currentRouteAuthorized) {
      if (route !== fallbackRoute) window.location.hash = `#${fallbackRoute}`
    }
  }, [canManageCompanySettings, canOpenSettings, closureAccess.isPending, currentRouteAuthorized, fallbackRoute, legalComplianceAccess.loaded, loading, policyObjectivesAccess.loaded, policyVerified, rolePermissionsLoaded, route])

  useEffect(() => {
    if (!organizationId || !policyVerified) return
    const handleSettingsUpdated = (event: Event) => {
      if (!companySettingsEventMatchesOrganization(event, organizationId)) return
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard', organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['knowledge', organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['safety-intelligence', organizationId] }),
      ])
    }
    window.addEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    const handleWindowFocus = () => notifyCompanySettingsUpdated(organizationId)
    window.addEventListener('focus', handleWindowFocus)
    const channel = supabase
      .channel(`company-settings-sync:${organizationId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'company_settings',
        filter: `organization_id=eq.${organizationId}`,
      }, () => notifyCompanySettingsUpdated(organizationId))
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`Company settings live synchronization is unavailable (${status}).`)
        }
      })
    return () => {
      window.removeEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
      window.removeEventListener('focus', handleWindowFocus)
      void supabase.removeChannel(channel)
    }
  }, [organizationId, policyVerified, queryClient])

  useEffect(() => {
    if (!organizationId || !role || !policyVerified) return

    let active = true
    setRolePermissionsLoaded(false)
    const refreshRolePermissions = async () => {
      if (role === 'Super Administrator') {
        setCustomRolePermissions(null)
        if (active) setRolePermissionsLoaded(true)
        return
      }

      if (USER_MANAGEMENT_BACKEND_TO_ROLE[role]) {
        const { data, error: settingsError } = await supabase
          .from('organization_builtin_role_settings')
          .select('permissions')
          .eq('organization_id', organizationId)
          .eq('role_key', role)
          .maybeSingle()
        if (active) {
          setCustomRolePermissions(settingsError || !Array.isArray(data?.permissions) ? [] : data.permissions as string[])
          setRolePermissionsLoaded(true)
        }
        return
      }

      const { data, error: customRoleError } = await supabase
        .from('custom_roles')
        .select('permissions')
        .eq('organization_id', organizationId)
        .eq('name', role)
        .eq('is_active', true)
        .maybeSingle()
      if (active) {
        setCustomRolePermissions(customRoleError || !Array.isArray(data?.permissions) ? [] : data.permissions as string[])
        setRolePermissionsLoaded(true)
      }
    }

    void refreshRolePermissions()
    const roleChannel = supabase
      .channel(`organization-role-permissions:${organizationId}:${session.user.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'organization_builtin_role_settings',
        filter: `organization_id=eq.${organizationId}`,
      }, () => void refreshRolePermissions())
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'custom_roles',
        filter: `organization_id=eq.${organizationId}`,
      }, () => void refreshRolePermissions())
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`Role permission live synchronization is unavailable (${status}).`)
        }
      })
    const handleRoleFocus = () => void refreshRolePermissions()
    window.addEventListener('focus', handleRoleFocus)
    return () => {
      active = false
      window.removeEventListener('focus', handleRoleFocus)
      void supabase.removeChannel(roleChannel)
    }
  }, [organizationId, policyVerified, role, session.user.id])

  useEffect(() => {
    if (!organizationId || !role || !policyVerified) return

    let active = true
    setPolicyObjectivesAccess({ canView: false, canManage: false, loaded: false })
    const refreshPolicyObjectivesAccess = async () => {
      try {
        const access = await getPolicyObjectivesCapabilities(supabase, organizationId)
        if (active) setPolicyObjectivesAccess({ ...access, loaded: true })
      } catch {
        if (active) setPolicyObjectivesAccess({ canView: false, canManage: false, loaded: true })
      }
    }
    void refreshPolicyObjectivesAccess()
    const handleFocus = () => void refreshPolicyObjectivesAccess()
    window.addEventListener('focus', handleFocus)
    return () => {
      active = false
      window.removeEventListener('focus', handleFocus)
    }
  }, [organizationId, policyVerified, role])

  useEffect(() => {
    if (!organizationId || !policyVerified) return
    let active = true
    const dispatchComplianceEmails = async () => {
      const { error: dispatchError } = await supabase.functions.invoke('legal-compliance-expiry-notifications')
      if (active && dispatchError) console.warn('Compliance reminder email dispatch is unavailable.', dispatchError)
    }
    void dispatchComplianceEmails()
    const handleFocus = () => void dispatchComplianceEmails()
    const interval = window.setInterval(() => void dispatchComplianceEmails(), 60 * 60 * 1000)
    window.addEventListener('focus', handleFocus)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
    }
  }, [organizationId, policyVerified])

  useEffect(() => {
    if (!organizationId || !role || !policyVerified) return

    let active = true
    setLegalComplianceAccess({ canView: false, canManage: false, loaded: false })
    const refreshLegalComplianceAccess = async () => {
      try {
        const access = await getLegalComplianceCapabilities(supabase, organizationId)
        if (active) setLegalComplianceAccess({ ...access, loaded: true })
      } catch {
        if (active) setLegalComplianceAccess({ canView: false, canManage: false, loaded: true })
      }
    }
    void refreshLegalComplianceAccess()
    const handleFocus = () => void refreshLegalComplianceAccess()
    window.addEventListener('focus', handleFocus)
    return () => {
      active = false
      window.removeEventListener('focus', handleFocus)
    }
  }, [organizationId, policyVerified, role])

  useEffect(() => {
    if (!organizationId || !role || !policyVerified) return

    let active = true
    const loadEmergencyContacts = async () => {
      const { data } = await supabase
        .from('company_settings')
        .select('emergency_contacts')
        .eq('organization_id', organizationId)
        .maybeSingle()

      if (!active) return
      setEmergencyContacts(normalizeEmergencyContacts(data?.emergency_contacts ?? []))
    }

    const handleSettingsUpdated = (event: Event) => {
      if (!companySettingsEventMatchesOrganization(event, organizationId)) return
      void loadEmergencyContacts()
    }

    void loadEmergencyContacts()
    window.addEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)

    return () => {
      active = false
      window.removeEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    }
  }, [organizationId, policyVerified, role])

  useEffect(() => {
    if (!organizationId || !policyVerified) return
    let active = true
    const loadOrganizationName = async () => {
      const { data, error: organizationError } = await supabase
        .from('organizations')
        .select('company_name')
        .eq('id', organizationId)
        .maybeSingle()
      if (organizationError) {
        console.error('Unable to load the organization name.', organizationError)
        return
      }
      if (active && data?.company_name) setOrganizationName(data.company_name)
    }
    void loadOrganizationName()
    return () => { active = false }
  }, [organizationId, policyVerified])

  const signOut = async () => {
    await recordActivity(organizationId, session.user.id, 'User logged out')
    await supabase.auth.signOut()
    window.location.hash = '#top'
  }

  const collapsedAccountItems: DropdownMenuItem[] = [
    ...visibleSecondaryNavigation.map((item) => ({
      id: item.route,
      label: item.label,
      icon: item.icon,
      active: item.route === route,
      onSelect: () => {
        handleNavClick(item.route)
        window.location.hash = `#${item.route}`
      },
    })),
    { id: 'sign-out', label: 'Sign out', icon: 'logout', tone: 'danger', onSelect: () => { void signOut() } },
  ]

  const signOutFromPolicyError = async () => {
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) setPolicyError('We could not sign you out. Please retry.')
    else window.location.hash = '#top'
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (loading || !loadingGateComplete || !proceedToWorkspace) return <WorkspaceLoadingState backgroundImage={heroFacility} canProceed={loadingGateComplete} secondsUntilAuto={autoProceedSeconds} onProceed={() => setProceedToWorkspace(true)} isDarkMode={isDarkMode} />
  if (error) return <div className="grid min-h-screen place-items-center bg-surface-soft p-6">
    <Card className="w-full max-w-md p-6">
      <Alert tone="danger">Unable to load your organization access: {error}</Alert>
    </Card>
  </div>
  if (needsSetup) return <OrganizationSetupPage email={session.user.email || ''} />
  if (!role) return <div className="grid min-h-screen place-items-center bg-surface-soft p-6">
    <Card className="flex w-full max-w-md flex-col gap-4 p-6">
      <Alert tone="danger">Your account is not assigned to an organization yet.</Alert>
      <Button onClick={() => { window.location.hash = '#top' }}>Return to home</Button>
    </Card>
  </div>
  if (policyCheckLoading || !policyStatusLoaded || policyError || policyStatus?.required) {
    return (
      <SafetyPolicyAcknowledgement
        policy={policyStatus?.policy ?? null}
        loading={policyCheckLoading}
        error={policyError}
        isDarkMode={isDarkMode}
        onRetry={() => { void verifySafetyPolicy() }}
        onSignOut={() => { void signOutFromPolicyError() }}
        onAcknowledge={async (onRecorded) => {
          await acknowledgeSafetyPolicy(supabase)
          let updatedStatus: SafetyPolicyStatus
          try {
            updatedStatus = await getSafetyPolicyStatus(supabase)
          } catch (caught) {
            throw new Error(caught instanceof Error ? caught.message : 'Unable to verify your acknowledgement. Please retry.')
          }
          if (updatedStatus.required) throw new Error('Your acknowledgement is still required. Please retry.')
          onRecorded()
          if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            await new Promise((resolve) => window.setTimeout(resolve, 250))
          }
          setPolicyStatus(updatedStatus)
          setPolicyStatusLoaded(true)
          setPolicyError('')
          setPolicyCheckLoading(false)
        }}
      />
    )
  }

  return (
    <div className={`workspace-shell${isDarkMode ? ' dark-theme' : ''}${sidebarIconOnly ? ' sidebar-collapsed' : ''}${mobileSidebarOpen ? ' mobile-sidebar-open' : ''}`}>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} items={paletteItems} />
      <aside
        id="workspace-sidebar"
        ref={mobileSidebarRef}
        className="workspace-sidebar"
        aria-label="Workspace navigation"
        inert={isPhoneViewport && !mobileSidebarOpen}
      >
        <button
          type="button"
          className="workspace-sidebar-toggle"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={sidebarCollapsed}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <Icon name="chevronRight" size={17} className={sidebarCollapsed ? '' : 'workspace-sidebar-toggle-expanded'} />
        </button>
        <a className="brand workspace-brand" href="#dashboard" onClick={() => handleNavClick('dashboard')}>   
          <BrandMark size="md" className="rounded-lg" />
          <span className="brand-copy"><strong>SentinelQHSE<sup>™</sup></strong><small>SAFETY INTELLIGENCE</small></span>
        </a>
        <nav className="workspace-nav" aria-label="Workspace navigation">
          {visiblePrimaryNavigation.map((item) => {
            const link = (
              <a
                className={item.route === route ? 'active' : ''}
                href={`#${item.route}`}
                key={item.route}
                aria-label={item.label}
                onClick={() => handleNavClick(item.route)}
              >
                <span className="workspace-nav-icon" aria-hidden="true"><Icon name={item.icon} size={16} /></span>
                <span className="workspace-nav-label">{item.label}</span>
              </a>
            )
            const handleSelect = () => {
              handleNavClick(item.route)
              if (isPhoneViewport) closeMobileSidebar()
            }
            return sidebarIconOnly
              ? <Tooltip key={item.route} label={item.label} side="right">{link}</Tooltip>
              : <a
                  className={item.route === route ? 'active' : ''}
                  href={`#${item.route}`}
                  key={item.route}
                  aria-label={item.label}
                  onClick={handleSelect}
                >
                  <span className="workspace-nav-icon" aria-hidden="true"><Icon name={item.icon} size={16} /></span>
                  <span className="workspace-nav-label">{item.label}</span>
                </a>
          })}
        </nav>
        {sidebarIconOnly ? (
          <div className="workspace-secondary-links workspace-secondary-links-collapsed">
            <Tooltip label="Account" side="right">
              <DropdownMenu
                className="workspace-collapsed-account"
                label={<><span className="sr-only">Account</span><Icon name="profile" size={18} aria-hidden="true" /></>}
                items={collapsedAccountItems}
                align="start"
                variant="ghost"
                showChevron={false}
              />
            </Tooltip>
          </div>
        ) : (
          <>
            <div className="workspace-secondary-links">
              <button
                type="button"
                className="workspace-account-toggle"
                onClick={() => setAccountExpanded((open) => !open)}
                aria-expanded={accountExpanded}
              >
                <span className="workspace-nav-icon" aria-hidden="true"><Icon name="profile" size={16} /></span>
                <span className="workspace-account-label">Account</span>
                <span className={`workspace-account-chevron${accountExpanded ? ' open' : ''}`} aria-hidden="true"><Icon name="chevronRight" size={14} /></span>
              </button>
              <div className={`workspace-account-items${accountExpanded ? ' expanded' : ''}`}>
                <div className="workspace-account-items-inner">
                  {visibleSecondaryNavigation.map((item) => (
                    <a
                      className={item.route === route ? 'active' : ''}
                      href={`#${item.route}`}
                      key={item.route}
                      aria-label={item.label}
                      onClick={() => { handleNavClick(item.route); if (isPhoneViewport) closeMobileSidebar() }}
                    >
                      <span className="workspace-nav-icon" aria-hidden="true"><Icon name={item.icon} size={16} /></span>
                      <span className="workspace-secondary-label">{item.label}</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
            <button className="workspace-signout" type="button" onClick={signOut} aria-label="Sign out">
              <Icon name="logout" size={16} aria-hidden="true" />
              <span className="workspace-signout-label">Sign out</span>
            </button>
          </>
        )}
      </aside>
      {isPhoneViewport && mobileSidebarOpen && (
        <button ref={mobileSidebarBackdropRef} type="button" className="workspace-sidebar-backdrop" aria-label="Close navigation menu" onClick={closeMobileSidebar} />
      )}
      <main className="workspace-main" inert={isPhoneViewport && mobileSidebarOpen}>
        <header className="workspace-topbar">
          <div className="workspace-topbar-left">
            <button
              ref={mobileMenuButtonRef}
              type="button"
              className="workspace-mobile-menu-button"
              aria-label={mobileSidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileSidebarOpen}
              aria-controls="workspace-sidebar"
              onClick={() => setMobileSidebarOpen((open) => !open)}
            >
              <Icon name={mobileSidebarOpen ? 'close' : 'menu'} size={18} aria-hidden="true" />
            </button>
            {primaryEmergencyContact && (
              <div className="workspace-emergency-panel">
                <div className="workspace-emergency-label">FOR EMERGENCY RESPONSE CALL:</div>
                <div className="workspace-emergency-contact">
                  <span>{primaryEmergencyContact.role?.trim() || 'Admin'}</span>
                  <strong>{primaryEmergencyContact.name}</strong>
                  <small><a href={`tel:${primaryEmergencyContact.phone}`}>{primaryEmergencyContact.phone}</a></small>
                </div>
              </div>
            )}
          </div>
          <div className="workspace-actions">
            <button type="button" className="global-search-button" onClick={() => setPaletteOpen(true)} aria-label="Search workspace">
              <Icon name="search" size={15} />
              <span className="flex-1 text-left">Search workspace</span>
              <kbd className="global-search-kbd">⌘K</kbd>
            </button>
            <a className="workspace-header-action" href="#activity-log" title="Notifications" aria-label="Notifications"><Icon name="notifications" size={17} /></a>
            {canAccess('view_executive_analytics') && <a className="workspace-header-action" href="#executive-analytics" title="Executive Analytics" aria-label="Executive Analytics"><Icon name="executiveAnalytics" size={17} /></a>}
            <button className="workspace-header-action" type="button" title="Messages coming soon" aria-label="Messages coming soon"><Icon name="messages" size={17} /></button>
            <button type="button" className="theme-button" onClick={onToggleTheme} aria-label="Toggle theme"><Icon name={isDarkMode ? 'sun' : 'moon'} size={17} /></button>
            <a className="workspace-user" href="#profile">{profileName}</a>
          </div>
        </header>
        <section className="workspace-content">
{closureAccess.isError && <Alert tone="danger">{closureAccess.error.message}</Alert>}
          {route === 'dashboard' && canManageCompanySettings && policyStatusLoaded && policyStatus?.active === false && (
            <Alert tone="warning">
              No safety policy is published. Users can continue without one.{' '}
              <a className="font-semibold underline underline-offset-2" href="#settings">Set one up in Settings.</a>
            </Alert>
          )}
          {route === 'dashboard' && <DashboardPage organizationId={organizationId} currentUserId={session.user.id} organizationName={organizationName} userName={profileName} role={legacyFeatureRole} canReportIncident={canAccess('report_incident')} canCreateInspection={canCreateInspections} canCreateCorrectiveAction={canManageActions} canStartAudit={canAccess('start_audit')} canViewReports={canAccess('view_reports')} supabase={supabase} />}
          {route === 'report-incident' && canAccess('report_incident') && <IncidentTypeSelectionPage key={`report-incident-${navResetKey}`} role={legacyFeatureRole} supabase={supabase} draftId={new URLSearchParams(window.location.hash.split('?')[1] || '').get('draft') || undefined} />}
          {route === 'incident-detail' && <IncidentDetailPage supabase={supabase} canClose={canAccess('close_incidents')} incidentId={new URLSearchParams(window.location.hash.split('?')[1] || '').get('id')} />}
          {route === 'incidents' && canAccess('view_all_incidents') && <MyReportsPage key="organization" supabase={supabase} scope="organization" canViewAll canClose={canAccess('close_incidents')} canExport={canAccess('export_reports')} />}

          {route === 'corrective-actions' && canManageActions && <ActionsWorkspace supabase={supabase} canManage showInspectionBack />}
          {route === 'inspections' && (canCreateInspections || canManageActions) && <InspectionWorkspace supabase={supabase} canManageActions={canManageActions} canCreate={canCreateInspections} />}
          {route === 'ai-assistant' && canAccess('use_ai_assistant') && (
            closureAccess.isPending ? <IntelligenceCoveragePending />
              : !closureAccess.isError && <SafetyIntelligencePage client={supabase} canViewKnowledge={canAccess('view_knowledge_documents')} scope={{
                organizationId, userId: session.user.id,
                visibility: canAccess('view_all_incidents') ? 'organization' : 'personal',
                siteAssignmentEnforced: false,
              }} />
          )}
          {route === 'knowledge' && canAccess('view_knowledge_documents') && <KnowledgePage key={`${organizationId}:${session.user.id}`} client={supabase} scope={{ organizationId, userId: session.user.id }} />}
          {/* Keep direct route requests visible so missing access gets an explicit denial; the Edge Function rechecks before data reads. */}
          {route === 'executive-analytics' && (
            !canAccess('view_executive_analytics')
              ? <Alert tone="danger">{executiveAnalyticsAccessMessage}</Alert>
              : closureAccess.isPending
                ? <IntelligenceCoveragePending />
                : !closureAccess.isError && <SafetyIntelligencePage view="executive-analytics" canExportAnalytics={canAccess('view_executive_analytics')} client={supabase} scope={{
                  organizationId, userId: session.user.id,
                  visibility: canAccess('view_all_incidents') ? 'organization' : 'personal',
                  siteAssignmentEnforced: false,
                }} />
          )}
          {route === 'marketplace' && canAccess('view_marketplace') && <MarketplacePage />}
          {route === 'administration' && canAccess('access_administration') && <AdministrationLandingPage canViewUsers={canAccess('view_users')} canViewRoles={canAccess('view_roles_permissions')} />}
          {route === 'users' && canAccess('view_users') && <UsersWorkspace organizationId={organizationId} currentUserId={session.user.id} canInviteUsers={canAccess('invite_users')} canEditUsers={canAccess('edit_users')} canSuspendUsers={canAccess('suspend_users')} canDeactivateUsers={canAccess('deactivate_users')} canManageUserRoles={canAccess('manage_user_roles')} canManageRolesPermissions={canAccess('manage_roles_permissions')} canManagePolicyPermissions={role === 'Super Administrator'} />}
          {route === 'roles-permissions' && canAccess('view_roles_permissions') && <RolesPermissionsWorkspace organizationId={organizationId} canManage={role === 'Super Administrator' && canAccess('manage_roles_permissions')} />}
          {route === 'my-account' && (canAccess('view_profile') || canAccess('view_activity')) && <MyAccountWorkspace userId={session.user.id} organizationId={organizationId} email={session.user.email || ''} canViewProfile={canAccess('view_profile')} canViewActivity={canAccess('view_activity')} />}
          {route === 'my-workspace' && canAccess('view_own_reports') && <MyWorkspace client={supabase} organizationId={organizationId} userId={session.user.id} canViewAllIncidents={canAccess('view_all_incidents')} canCloseIncidents={canAccess('close_incidents')} canExportReports={canAccess('export_reports')} canManageActions={canManageActions} canViewAllAssignedActions={canAccess('view_all_assigned_actions')} />}
          {route === 'policy-objectives-register' && <PolicyObjectivesRegisterPage client={supabase} organizationId={organizationId} previousRoute={previousRoute} />}
          {route === 'legal-compliance-obligations-register' && <LegalComplianceObligationsRegisterPage client={supabase} organizationId={organizationId} previousRoute={previousRoute} />}
          {route === 'settings' && canOpenSettings && (
            <SettingsPage
              client={supabase}
              organizationId={organizationId}
              userId={session.user.id}
              safetyPolicyOnly={role !== 'Super Administrator'}
              policyObjectivesOnly={!canManageCompanySettings && canManagePolicyObjectives && !canManageLegalCompliance}
              complianceFrameworksOnly={!canManageCompanySettings && canManageLegalCompliance && !canManagePolicyObjectives}
              canManagePolicyObjectives={canManagePolicyObjectives}
              canManageLegalCompliance={canManageLegalCompliance}
            />
          )}
        </section>
      </main>
    </div>
  )
}
