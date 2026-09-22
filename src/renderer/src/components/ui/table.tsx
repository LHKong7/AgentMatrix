import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

/**
 * Data table surface. Plain `thead`/`tr`/`th`/`td` children are styled from here, so a report
 * table only needs its own accessible label.
 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border">
      <table
        data-slot="table"
        className={cn(
          'w-full caption-bottom border-collapse text-left text-xs',
          '[&_tr]:border-b [&_tr]:border-border [&_tr]:align-top [&_tbody_tr:last-child]:border-0',
          '[&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium',
          '[&_td]:px-3 [&_td]:py-2 [&_thead_th]:text-muted-foreground [&_tbody_th]:font-normal',
          className,
        )}
        {...props}
      />
    </div>
  )
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('[&_tr]:border-b [&_tr]:border-border', className)}
      {...props}
    />
  )
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  )
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('border-b border-border align-top', className)}
      {...props}
    />
  )
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn('px-3 py-2 text-left font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('px-3 py-2', className)} {...props} />
}
