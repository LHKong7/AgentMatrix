import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * shadcn dialog surface over the platform `<dialog>` element. The native element keeps the
 * top-layer stacking, focus trap, backdrop and Escape handling that the desktop tests rely on,
 * while the styling comes from the same tokens as every other primitive.
 */
export function Dialog({
  className,
  onDismiss,
  dismissible = true,
  children,
  ...props
}: Omit<ComponentProps<'dialog'>, 'onCancel'> & {
  onDismiss: () => void
  dismissible?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      data-slot="dialog"
      className={cn(
        'fixed inset-0 m-auto max-h-[calc(100vh-4rem)] w-[min(45rem,calc(100vw-3rem))] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-lg',
        'backdrop:bg-overlay backdrop:backdrop-blur-sm',
        className,
      )}
      onCancel={(event) => {
        event.preventDefault()
        if (dismissible) onDismiss()
      }}
      {...props}
    >
      <div className="flex max-h-[calc(100vh-4rem)] flex-col">{children}</div>
    </dialog>
  )
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        'flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-5',
        className,
      )}
      {...props}
    />
  )
}

export function DialogTitle({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="dialog-title"
      className={cn('text-base leading-tight font-semibold', className)}
      {...props}
    />
  )
}

export function DialogDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="dialog-description"
      className={cn('mt-1.5 text-xs leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  )
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-5', className)}
      {...props}
    />
  )
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-6 py-4',
        className,
      )}
      {...props}
    />
  )
}
