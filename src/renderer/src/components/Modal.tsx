import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useI18n } from '../i18n'
import { Button } from './ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  busy = false,
}: {
  title: string
  subtitle: string
  children: ReactNode
  onClose: () => void
  busy?: boolean
}) {
  const { t } = useI18n()
  return (
    <Dialog aria-labelledby="modal-title" dismissible={!busy} onDismiss={onClose}>
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle id="modal-title">{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.close')}
          onClick={onClose}
          disabled={busy}
        >
          <X aria-hidden="true" />
        </Button>
      </DialogHeader>
      {children}
    </Dialog>
  )
}
