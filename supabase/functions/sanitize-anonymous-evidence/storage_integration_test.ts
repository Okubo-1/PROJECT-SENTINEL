import { createClient } from '@supabase/supabase-js'

Deno.test('authenticated Storage API access is denied while a server-issued URL works', async () => {
  const url = Deno.env.get('EVIDENCE_TEST_URL')
  const anonKey = Deno.env.get('EVIDENCE_TEST_ANON_KEY')
  const serviceKey = Deno.env.get('EVIDENCE_TEST_SERVICE_KEY')
  if (!url || !anonKey || !serviceKey) throw new Error('Explicit test credentials are required')
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const suffix = crypto.randomUUID()
  const email = `evidence-test-${suffix}@example.invalid`
  const password = `${crypto.randomUUID()}aA1!`
  const path = `${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`
  const rejectedPath = `${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`
  const bucket = 'anonymous-incident-evidence'
  let userId: string | undefined
  let uploaded = false
  let rejectedUploaded = false
  let failure: unknown
  let cleanupFailed = false
  try {
    const user = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (user.error || !user.data.user) throw new Error('Could not create temporary Storage test account')
    userId = user.data.user.id
    const login = await client.auth.signInWithPassword({ email, password })
    if (login.error) throw new Error('Could not authenticate temporary Storage test account')
    const unavailable = await client.functions.invoke('sanitize-anonymous-evidence', {
      body: { evidenceId: crypto.randomUUID() }, headers: { 'x-evidence-action': 'download' },
    })
    if (!unavailable.error || unavailable.response?.status !== 404) throw new Error('Deployed evidence endpoint did not reject an unavailable record')
    const storage = admin.storage.from(bucket)
    const write = await storage.upload(path, new Blob(['private-test']), { contentType: 'text/plain' })
    if (write.error) throw new Error('Service-role test upload failed')
    uploaded = true
    const direct = client.storage.from(bucket)
    const list = await direct.list(path.split('/')[0])
    if (!list.error && list.data?.length) throw new Error('Authenticated user could list private evidence')
    if (!(await direct.download(path)).error) throw new Error('Authenticated user could download private evidence directly')
    const forbiddenWrite = await direct.upload(rejectedPath, new Blob(['forbidden']))
    rejectedUploaded = !forbiddenWrite.error
    if (rejectedUploaded) throw new Error('Authenticated user could upload private evidence directly')
    if (!(await direct.update(path, new Blob(['modified']))).error) throw new Error('Authenticated user could update private evidence directly')
    await direct.remove([path])
    if (!(await direct.createSignedUrl(path, 60)).error) throw new Error('Authenticated user could sign a private evidence URL')
    const signed = await storage.createSignedUrl(path, 60)
    if (signed.error || !signed.data?.signedUrl) throw new Error('Service-role URL signing failed')
    const download = await fetch(signed.data.signedUrl)
    if (!download.ok || await download.text() !== 'private-test') throw new Error('Server-signed URL download failed')
  } catch (error) {
    failure = error
  } finally {
    const paths = [uploaded ? path : null, rejectedUploaded ? rejectedPath : null].filter((value): value is string => value !== null)
    if (paths.length && (await admin.storage.from(bucket).remove(paths)).error) cleanupFailed = true
    if (userId) {
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) cleanupFailed = true
    }
  }
  if (cleanupFailed) throw new Error('Failed to remove temporary Storage test data')
  if (failure) throw failure
})
