import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Alert, Button, Field, Input } from '../../components/ui'
import { recordActivity } from '../../lib/activity'
import { notifyCompanySettingsUpdated } from '../../lib/companySettingsSync'
import { SettingsSectionShell } from './SettingsSectionShell'

export function WeatherSection({ client, organizationId, userId }: {
  client: SupabaseClient
  organizationId: string
  userId: string
}) {
  const [values, setValues] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    void client.from('company_settings').select('weather_conditions').eq('organization_id', organizationId).single().then(({ data, error: loadError }) => {
      if (!active) return
      if (loadError || !Array.isArray(data?.weather_conditions) || !data.weather_conditions.every((item: unknown) => typeof item === 'string')) {
        setError(loadError?.message || 'Weather settings are invalid.')
        return
      }
      setValues(data.weather_conditions)
    })
    return () => { active = false }
  }, [client, organizationId])

  const save = async (next: string[]) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { error: saveError } = await client.from('company_settings').update({ weather_conditions: next }).eq('organization_id', organizationId).select('organization_id').single()
      if (saveError) throw new Error(saveError.message)
      setValues(next)
      setDraft('')
      notifyCompanySettingsUpdated(organizationId)
      setMessage('Weather conditions saved.')
      await recordActivity(organizationId, userId, 'Weather conditions changed')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save weather conditions.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSectionShell title="Weather conditions" description="Configure the weather choices available for incident reports.">
      {error && <Alert tone="danger">{error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}
      {values.length === 0 && <p className="text-sm text-muted">No weather conditions configured.</p>}
      {values.map((value) => (
        <div key={value} className="flex items-center justify-between gap-3 rounded-xl border border-line px-4 py-2">
          <span className="text-sm text-foreground">{value}</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void save(values.filter((item) => item !== value))}>Remove</Button>
        </div>
      ))}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault()
        const name = draft.trim()
        if (!name || values.some((value) => value.toLowerCase() === name.toLowerCase())) {
          setError('Enter a unique weather condition.')
          return
        }
        void save([...values, name])
      }}>
        <Field label="Add weather condition" className="min-w-[220px] flex-1">
          <Input value={draft} maxLength={120} onChange={(event) => setDraft(event.target.value)} />
        </Field>
        <Button type="submit" loading={busy}>Add condition</Button>
      </form>
    </SettingsSectionShell>
  )
}
