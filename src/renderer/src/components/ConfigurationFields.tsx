import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CredentialMetadata } from '../../../shared/credentials'
import type { SecretReference } from '../../../shared/engines/schema'
import { useI18n } from '../i18n'
import { Input, Select, Textarea } from './ui/input'

export function TextField({
  label,
  value,
  onChange,
  rows,
  ...props
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows?: number
  placeholder?: string
  maxLength?: number
  readOnly?: boolean
}) {
  return (
    <label className="field">
      {label}
      {rows ? (
        <Textarea
          {...props}
          aria-label={label}
          rows={rows}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          {...props}
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 'any',
}: {
  label: string
  value: number | undefined
  onChange: (value: number | undefined) => void
  min?: number
  max?: number
  step?: number | 'any'
}) {
  return (
    <label className="field">
      {label}
      <Input
        aria-label={label}
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        onChange={(event) =>
          onChange(event.target.value === '' ? undefined : event.target.valueAsNumber)
        }
      />
    </label>
  )
}

export function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label className="field">
      {label}
      <Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </Select>
    </label>
  )
}

export function JsonField<T>({
  label,
  value,
  onChange,
  array = false,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  array?: boolean
}) {
  const { t } = useI18n()
  const serialized = JSON.stringify(value, null, 2)
  const [source, setSource] = useState(serialized)
  const ownValue = useRef(serialized)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (serialized !== ownValue.current) {
      ownValue.current = serialized
      setSource(serialized)
      input.current?.setCustomValidity('')
    }
  }, [serialized])
  return (
    <label className="field">
      {label}
      <Textarea
        aria-label={label}
        ref={input}
        className="code-input font-mono"
        rows={3}
        value={source}
        onChange={(event) => {
          setSource(event.target.value)
          try {
            const parsed: unknown = JSON.parse(event.target.value)
            if (
              array
                ? !Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')
                : typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
            )
              throw new Error('Invalid shape')
            input.current?.setCustomValidity('')
            ownValue.current = JSON.stringify(parsed, null, 2)
            onChange(parsed as T)
          } catch {
            input.current?.setCustomValidity(
              t(array ? 'config.jsonArrayInvalid' : 'config.jsonInvalid'),
            )
          }
        }}
      />
    </label>
  )
}

export function ArgumentField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string[]
  onChange: (value: string[]) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <TextField
        label={label}
        rows={3}
        value={value.join('\n')}
        onChange={(text) => onChange(text ? text.split('\n') : [])}
      />
      <p className="hint">{t('config.argsHint')}</p>
      <details>
        <summary>{t('config.advanced')}</summary>
        <JsonField label={t('config.argsJson')} value={value} onChange={onChange} array />
      </details>
    </>
  )
}

export function SecretField({
  value,
  onChange,
  credentials,
}: {
  value: SecretReference | null
  onChange: (value: SecretReference | null) => void
  credentials: CredentialMetadata[]
}) {
  const { t } = useI18n()
  return (
    <div className="secret-reference">
      <SelectField
        label={t('config.secret')}
        value={value?.kind ?? ''}
        onChange={(kind) =>
          onChange(
            kind === 'environment'
              ? { kind, name: '' }
              : kind === 'credential'
                ? { kind, id: credentials[0]?.id ?? '' }
                : null,
          )
        }
      >
        <option value="">{t('config.secret.none')}</option>
        <option value="environment">{t('config.secret.environment')}</option>
        <option value="credential">{t('config.secret.credential')}</option>
      </SelectField>
      {value?.kind === 'environment' && (
        <TextField
          label={t('config.secret.name')}
          value={value.name}
          onChange={(name) => onChange({ kind: 'environment', name })}
          placeholder="MY_API_KEY"
        />
      )}
      {value?.kind === 'credential' && (
        <SelectField
          label={t('config.secret.saved')}
          value={value.id}
          onChange={(id) => onChange({ kind: 'credential', id })}
        >
          <option value="">{t('config.choose')}</option>
          {value.id && !credentials.some((item) => item.id === value.id) && (
            <option value={value.id}>{t('config.secret.missing', { id: value.id })}</option>
          )}
          {credentials.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </SelectField>
      )}
      <p className="hint">{t('config.secret.hint')}</p>
    </div>
  )
}
