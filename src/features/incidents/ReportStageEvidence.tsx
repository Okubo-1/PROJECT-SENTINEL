import type { ChangeEvent } from 'react'
import type { UseFormReturn } from 'react-hook-form'

import { Alert, Field, FormSection, Icon } from '../../components/ui'
import type { IncidentFormValues } from './incidentSchemas'
import type { IncidentEvidence } from './incidentTypes'

export function ReportStageEvidence({ form, evidence, isBusy, isUploading, message, error, onEvidence }: {
  form: UseFormReturn<IncidentFormValues>
  evidence: IncidentEvidence[]
  isBusy: boolean
  isUploading: boolean
  message?: string
  error?: string
  onEvidence: (event: ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <FormSection title="Evidence and sign-off" description="Evidence is optional. Images, PDF, Word, Excel, and video evidence are supported.">
      <p className="mb-3 text-sm text-muted">Photos and documents may show your name, face or other details. Check before you upload.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-surface-soft px-4 py-6 text-center transition-colors hover:border-brand/50">
          <Icon name="camera" size={20} className="text-brand" />
          <span className="text-sm font-medium text-foreground">Photo</span>
          <span className="text-[11px] text-muted">Camera or gallery</span>
          <input type="file" hidden accept="image/*" capture="environment" onChange={onEvidence} disabled={isBusy} />
        </label>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-surface-soft px-4 py-6 text-center transition-colors hover:border-brand/50">
          <Icon name="upload" size={20} className="text-brand" />
          <span className="text-sm font-medium text-foreground">Video</span>
          <span className="text-[11px] text-muted">Capture or upload</span>
          <input type="file" hidden accept="video/*" capture="environment" onChange={onEvidence} disabled={isBusy} />
        </label>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-surface-soft px-4 py-6 text-center transition-colors hover:border-brand/50">
          <Icon name="file" size={20} className="text-brand" />
          <span className="text-sm font-medium text-foreground">Documents</span>
          <span className="text-[11px] text-muted">PDF, Word, Excel</span>
          <input type="file" hidden accept="application/pdf,.doc,.docx,.xls,.xlsx" onChange={onEvidence} disabled={isBusy} />
        </label>
      </div>

      {isUploading && <p className="mt-3 text-sm text-muted" role="status">Uploading evidence…</p>}
      {message && <Alert tone="success" className="mt-3">{message}</Alert>}
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}

      {evidence.length > 0 && (
        <ul className="mt-4 grid gap-2" aria-label="Attached evidence">
          {evidence.map((item) => (
            <li key={item.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm text-muted">
              <Icon name="fileCheck" size={14} className="text-brand" />
              <span className="truncate">{item.originalFilename}</span>
            </li>
          ))}
        </ul>
      )}

      <Field className="mt-4" error={form.formState.errors.accuracyConfirmed?.message}>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="checkbox" {...form.register('accuracyConfirmed')} className="mt-0.5 h-4 w-4 accent-brand" />
          I confirm this report is accurate to the best of my knowledge. *
        </label>
      </Field>
    </FormSection>
  )
}
