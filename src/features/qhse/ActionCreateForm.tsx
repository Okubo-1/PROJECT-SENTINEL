import type { FormEvent } from 'react'

import { Button, Card, Field, FormActions, FormFull, FormGrid, FormSection, Input, Select, Textarea } from '../../components/ui'
import type { ActionType, EligibleIncident, QhsePerson, QhseSite } from './inspectionActionService'

export function ActionCreateForm({ type, onTypeChange, siteId, onSiteChange, assigneeId, onAssigneeChange, dueAt, onDueAtChange, incidentId, onIncidentChange, description, onDescriptionChange, sites, people, eligibleIncidents, busy, loading, onSubmit }: {
  type: ActionType
  onTypeChange: (type: ActionType) => void
  siteId: string
  onSiteChange: (id: string) => void
  assigneeId: string
  onAssigneeChange: (id: string) => void
  dueAt: string
  onDueAtChange: (value: string) => void
  incidentId: string
  onIncidentChange: (id: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  sites: QhseSite[]
  people: QhsePerson[]
  eligibleIncidents: EligibleIncident[]
  busy: boolean
  loading: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <Card className="p-5 shadow-none">
      <form className="grid gap-5" onSubmit={onSubmit}>
        <FormSection title="Create action" description="Assign the action to an active member of this organization.">
          <FormGrid>
            <Field label="Type" htmlFor="action-type" required>
              <Select id="action-type" value={type} onChange={(event) => onTypeChange(event.target.value as ActionType)}>
                <option value="preventive">Preventive</option>
                <option value="corrective">Corrective</option>
                <option value="investigation">Investigation</option>
              </Select>
            </Field>
            <Field label="Site" htmlFor="action-site" required>
              <Select id="action-site" value={siteId} onChange={(event) => onSiteChange(event.target.value)} required>
                <option value="">Select a site</option>
                {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </Select>
            </Field>
            <Field label="Assignee" htmlFor="action-assignee" required>
              <Select id="action-assignee" value={assigneeId} onChange={(event) => onAssigneeChange(event.target.value)} required>
                <option value="">Select an assignee</option>
                {people.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}
              </Select>
            </Field>
            <Field label="Due date and time" htmlFor="action-due" required>
              <Input id="action-due" type="datetime-local" value={dueAt} onChange={(event) => onDueAtChange(event.target.value)} required />
            </Field>
            <FormFull>
              <Field label="Incident" htmlFor="action-incident">
                <Select id="action-incident" value={incidentId} onChange={(event) => onIncidentChange(event.target.value)}>
                  <option value="">No linked incident</option>
                  {eligibleIncidents.map((incident) => <option key={incident.id} value={incident.id}>{incident.reference_number} — {incident.title}</option>)}
                </Select>
              </Field>
            </FormFull>
            <FormFull>
              <Field label="Description" htmlFor="action-description" required>
                {eligibleIncidents.find((incident) => incident.id === incidentId)?.is_anonymous && (
                  <p className="mb-2 text-sm text-muted">Do not include names or details that could identify you.</p>
                )}
                <Textarea id="action-description" rows={4} value={description} onChange={(event) => onDescriptionChange(event.target.value)} required />
              </Field>
            </FormFull>
          </FormGrid>
        </FormSection>
        <FormActions>
          <Button type="submit" loading={busy} disabled={loading || !sites.length || !people.length}>
            Create action
          </Button>
        </FormActions>
      </form>
    </Card>
  )
}
