import { Field, FormSection, Input } from '../../components/ui'

export type ReportingIdentity = 'me' | 'anonymous'

export function ReportStagePeople({ reporterName, identity = 'me', onChange, locked = false, anonymousEnabled = false }: {
  reporterName: string
  identity?: ReportingIdentity | null
  onChange?: (identity: ReportingIdentity) => void
  locked?: boolean
  anonymousEnabled?: boolean
}) {
  return (
    <FormSection title="Reporting identity" description={anonymousEnabled ? 'Choose your reporting identity before saving. It cannot be changed afterwards.' : identity === 'anonymous' ? 'This report is anonymous.' : 'This report is associated with your account.'}>
      {anonymousEnabled && (
        <fieldset className="mb-4 grid gap-2" disabled={locked}>
          <legend className="mb-2 text-sm font-medium">Report as me or anonymous</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="reporting-identity" checked={identity === 'me'} onChange={() => onChange?.('me')} />Report as me</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="reporting-identity" checked={identity === 'anonymous'} onChange={() => onChange?.('anonymous')} />Report as anonymous</label>
        </fieldset>
      )}
      {identity !== 'anonymous' && <Field label="Report as me" htmlFor="incident-reporter">
        <Input id="incident-reporter" value={reporterName} readOnly aria-readonly="true" />
      </Field>}
      {identity === 'anonymous' && <p className="text-sm text-muted">Anonymous reporter</p>}
    </FormSection>
  )
}
