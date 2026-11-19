import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActionCreateForm } from '../../src/features/qhse/ActionCreateForm.tsx'
import { ActionRegister } from '../../src/features/qhse/ActionRegister.tsx'

const notice = 'Do not include names or details that could identify you.'
const incident = { id: 'incident', reference_number: 'INC-1', title: 'Incident', status: 'submitted', is_anonymous: true }
const action = {
  id: 'action', incident_id: incident.id, type: 'investigation', organization_id: 'org',
  site_id: 'site', assignee_id: 'user', created_by: 'user', description: 'Investigation',
  due_at: '2026-01-01', status: 'open', resolution_notes: null,
}
const noop = () => {}

export function testAnonymousTextNotice() {
  const form = {
    type: 'investigation' as const, onTypeChange: noop, siteId: '', onSiteChange: noop,
    assigneeId: '', onAssigneeChange: noop, dueAt: '', onDueAtChange: noop,
    incidentId: incident.id, onIncidentChange: noop, description: '', onDescriptionChange: noop,
    sites: [], people: [], eligibleIncidents: [incident], busy: false, loading: false, onSubmit: noop,
  }
  const html = renderToStaticMarkup(createElement(ActionCreateForm, form))
  if (!html.includes(notice)) throw new Error('Missing anonymous action notice')
  const identified = renderToStaticMarkup(createElement(ActionCreateForm, {
    ...form, eligibleIncidents: [{ ...incident, is_anonymous: false }],
  }))
  if (identified.includes(notice)) throw new Error('Notice appeared on an identified incident')

  const register = {
    filteredActions: [action], workspaceLoading: false, currentTime: Date.now(), currentUserId: 'user',
    canManage: true, assignedOnly: false, busy: false, resolutionAction: action.id, resolutionNotes: '',
    sites: [], people: [], linkedIncidents: [incident], onToggleResolve: noop,
    onResolutionNotesChange: noop, onProofFileChange: noop, onCancelResolve: noop,
    onResolve: noop, onReassign: noop, onDownloadProof: noop,
  }
  if (!renderToStaticMarkup(createElement(ActionRegister, register)).includes(notice)) {
    throw new Error('Missing anonymous investigation resolution notice')
  }
}
