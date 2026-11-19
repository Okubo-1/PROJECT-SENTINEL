export type NotificationFailureEvent =
  | 'action_assignment_notification_failed'
  | 'action_assignment_notification_failure_status_update_failed'
  | 'action_assignment_notification_failure_record_failed'

export function logNotificationFailure(event: NotificationFailureEvent, stage: string) {
  console.error(JSON.stringify({ event, stage }))
}
