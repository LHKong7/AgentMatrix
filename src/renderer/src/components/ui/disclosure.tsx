import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

/**
 * shadcn-styled `<details>`. The native element keeps the open state, keyboard behavior and the
 * `summary` hooks the desktop tests use, so no JavaScript collapse is needed.
 */
export function Disclosure({ className, ...props }: ComponentProps<'details'>) {
  return (
    <details
      data-slot="disclosure"
      className={cn(
        'group rounded-lg border border-border bg-card text-card-foreground [&[open]>summary]:border-b [&[open]>summary]:border-border',
        className,
      )}
      {...props}
    />
  )
}

export function DisclosureSummary({ className, ...props }: ComponentProps<'summary'>) {
  return (
    <summary
      data-slot="disclosure-summary"
      className={cn(
        'cursor-pointer list-none px-3 py-2 text-xs font-medium outline-none select-none marker:content-none focus-visible:ring-[3px] focus-visible:ring-ring/45 [&::-webkit-details-marker]:hidden',
        className,
      )}
      {...props}
    />
  )
}

export function DisclosureContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="disclosure-content" className={cn('px-3 py-3 text-xs', className)} {...props} />
  )
}
