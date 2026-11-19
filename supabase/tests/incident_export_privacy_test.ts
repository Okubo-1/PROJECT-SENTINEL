import { exportRows } from '../../src/features/incidents/incidentExport.ts'
import type { IncidentSummary } from '../../src/features/incidents/incidentTypes.ts'

Deno.test('incident export masks anonymous reporters and preserves identified reporters', () => {
  const marker = 'private-reporter-id'
  const common: IncidentSummary = {
    id: 'incident-id', organizationId: 'organization-id', referenceNumber: 'INC-1',
    reportType: 'incident', status: 'submitted', title: 'Safety event',
    occurredAt: null, reportedAt: null, siteId: null, facilityId: null,
    location: null, department: null, shift: null, severity: null,
    potentialSeverity: null, incidentCategory: null, isAnonymous: true,
    createdBy: marker, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
  const [anonymous, identified] = exportRows([
    common, { ...common, isAnonymous: false, createdBy: 'identified-reporter' },
  ], [])
  if (anonymous.reporter !== 'Anonymous reporter' || JSON.stringify(anonymous).includes(marker)) {
    throw new Error('Anonymous reporter escaped the export row')
  }
  if (identified.reporter !== 'identified-reporter') throw new Error('Identified reporter changed')
})
