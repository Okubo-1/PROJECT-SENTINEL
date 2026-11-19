import type { UseFormReturn } from 'react-hook-form'

import { Alert, Field, FormGrid, FormSection, Input } from '../../components/ui'
import type { IncidentFormValues } from './incidentSchemas'
import { selectClassName } from './reportFormStyles'

type SiteOption = { id: string; name: string }
export type ReportFacility = { id: string; name: string; site_id: string | null; department_key: string | null }

export function ReportStageLocation({ form, configuredSites, departments, shifts, weatherOptions, facilities, facilitiesAvailable }: {
  form: UseFormReturn<IncidentFormValues>
  configuredSites: SiteOption[]
  departments: SiteOption[]
  shifts: string[]
  weatherOptions: string[]
  facilities: ReportFacility[]
  facilitiesAvailable: boolean
}) {
  const weather = form.watch('weatherConditions')
  const siteId = form.watch('siteId')
  const facilityId = form.watch('facilityId')
  const department = form.watch('department')
  const locationType = form.watch('locationType')
  const departmentId = departments.find((item) => item.name === department)?.id
  const parentFacilities = facilities.filter((facility) => locationType === 'site'
    ? Boolean(siteId && facility.site_id === siteId)
    : Boolean(locationType === 'department' && departmentId && facility.department_key === departmentId))
  const clearFacility = () => { form.setValue('facilityId', undefined); form.setValue('location', '') }
  return (
    <FormSection title="Where and under what conditions?" description="Site and environmental context for the event.">
      {!facilitiesAvailable && <Alert tone="warning">Facility selection is unavailable until the database migration is applied. Enter the area manually.</Alert>}
      <FormGrid>
        <Field label="Select location" htmlFor="incident-location-type" required error={form.formState.errors.locationType?.message}>
          <select id="incident-location-type" {...form.register('locationType', { setValueAs: (value: string) => value || undefined, onChange: () => {
            form.setValue('siteId', undefined)
            form.setValue('department', '')
            clearFacility()
          } })} className={selectClassName}>
            <option value="">Select location</option>
            <option value="site">Site</option>
            <option value="department">Department</option>
          </select>
        </Field>
        {locationType === 'site' && <Field label="Site" htmlFor="incident-site" required error={form.formState.errors.siteId?.message}>
          <select id="incident-site" {...form.register('siteId', { setValueAs: (value: string) => value || undefined, onChange: clearFacility })} className={selectClassName}>
            <option value="">{configuredSites.length ? 'Select site' : 'No sites configured'}</option>
            {configuredSites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
          </select>
        </Field>}
        {locationType === 'department' && <Field label="Department" htmlFor="incident-department" required error={form.formState.errors.department?.message}>
          <select id="incident-department" {...form.register('department', { onChange: clearFacility })} className={selectClassName}>
            <option value="">Select department</option>
            {departments.map((item) => <option value={item.name} key={item.id}>{item.name}</option>)}
          </select>
        </Field>}
        {locationType && (facilitiesAvailable ? <Field label="Facility / area" htmlFor="incident-facility" required={parentFacilities.length > 0} error={form.formState.errors.facilityId?.message}>
          <select id="incident-facility" {...form.register('facilityId', {
            setValueAs: (value: string) => value || undefined,
            onChange: (event) => form.setValue('location', parentFacilities.find((facility) => facility.id === event.target.value)?.name || ''),
          })} className={selectClassName} disabled={(!siteId && !departmentId) || (!parentFacilities.length && !facilityId)}>
            <option value="">{(siteId || departmentId) && !parentFacilities.length ? 'No facilities configured; contact an administrator' : 'Select facility / area'}</option>
            {facilityId && !parentFacilities.some((facility) => facility.id === facilityId) && <option value={facilityId}>Previously selected facility is unavailable</option>}
            {parentFacilities.map((facility) => <option value={facility.id} key={facility.id}>{facility.name}</option>)}
          </select>
        </Field> : <Field label="Facility / area" htmlFor="incident-location" error={form.formState.errors.location?.message}>
          <Input id="incident-location" {...form.register('location')} placeholder="Area, unit, or precise location" />
        </Field>)}
        <Field label="Weather conditions" htmlFor="incident-weather" required error={form.formState.errors.weatherConditions?.message}>
          <select id="incident-weather" {...form.register('weatherConditions')} className={selectClassName}>
            <option value="">Select weather</option>
            {weatherOptions.map((option) => <option value={option} key={option}>{option}</option>)}
            {weather && !weatherOptions.includes(weather) && <option value={weather}>{weather} (previously saved)</option>}
          </select>
        </Field>
        <Field label="Shift" htmlFor="incident-shift" required error={form.formState.errors.shift?.message}>
          <select id="incident-shift" {...form.register('shift')} className={selectClassName}>
            <option value="">Select shift</option>
            {shifts.map((shift) => <option value={shift} key={shift}>{shift}</option>)}
          </select>
        </Field>
      </FormGrid>
    </FormSection>
  )
}
