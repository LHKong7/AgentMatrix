import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

/**
 * Native checkbox with the shadcn appearance. It stays an `<input type="checkbox">` because the
 * desktop acceptance tests toggle it with Playwright's `check()`, which requires a real input.
 */
export function Checkbox({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        'size-4 shrink-0 cursor-pointer rounded-[4px] border border-input accent-primary outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}
