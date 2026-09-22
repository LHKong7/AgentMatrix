import * as SelectPrimitive from '@radix-ui/react-select'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { cn } from '../../lib/utils'

export const SelectRoot = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group
export const SelectValue = SelectPrimitive.Value

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm whitespace-nowrap text-foreground shadow-xs transition-[color,box-shadow] outline-none data-[placeholder]:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  container,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content> & { container?: HTMLElement | null }) {
  return (
    // A modal <dialog> owns the top layer, so the list has to be portalled inside it.
    <SelectPrimitive.Portal container={container ?? undefined}>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          'relative z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1 w-full min-w-[var(--radix-select-trigger-width)]',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-1">
          <ChevronUpIcon className="size-4" aria-hidden="true" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex cursor-default items-center justify-center py-1">
          <ChevronDownIcon className="size-4" aria-hidden="true" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      // Acceptance tests pick an option by the value it stores, as a native select allows.
      data-value={props.value}
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-xs outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  )
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-2 py-1.5 text-[11px] text-muted-foreground', className)}
      {...props}
    />
  )
}

/** Radix reserves the empty string for "no value", so an empty option needs a stand-in. */
const emptyValue = '__none__'
interface OptionDescriptor {
  value: string
  label: ReactNode
  disabled?: boolean
  lang?: string
}

function collectOptions(children: ReactNode, into: OptionDescriptor[] = []): OptionDescriptor[] {
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue
    if (child.type === 'option') {
      const props = child.props as {
        value?: string | number
        children?: ReactNode
        disabled?: boolean
        lang?: string
      }
      const value = props.value === undefined ? '' : String(props.value)
      into.push({
        value,
        label: props.children ?? value,
        disabled: props.disabled,
        lang: props.lang,
      })
    } else {
      const props = child.props as { children?: ReactNode }
      if (props.children) collectOptions(props.children, into)
    }
  }
  return into
}

/**
 * shadcn select over Radix, driven by `<option>` children and a native-shaped change event so
 * every editor keeps one field API. The listbox itself is the Radix popover, not the platform menu.
 */
export function Select({
  value,
  onChange,
  children,
  className,
  disabled,
  name,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: {
  value: string
  onChange?: (event: { target: { value: string } }) => void
  children: ReactNode
  className?: string
  disabled?: boolean
  name?: string
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}) {
  const options = collectOptions(children)
  const selected = options.find((option) => option.value === value)
  const trigger = useRef<HTMLButtonElement>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setContainer(trigger.current?.closest('dialog') ?? null)
  }, [])
  return (
    <SelectPrimitive.Root
      value={value === '' ? emptyValue : value}
      disabled={disabled}
      name={name}
      onValueChange={(next) => onChange?.({ target: { value: next === emptyValue ? '' : next } })}
    >
      <SelectTrigger
        ref={trigger}
        id={id}
        className={className}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
      >
        {selected ? <span lang={selected.lang}>{selected.label}</span> : <SelectValue />}
      </SelectTrigger>
      <SelectContent container={container}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value === '' ? emptyValue : option.value}
            data-value={option.value}
            disabled={option.disabled}
          >
            <span lang={option.lang}>{option.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </SelectPrimitive.Root>
  )
}
