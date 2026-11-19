import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Alert, Badge, Button, Field, Input, Toggle } from '../../components/ui'
import { SettingsSectionShell } from './SettingsSectionShell'

type InvestigationDeadlines = {
  critical_hours: number
  high_hours: number
  medium_hours: number
  low_hours: number
  verification_enabled: boolean
}

export function InvestigationDeadlinesSection({ client, organizationId }: {
  client: SupabaseClient
  organizationId: string
}) {
  const queryClient = useQueryClient()
  const [dirty, setDirty] = useState(false)
  const [form, setForm] = useState<InvestigationDeadlines>({
    critical_hours: 24,
    high_hours: 72,
    medium_hours: 168,
    low_hours: 336,
    verification_enabled: true,
  })

  const deadlines = useQuery({
    queryKey: ['investigation-deadlines', organizationId],
    queryFn: async () => {
      const { data, error } = await client
        .from('investigation_deadlines')
        .select('critical_hours, high_hours, medium_hours, low_hours, verification_enabled')
        .eq('organization_id', organizationId)
        .single()

      if (error && error.code !== 'PGRST116') throw new Error(error.message)
      return data as InvestigationDeadlines | null
    },
  })

  useEffect(() => {
    if (deadlines.data) {
      setForm(deadlines.data)
      setDirty(false)
    }
  }, [deadlines.data])

  const updateMutation = useMutation({
    mutationFn: async (data: InvestigationDeadlines) => {
      const { error } = await client
        .from('investigation_deadlines')
        .upsert({
          organization_id: organizationId,
          ...data,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId)

      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investigation-deadlines'] })
      setDirty(false)
    },
  })

  const handleChange = (field: keyof InvestigationDeadlines, value: unknown) => {
    setForm((prev) => ({
      ...prev,
      [field]: value,
    }))
    setDirty(true)
  }

  const handleSave = () => {
    updateMutation.mutate(form)
  }

  const calculateDuration = (hours: number): string => {
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''}`
    if (hours % 24 === 0) {
      const days = hours / 24
      return `${days} day${days !== 1 ? 's' : ''}`
    }
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return `${days} day${days !== 1 ? 's' : ''} ${remainingHours}h`
  }

  if (deadlines.isPending) {
    return <div className="animate-pulse h-32 bg-surface rounded" />
  }

  return (
    <SettingsSectionShell
      title="Investigation deadlines"
      description="Configure investigation completion deadlines by severity level. These are used to auto-calculate due dates."
      action={dirty ? <Badge tone="warning">Unsaved</Badge> : <Badge tone="info">Saves immediately</Badge>}
    >
      <div className="grid gap-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Critical severity (hours)" hint={`= ${calculateDuration(form.critical_hours)}`}>
            <Input
              type="number"
              min="1"
              max="8760"
              value={form.critical_hours}
              onChange={(e) => handleChange('critical_hours', parseInt(e.target.value, 10))}
              className="font-mono"
            />
          </Field>

          <Field label="High severity (hours)" hint={`= ${calculateDuration(form.high_hours)}`}>
            <Input
              type="number"
              min="1"
              max="8760"
              value={form.high_hours}
              onChange={(e) => handleChange('high_hours', parseInt(e.target.value, 10))}
              className="font-mono"
            />
          </Field>

          <Field label="Medium severity (hours)" hint={`= ${calculateDuration(form.medium_hours)}`}>
            <Input
              type="number"
              min="1"
              max="8760"
              value={form.medium_hours}
              onChange={(e) => handleChange('medium_hours', parseInt(e.target.value, 10))}
              className="font-mono"
            />
          </Field>

          <Field label="Low severity (hours)" hint={`= ${calculateDuration(form.low_hours)}`}>
            <Input
              type="number"
              min="1"
              max="8760"
              value={form.low_hours}
              onChange={(e) => handleChange('low_hours', parseInt(e.target.value, 10))}
              className="font-mono"
            />
          </Field>
        </div>

        <div className="rounded-lg border border-line p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="grid gap-1">
              <label className="text-sm font-medium text-foreground">Verification required</label>
              <p className="text-xs text-muted">Require verification before closing investigations</p>
            </div>
            <Toggle
              checked={form.verification_enabled}
              onCheckedChange={(enabled) => handleChange('verification_enabled', enabled)}
            />
          </div>
        </div>

        {dirty && (
          <Button onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        )}

        {updateMutation.isError && <Alert tone="danger">{updateMutation.error.message}</Alert>}
        {updateMutation.isSuccess && !dirty && <Alert tone="success">Investigation deadlines updated.</Alert>}
      </div>
    </SettingsSectionShell>
  )
}
