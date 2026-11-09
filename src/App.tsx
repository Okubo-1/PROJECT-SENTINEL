import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'

import { getAuthRoute, getCleanHash, getHashRoute, pinAuthRouteToHash, type AuthRoute } from './app/routing'
import { supabase } from './lib/supabase'
import { DemoRequestPage } from './features/auth/DemoRequestPage'
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage'
import { InviteSignupPage } from './features/auth/InviteSignupPage'
import { PasswordPage } from './features/auth/PasswordPage'
import { RegisterPage } from './features/auth/RegisterPage'
import { SignInPage } from './features/auth/SignInPage'
import { LandingPage } from './features/landing/LandingPage'
import { UiBuilderPage } from './features/ui-builder/UiBuilderPage'
import { ProtectedApp } from './features/workspace/ProtectedApp'
import { BootLoadingScreen } from './features/workspace/BootLoadingScreen'

export default function App() {
  const [authRoute, setAuthRoute] = useState<AuthRoute | null>(() => getAuthRoute())
  const lastAuthRouteRef = useRef<AuthRoute | null>(authRoute)
  const authEventRevision = useRef(0)
  const [session, setSession] = useState<Session | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('sentinel-theme') === 'dark')

  useEffect(() => {
    const handleHashChange = () => {
      const nextRoute = getAuthRoute()
      if (nextRoute) {
        lastAuthRouteRef.current = nextRoute
        setAuthRoute(nextRoute)
        return
      }
      // Supabase clears the whole hash after reading the session out of an
      // email link, which would otherwise drop the invite form on the landing
      // page. No in-app navigation targets an empty hash, so restore the route.
      if (!window.location.hash && lastAuthRouteRef.current) {
        window.location.hash = `#/${lastAuthRouteRef.current}`
        return
      }
      setAuthRoute(null)
    }
    void supabase.auth.getSession().then(({ data: sessionData, error }) => {
      if (authEventRevision.current !== 0) return
      if (error && import.meta.env.DEV) {
        console.error('[Auth] Session restoration failed', {
          code: error.code,
          message: error.message,
        })
      }
      setSession(error ? null : sessionData.session)
      setSessionLoading(false)
    }).catch((caught: unknown) => {
      if (authEventRevision.current !== 0) return
      if (import.meta.env.DEV) {
        console.error('[Auth] Session restoration failed', {
          message: caught instanceof Error ? caught.message : 'Unknown session restoration failure',
        })
      }
      setSession(null)
      setSessionLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      authEventRevision.current += 1
      setSession(nextSession)
      setSessionLoading(false)
      if (event === 'PASSWORD_RECOVERY') {
        setAuthRoute('reset-password')
        pinAuthRouteToHash('reset-password')
      }
    })
    window.addEventListener('hashchange', handleHashChange)
    return () => {
      window.removeEventListener('hashchange', handleHashChange)
      data.subscription.unsubscribe()
    }
  }, [])

  const toggleTheme = () => {
    setIsDarkMode((current) => {
      const next = !current
      localStorage.setItem('sentinel-theme', next ? 'dark' : 'light')
      return next
    })
  }

  if (authRoute === 'sign-in') return <SignInPage userOnly={new URLSearchParams(getCleanHash().split('?')[1] || '').get('mode') === 'user'} />
  if (authRoute === 'register') return <RegisterPage />
  if (authRoute === 'forgot-password') return <ForgotPasswordPage />
  if (authRoute === 'reset-password') return <PasswordPage reset />
  if (authRoute === 'change-password') return <PasswordPage />
  if (authRoute === 'invite-signup') return <InviteSignupPage />
  if (authRoute === 'demo') return <DemoRequestPage />

  const requestedRoute = getHashRoute()
  const isUiBuilderPath = window.location.pathname.replace(/\/+$/, '').endsWith('/ui-builder')
  if (requestedRoute === 'ui-builder' || isUiBuilderPath) {
    return <UiBuilderPage isDarkMode={isDarkMode} onToggleTheme={toggleTheme} />
  }
  if (requestedRoute === 'mfa') {
    window.location.hash = '#dashboard'
    return <BootLoadingScreen label="Opening your workspace…" isDarkMode={isDarkMode} />
  }
  // These routes show organization-specific pages, so require a signed-in session first.
  // Public pages and account routes are handled elsewhere; ProtectedApp then loads organization access.
  const protectedRoute = requestedRoute === 'dashboard' || requestedRoute === 'report-incident' || requestedRoute === 'incident-detail' || requestedRoute === 'my-reports' || requestedRoute === 'assigned-actions' || requestedRoute === 'my-account' || requestedRoute === 'my-workspace' || requestedRoute === 'ai-assistant' || requestedRoute === 'knowledge' || requestedRoute === 'executive-analytics' || requestedRoute === 'marketplace' || requestedRoute === 'incidents' || requestedRoute === 'corrective-actions' || requestedRoute === 'inspections' || requestedRoute === 'administration' || requestedRoute === 'users' || requestedRoute === 'roles-permissions' || requestedRoute === 'profile' || requestedRoute === 'preferences' || requestedRoute === 'activity-log' || requestedRoute === 'settings' || requestedRoute === 'policy-objectives-register' || requestedRoute === 'legal-compliance-obligations-register'
  if (protectedRoute) {
    if (sessionLoading) return <BootLoadingScreen label="Checking your session…" isDarkMode={isDarkMode} />
    if (!session) return <SignInPage />
    return <ProtectedApp key={session.user.id} session={session} isDarkMode={isDarkMode} onToggleTheme={toggleTheme} />
  }

  return <LandingPage isDarkMode={isDarkMode} onToggleTheme={toggleTheme} />
}
