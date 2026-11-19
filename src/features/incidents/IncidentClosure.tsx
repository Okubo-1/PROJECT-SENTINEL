import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button, Checkbox, Field, FormMessage, Textarea } from '../../components/ui'
import { closeIncident, incidentClosureInputSchema } from './incidentClosureService'
import type { IncidentSummary } from './incidentTypes'
import { invalidateSafetyIntelligence } from '../safety-intelligence/safetyIntelligenceQueryKeys'

export function IncidentClosureForm({ client, incident, onDismiss, variant = 'panel' }: {
  client: SupabaseClient; incident: IncidentSummary; onDismiss: () => void; variant?: 'panel' | 'dialog';
}) {
  const formRef = useRef<HTMLElement>(null)
  const isDialog = variant === 'dialog'
  useEffect(() => {
    if (!isDialog) formRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [isDialog])
  const [rootCause, setRootCause] = useState('')
  const [correctiveAction, setCorrectiveAction] = useState('')
  const [actionCompleted, setActionCompleted] = useState(false)
  const [validationError, setValidationError] = useState('')
  const queryClient = useQueryClient()
  const closure = useMutation({
    mutationFn: async () => {
      const parsed = incidentClosureInputSchema.safeParse({ rootCause, correctiveAction, actionCompleted })
      if (!parsed.success) throw new Error(parsed.error.issues[0].message)
      await closeIncident(client, incident.id, parsed.data)
    },
    onSuccess: async () => {
      // Status, closure evidence, activity history and dashboard counts change in one transaction.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['incidents'] }),
        queryClient.invalidateQueries({ queryKey: ['incident-closure', incident.organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', incident.organizationId] }),
        invalidateSafetyIntelligence(queryClient, incident.organizationId),
      ])
      onDismiss()
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setValidationError('')
    const parsed = incidentClosureInputSchema.safeParse({ rootCause, correctiveAction, actionCompleted })
    if (!parsed.success) { setValidationError(parsed.error.issues[0].message); return }
    closure.mutate()
  }

  const form = (
    <form className="grid gap-4" onSubmit={submit}>
      {incident.isAnonymous && <p className="text-sm text-muted">Do not include names or details that could identify you.</p>}
      <Field label="Root cause" htmlFor="incident-closure-root-cause" required hint="What caused the incident?">
        <Textarea
          id="incident-closure-root-cause"
          data-autofocus
          value={rootCause}
          onChange={(event) => setRootCause(event.target.value)}
          required
          minLength={3}
          maxLength={5000}
          rows={3}
          disabled={closure.isPending}
        />
      </Field>
      <Field label="Completed corrective action" htmlFor="incident-closure-corrective-action" required hint="What was done to prevent recurrence?">
        <Textarea
          id="incident-closure-corrective-action"
          value={correctiveAction}
          onChange={(event) => setCorrectiveAction(event.target.value)}
          required
          minLength={3}
          maxLength={5000}
          rows={3}
          disabled={closure.isPending}
        />
      </Field>
      <Checkbox
        checked={actionCompleted}
        onChange={setActionCompleted}
        label="I confirm this corrective action has been completed."
        disabled={closure.isPending}
      />
      <FormMessage error={validationError || closure.error?.message || ''} />
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" onClick={onDismiss} disabled={closure.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" size="sm" loading={closure.isPending}>
          {closure.isPending ? 'Closing…' : 'Confirm closure'}
        </Button>
      </div>
    </form>
  )

  if (isDialog) return form

  return <section ref={formRef} className="grid gap-3 rounded-card border border-line bg-surface p-5 shadow-card" aria-label={`Close incident ${incident.referenceNumber}`}>
    <h3 className="font-display text-lg font-semibold text-foreground">Close incident {incident.referenceNumber}</h3>
    <p className="text-sm text-muted">{incident.title}</p>
    <p className="text-sm text-muted">A root cause and completed corrective action are required. Linked corrective actions must already be verified or closed. An investigation is not required.</p>
    <div className="mt-1">{form}</div>
  </section>
}
