import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

/**
 * Tab controls with the shadcn appearance over plain ARIA markup. Panels stay rendered by the
 * owning component, so existing keyboard behavior and accessible names are unchanged.
 */
export function TabList({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="tablist"
      data-slot="tab-list"
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function TabTrigger({
  className,
  active,
  ...props
}: ComponentProps<'button'> & { active: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      data-slot="tab-trigger"
      aria-selected={active}
      data-state={active ? 'active' : 'inactive'}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45 disabled:pointer-events-none disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4",
        active ? 'bg-card text-foreground shadow-xs' : 'hover:text-foreground',
        className,
      )}
      {...props}
    />
  )
}
