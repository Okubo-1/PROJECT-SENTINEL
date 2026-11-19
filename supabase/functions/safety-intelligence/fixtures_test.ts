import {
  safetySourceNames, type SafetyDataset, type SafetyIncident, type SafetyScope,
} from '../_shared/safetyIntelligenceContracts.ts'

export const id = (n: number) => `ab000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const org = id(1)
export const user = id(2)
export const site = id(3)
export const facility = id(4)
export const asOf = new Date('2026-10-06T12:00:00.000Z')
export const scope: SafetyScope = {
  organizationId: org, userId: user, visibility: 'organization', siteAssignmentEnforced: false,
}
export function incident(n: number, overrides: Partial<SafetyIncident> = {}): SafetyIncident {
  return {
    id: id(100 + n), organization_id: org, reference_number: `TEST-${n}`, title: `Recorded event ${n}`,
    is_anonymous: false,
      report_type: 'incident', status: 'submitted', occurred_at: '2026-10-02T12:00:00.000Z', reported_at: '2026-10-02T12:00:00.000Z', 
    site_id: site, facility_id: facility, severity: 'Low', potential_severity: null,
    incident_category: 'Equipment', ...overrides,
  }
}
export function dataset(incidents: SafetyIncident[] = []): SafetyDataset {
  return {
    companySettings: {
      organization_id: org, operational_sites: ['Fixture Site'], departments: ['Fixture Department'],
      severity_levels: ['Low', 'Medium', 'High', 'Critical'], incident_categories: ['Equipment'],
    },
    rows: {
      incidents, actions: [], investigations: [], causes: [], findings: [], closures: [],
      sites: [{ id: site, organization_id: org, name: 'Fixture Site' }],
      facilities: [{ id: facility, organization_id: org, site_id: site, name: 'Fixture Facility' }],
    },
    coverage: safetySourceNames.map((source) => ({
      source, complete: true, retrieved: source === 'incidents' ? incidents.length : 0,
      included: source === 'incidents' ? incidents.length : 0, access: 'organization', reasons: [],
    })),
  }
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
export function equal(actual: unknown, expected: unknown) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
