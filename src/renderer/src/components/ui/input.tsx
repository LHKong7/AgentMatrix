import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

export const fieldClassName =
  'flex w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-destructive/25'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(fieldClassName, 'h-9', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClassName, 'field-sizing-content min-h-16 resize-y', className)}
      {...props}
    />
  )
}

/**
 * Native select with the shadcn field styling. The desktop acceptance tests drive these
 * controls with real `selectOption` calls, so the option list must stay a native listbox.
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(fieldClassName, 'h-9 cursor-pointer appearance-none pr-8', className)}
      {...props}
    />
  )
}
