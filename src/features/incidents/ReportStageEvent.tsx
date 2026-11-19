import type { UseFormReturn } from 'react-hook-form'

import { Field, FormGrid, FormSection, Input } from '../../components/ui'
import type { IncidentFormValues } from './incidentSchemas'
import { selectClassName } from './reportFormStyles'

export function ReportStageEvent({ form, categories, severities }: {
  form: UseFormReturn<IncidentFormValues>
  categories: string[]
  severities: string[]
}) {
  return (
    <FormSection title="What happened?" description="Required fields are validated before you can continue.">
      <FormGrid>
        <Field label="Event category" htmlFor="incident-category" required error={form.formState.errors.incidentCategory?.message}>
          <select id="incident-category" {...form.register('incidentCategory')} className={selectClassName}>
            <option value="">Select incident category</option>
            {categories.map((category) => <option value={category} key={category}>{category}</option>)}
          </select>
        </Field>
        <Field label="Severity" htmlFor="incident-severity" required error={form.formState.errors.severity?.message}>
          <select id="incident-severity" {...form.register('severity')} className={selectClassName}>
            <option value="">Select severity</option>
            {severities.map((severity) => <option value={severity} key={severity}>{severity}</option>)}
          </select>
        </Field>
        <Field label="Date" htmlFor="incident-date" required error={form.formState.errors.occurrenceDate?.message}>
          <Input id="incident-date" type="date" {...form.register('occurrenceDate')} />
        </Field>
        <Field label="Time" htmlFor="incident-time" required error={form.formState.errors.occurrenceTime?.message}>
          <Input id="incident-time" type="time" {...form.register('occurrenceTime')} />
        </Field>
      </FormGrid>
    </FormSection>
  )
}
