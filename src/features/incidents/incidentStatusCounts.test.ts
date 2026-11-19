import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateIncidentStatusCounts,
  isClosedIncidentStatus,
  isOpenIncidentStatus,
} from '../../../supabase/functions/_shared/incidentReportFilters.ts'
import { calculateInvestigationDueDate } from './investigationService.ts'

test('incident register and shared status counts agree and exclude drafts', () => {
  const rows = [
    { status: 'submitted', severity: 'High', potential_severity: null },
    { status: 'pending_verification', severity: 'Critical', potential_severity: null },
    { status: 'closed', severity: 'High', potential_severity: null },
    { status: 'closed', severity: 'Low', potential_severity: 'Medium' },
    { status: 'draft', severity: 'Critical', potential_severity: null },
    { status: 'submitted', severity: 'High', potential_severity: 'Unmapped severity' },
  ]
  const counts = calculateIncidentStatusCounts(rows)
  const registerCounts = {
    open: rows.filter((row) => isOpenIncidentStatus(row.status)).length,
    closed: rows.filter((row) => isClosedIncidentStatus(row.status)).length,
  }

  assert.deepEqual(counts, {
    total: 5,
    open: 3,
    closed: 2,
    highRisk: 3,
    openHighRisk: 2,
    closedHighRisk: 1,
  })
  assert.deepEqual(registerCounts, { open: counts.open, closed: counts.closed })
})

test('a configured deadline changes investigation due dates while dashboard incident counts stay aligned', () => {
  const createdAt = '2026-11-17T08:00:00.000Z'
  const dueAt = calculateInvestigationDueDate(createdAt, 'High', {
    critical_hours: 24,
    high_hours: 6,
    medium_hours: 168,
    low_hours: 336,
    verification_enabled: true,
  })

  assert.equal(dueAt.toISOString(), '2026-11-17T14:00:00.000Z')
  assert.deepEqual(calculateIncidentStatusCounts([{
    status: 'submitted',
    severity: 'High',
    potential_severity: null,
  }]), {
    total: 1,
    open: 1,
    closed: 0,
    highRisk: 1,
    openHighRisk: 1,
    closedHighRisk: 0,
  })
})
