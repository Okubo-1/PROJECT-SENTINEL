# Investigation Settings and Data Model

## Overview

This implementation provides a complete investigation settings and data model for the QHSE app, including severity-level-based team management, configurable deadlines, timeline event tracking, and verifier synchronization.

## Assumptions Made

1. **Investigation table** already exists with `id`, `incident_id`, `status`, and core fields
2. **Severity levels** are stored in `company_settings.severity_levels` JSONB (array of `{id, name, active}`)
3. **Closure access delegates** already exist in `incident_closure_delegates` table
4. **Settings pages** use `SettingsSectionShell` component with save patterns from `SeveritySection`
5. **ClosureAccessSection pattern** (search + toggle + list) reused for team member selection
6. **Database** uses composite `(id, organization_id)` keys and RLS policies for security

## Implementation Structure

### Database Migrations

#### 1. `202611180001_investigation_extended_fields.sql`

Adds investigation analysis workflow columns:
- `level`: text field for severity level reference
- `due_at`: timestamptz for calculated deadline
- `witness_statement`: text for witness testimony (max 10,000 chars)
- `immediate_causes`: text for identified causes (max 5,000 chars)
- `root_cause_method`: text for analysis methodology (max 100 chars)
- `root_cause_breakdown`: jsonb array of `{category, description}` objects
- `root_causes_summary`: text summary of findings (max 10,000 chars)
- `contributing_factors`: text for management/system factors (max 10,000 chars)
- `closed_at`: timestamptz for investigation closure date

**Trigger**: `update_investigation_due_at()` automatically calculates `due_at` based on severity level and configured deadlines.

**Indexes**: 
- `(organization_id, level)` for filtering by severity
- `(organization_id, due_at)` for deadline tracking
- `(organization_id, root_cause_method)` for analysis method grouping

#### 2. `202611180002_investigation_timeline_events.sql`

Creates timeline events table with audit trail:
- **Columns**: `id`, `organization_id`, `investigation_id`, `event_type`, `actor_id`, `details`, `created_at`
- **Event types**: `created`, `assigned`, `started`, `finding_added`, `status_changed`, `completed`
- **Details**: JSONB for event-specific data
- **RLS**: Organization members with QHSE Manager+ roles can read; Super Admin/Org Admin can insert

**Indexes**:
- `(organization_id, investigation_id)` for timeline retrieval
- `(organization_id, created_at)` for chronological queries
- `(organization_id, event_type)` for event type filtering

#### 3. `202611180003_investigation_team_members.sql`

Creates team member assignment table:
- **Columns**: `id`, `organization_id`, `severity_level`, `user_id`, `added_by`, `added_at`
- **Unique constraint**: `(organization_id, severity_level, user_id)` prevents duplicate assignments
- **RLS**: Super Admin/Org Admin can manage; QHSE Manager can read

**Indexes**:
- `(organization_id, severity_level)` for team member lookup by severity
- `(organization_id, user_id)` for user-centric queries
- `(organization_id, added_at)` for chronological tracking

#### 4. `202611180004_investigation_deadlines.sql`

Creates deadline configuration table:
- **Columns**: 
  - `organization_id` (primary key)
  - `critical_hours`, `high_hours`, `medium_hours`, `low_hours` (positive integers, defaults: 24, 72, 168, 336)
  - `verification_enabled` (boolean, default: true)
  - `updated_at` (timestamptz)
- **RLS**: Super Admin/Org Admin can manage

**Function**: `get_investigation_deadlines(organization_id)` retrieves org-specific deadlines for authorized users.

### React Components

#### 1. `InvestigationTeamsSection.tsx`

Manages investigation team members by severity level:
- Lists all configured severity levels
- Shows team member count per level
- Modal dialog for adding/removing members
- Search functionality for finding users
- Prevents duplicate assignments
- Uses query keys: `investigation-team-members`, `investigation-team-candidates`

**Features**:
- Read-only severity level display
- Click-to-open modal for each severity
- In-modal search with auto-filtering
- Numbered list with avatar badges
- Disable/Remove actions for existing members

#### 2. `InvestigationDeadlinesSection.tsx`

Configures investigation deadlines:
- 4 time input fields (Critical, High, Medium, Low)
- Display calculated human-readable durations
- Verification toggle (default on)
- Saves immediately via mutation
- Shows unsaved state with warning badge

**Features**:
- Real-time duration calculation
- Form dirty state tracking
- Upsert pattern for create-or-update
- Success/error alerts
- Disabled state management

#### 3. `VerifiersSection.tsx`

Read-only display of investigation verifiers:
- Synced from `incident_closure_delegates`
- Numbered list with avatar badges
- Role and status display
- Helper text explaining auto-sync behavior
- No edit controls

**Features**:
- Loading skeleton state
- Error alert with retry
- Empty state with guidance
- Auto-synced badge
- Authorization badge for each verifier

### Service Functions (`investigationService.ts`)

TypeScript service layer for investigation operations:

**Team Member Functions**:
- `getInvestigationTeamMembers(client, organizationId, severityLevel?)`: Fetch team members, optionally filtered by severity
- `addInvestigationTeamMember(client, organizationId, severityLevel, userId)`: Add member to team
- `removeInvestigationTeamMember(client, organizationId, memberId)`: Remove member from team

**Deadline Functions**:
- `getInvestigationDeadlines(client, organizationId)`: Fetch org-specific deadlines or null
- `updateInvestigationDeadlines(client, organizationId, deadlines)`: Create or update deadlines (upsert)

**Timeline Functions**:
- `addInvestigationTimelineEvent(client, organizationId, investigationId, eventType, details)`: Record timeline event
- `getInvestigationTimeline(client, organizationId, investigationId)`: Retrieve investigation timeline

**Utility Functions**:
- `calculateInvestigationDueDate(createdAt, severityLevel, deadlines?)`: Calculate due date from creation time and severity
- `formatInvestigationDuration(hours)`: Format hours as human-readable duration (e.g., "2 days 12h")

**Types**:
- `InvestigationTeamMember`: Team member with user details
- `InvestigationDeadlines`: Deadline configuration
- `InvestigationTimelineEvent`: Single timeline event
- `InvestigationServiceError`: Custom error class

### Tests

#### SQL Tests (`supabase/tests/investigation_schema.sql`)

6 comprehensive test cases:
1. **RLS Isolation**: Verify organization boundaries
2. **Team Assignment**: Verify severity-level-based assignment
3. **Deadline Calculation**: Verify due date trigger and calculations
4. **RLS for Deadlines**: Verify deadline visibility boundaries
5. **Timeline Events**: Verify event creation and retrieval
6. **Unique Constraint**: Verify duplicate prevention

#### TypeScript Tests (`investigationService.test.ts`)

Unit and integration tests:
- Duration formatting (hours, days, mixed)
- Due date calculation (default and custom deadlines)
- Schema validation (types, enums)
- Error handling
- Deadline enforcement
- Lifecycle tracking scenarios

## Integration Points

### Component Usage

Add to `SettingsPage.tsx`:

```tsx
import { InvestigationTeamsSection } from './InvestigationTeamsSection'
import { InvestigationDeadlinesSection } from './InvestigationDeadlinesSection'
import { VerifiersSection } from './VerifiersSection'

export function SettingsPage() {
  return (
    <div>
      {/* ... other sections ... */}
      <InvestigationTeamsSection 
        client={supabaseClient} 
        organizationId={organizationId}
        severities={companySettings.severity_levels}
      />
      <InvestigationDeadlinesSection 
        client={supabaseClient} 
        organizationId={organizationId}
      />
      <VerifiersSection 
        client={supabaseClient} 
        organizationId={organizationId}
      />
    </div>
  )
}
```

### Service Usage

```tsx
import { 
  getInvestigationTeamMembers,
  addInvestigationTimelineEvent,
  calculateInvestigationDueDate 
} from '../investigationService'

// Get team members for a severity level
const members = await getInvestigationTeamMembers(client, orgId, 'Critical')

// Record timeline event
await addInvestigationTimelineEvent(
  client, 
  orgId, 
  investigationId, 
  'started',
  { started_by: userId }
)

// Calculate due date
const due = calculateInvestigationDueDate(
  investigation.created_at,
  investigation.level
)
```

## Security Considerations

### RLS Policies

All tables use composite keys `(id, organization_id)` to enforce multi-tenancy:

- **investigation_team_members**: Only Super Admin/Org Admin can manage; QHSE Manager can read
- **investigation_deadlines**: Only Super Admin/Org Admin can read/write
- **investigation_timeline_events**: QHSE Manager+ can read; Super Admin/Org Admin can write

### Authentication

- All mutations require authenticated user via `auth.getUser()`
- Role-based access control via `has_org_role()` function
- Composite foreign keys ensure cross-org data cannot reference each other

## Rollback Strategy

Each migration includes rollback guidance in comments:

1. **Extended fields**: Drop new columns from investigations table
2. **Timeline events**: Drop investigation_timeline_events table
3. **Team members**: Drop investigation_team_members table
4. **Deadlines**: Drop investigation_deadlines table

Rollback is non-destructive for existing incident data.

## Performance Optimization

### Indexing Strategy

- Composite indexes on `(organization_id, ...)` for RLS isolation
- Partial indexes for active/open investigations
- Covering indexes where beneficial

### Query Optimization

- RPC function `get_investigation_deadlines()` pre-filters by role
- Pagination in team member queries (100+ orgs)
- Lazy-load timeline events (infinite scroll pattern supported)

## Submission Automation and Register

Migration `202611180005_investigation_automation_access.sql` creates one investigation in the same transaction when an incident is submitted. The trigger handles both identified incident inserts and the private anonymous draft-to-submitted transition. It copies the incident severity, calculates the due date from organization settings (or the configured defaults), records a system timeline entry, and queues recipient-scoped notifications for active members of that severity team.

Anonymous records do not copy `created_by` into the investigation. Their creation timeline entry has no actor, and the timeline guard restricts event details to non-identifying investigation fields. The register RPC returns only the incident reference, severity, status, due date, overdue state, team roster, and the admin-only unassigned flag; it never reads the private reporter-link schema.

The register is available as an Investigations tab in the inspection area. Super Administrators, Organization Administrators, QHSE Managers, and closure-access verifiers can see all investigations; other team members see only matching severity levels. The list RPC queues one due-soon notification per team member when a deadline is within 24 hours, or within 6 hours for Critical investigations. This page-load processing is idempotent and uses the notification uniqueness constraint instead of a scheduler.

Targeted coverage for both submission paths, role/team visibility, overdue state, and anonymous identity omission is in `supabase/tests/investigation_automation.sql`.

## Investigation Record and Closure

Migration `202611180006_investigation_record_workflow.sql` adds the team-facing investigation dialog, private record read/save RPCs, and links report files and optional attachments to existing incident-evidence records. Report documents are limited to PDF or Word files; anonymous evidence continues through the existing sanitized `incident-evidence` workflow and does not use or alter the separate anonymous evidence bucket.

The record can be saved before completion. Closing requires immediate causes, a valid 5 Whys, Fishbone, or Fault Tree analysis with at least one root cause, and a valid investigation report. The RPC sets the investigation to `completed`, records `closed_at` and a timeline event, and relies on the existing private reporter-status notification trigger to emit `investigated`; it does not change the incident status.

Client validation and root cause generation are covered by `src/features/incidents/investigationRecordValidation.test.ts`. Server validation, method persistence/reload, report type enforcement, and separation from incident closure are covered by `supabase/tests/investigation_record_workflow.sql`.

## Action Close-Out, Verification, and Reopening

Migration `202611180008_incident_verification_reopen.sql` requires resolution details and a valid uploaded photo or document before an action can be resolved. When the investigation is complete and all linked actions are resolved, the incident moves to `pending_verification` and closure-access delegates and Super Administrators receive in-app notifications.

Verifiers must view the investigation and cannot confirm an incident if they resolved any linked action. Only verifier confirmation changes an incident to `closed`. Super Administrators can reopen a closed incident or completed investigation, assign an active handler, provide an optional reason, and notify the handler. Anonymous reporter data remains private in investigation views.

The targeted SQL regression suite in `supabase/tests/investigation_record_workflow.sql` covers these server-side rules, including report validation, action resolution evidence, verifier separation, verifier-only closure, reopening, and anonymous-view privacy.

## Future Enhancements

1. **Finding linking**: Connect findings to root cause categories
2. **Team templates**: Save/load team configurations by severity
3. **SLA tracking**: Monitor deadline compliance metrics
4. **Audit log**: Enhanced audit trail of investigation changes

## Files Created

**Migrations** (4 files):
- `supabase/migrations/202611180001_investigation_extended_fields.sql`
- `supabase/migrations/202611180002_investigation_timeline_events.sql`
- `supabase/migrations/202611180003_investigation_team_members.sql`
- `supabase/migrations/202611180004_investigation_deadlines.sql`

**Components** (3 files):
- `src/features/settings/InvestigationTeamsSection.tsx`
- `src/features/settings/InvestigationDeadlinesSection.tsx`
- `src/features/settings/VerifiersSection.tsx`

**Services** (2 files):
- `src/features/incidents/investigationService.ts`
- `src/features/incidents/investigationService.test.ts`

**Tests** (1 file):
- `supabase/tests/investigation_schema.sql`

**Total**: 10 files
