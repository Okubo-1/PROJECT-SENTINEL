import type { SupabaseClient } from '@supabase/supabase-js'
import { useQuery } from '@tanstack/react-query'

import { Alert, Avatar, Badge, Skeleton } from '../../components/ui'
import { SettingsSectionShell } from './SettingsSectionShell'

export function VerifiersSection({ client, organizationId }: {
  client: SupabaseClient
  organizationId: string
}) {
  const verifiers = useQuery({
    queryKey: ['incident-closure-verifiers', organizationId],
    queryFn: async () => {
      const { data, error } = await client
        .from('incident_closure_delegates')
        .select('user_id, full_name:profiles(full_name), role:profiles(roles(name)), account_status:profiles(account_status)')
        .eq('organization_id', organizationId)
        .order('full_name')

      if (error) throw new Error(error.message)

      return ((data || []) as Array<Record<string, unknown>>).map((item) => ({
        user_id: item.user_id as string,
        full_name: ((item.full_name as Record<string, unknown>) || {}).full_name as string || 'Unknown',
        role: (((item.role as Record<string, unknown>) || {}) as Record<string, unknown>).name as string || 'User',
        account_status: ((item.account_status as Record<string, unknown>) || {}).account_status as string || 'active',
      }))
    },
  })

  const delegates = (verifiers.data || [])
    .filter((v) => v.account_status === 'active')
    .sort((a, b) => a.full_name.localeCompare(b.full_name))

  return (
    <SettingsSectionShell
      title="Investigation verifiers"
      description="Verifiers are automatically set from closure access delegation. These users can verify investigation completeness."
      action={<Badge tone="info">Auto-synced</Badge>}
    >
      {verifiers.isPending ? (
        <Skeleton className="h-20" />
      ) : verifiers.isError ? (
        <Alert tone="danger">
          {verifiers.error.message}
        </Alert>
      ) : delegates.length ? (
        <ol className="grid gap-2">
          {delegates.map((verifier, index) => (
            <li key={verifier.user_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-soft font-mono text-xs text-muted" aria-label={`Verifier number ${index + 1}`}>
                  {index + 1}
                </span>
                <Avatar name={verifier.full_name} size="sm" />
                <div className="grid min-w-0 gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">{verifier.full_name}</span>
                  <span className="truncate text-xs text-muted">{verifier.role} · {verifier.account_status}</span>
                </div>
              </div>
              <Badge tone="success">Authorized</Badge>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center">
          <p className="text-sm text-muted">
            No verifiers configured. Manage verifiers in
            {' '}
            <strong>Incident closure access</strong>
            {' '}
            to auto-sync investigation verifiers.
          </p>
        </div>
      )}
    </SettingsSectionShell>
  )
}
