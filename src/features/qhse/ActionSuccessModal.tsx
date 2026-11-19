import { Dialog, Button, Icon } from '../../components/ui'

export function ActionSuccessModal({
  open,
  onClose,
  onViewInRegister,
}: {
  open: boolean
  onClose: () => void
  onViewInRegister: () => void
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Action Successfully Created"
      closeOnBackdrop={false}
      closeOnEscape={false}
      className="max-w-sm"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-brand/10 p-2">
            <Icon name="success" size={24} className="text-brand" />
          </div>
          <div className="flex-1">
            <p className="text-sm text-muted">
              The action has been successfully created, logged in the Actions Register, and delivered to the assigned responsible person.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Button onClick={onViewInRegister} className="w-full">
            View in Actions Register
          </Button>
          <Button variant="outline" onClick={onClose} className="w-full">
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
