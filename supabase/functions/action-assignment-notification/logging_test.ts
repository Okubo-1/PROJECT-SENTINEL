import { logNotificationFailure } from './logging.ts'

Deno.test('notification failure logs contain only event and stage', () => {
  const original = console.error
  const messages: unknown[] = []
  console.error = (...args: unknown[]) => messages.push(...args)
  try {
    logNotificationFailure('action_assignment_notification_failed', 'delivery_complete')
    const data = JSON.parse(String(messages[0]))
    if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(['event', 'stage'])
      || data.event !== 'action_assignment_notification_failed' || data.stage !== 'delivery_complete') {
      throw new Error('Notification log contains unexpected fields')
    }
  } finally {
    console.error = original
  }
})
