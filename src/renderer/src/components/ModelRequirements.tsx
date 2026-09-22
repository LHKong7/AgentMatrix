import { Check, CircleAlert, CircleDashed, Minus } from 'lucide-react'
import type { SupportedEngine } from '../../../shared/engines/contracts'
import {
  describeModelRequirements,
  engineModelRequirements,
  type RequirementCheck,
  type RequirementStatus,
} from '../../../shared/engines/model-requirements'
import type { ModelConnection, ModelProfile } from '../../../shared/engines/schema'
import type { MessageKey } from '../../../shared/i18n'
import { useI18n } from '../i18n'
import { Badge } from './ui/badge'
import { Select } from './ui/input'

export const engineNames: Record<SupportedEngine, string> = {
  opencode: 'OpenCode',
  pi: 'Pi',
  'deepseek-harness': 'DeepSeek Harness',
}
const supportedEngines = Object.keys(engineModelRequirements) as SupportedEngine[]
const marks: Record<RequirementStatus, { Icon: typeof Check; tone: string }> = {
  ok: { Icon: Check, tone: 'text-success' },
  blocked: { Icon: CircleAlert, tone: 'text-destructive' },
  unset: { Icon: CircleDashed, tone: 'text-warning' },
  'not-applicable': { Icon: Minus, tone: 'text-muted-foreground' },
}

/** Picks which CLI the surrounding editor describes. The choice is not part of the saved data. */
export function EngineTargetSelect({
  value,
  onChange,
  label,
}: {
  value: SupportedEngine | null
  onChange: (kind: SupportedEngine | null) => void
  label?: string
}) {
  const { t } = useI18n()
  const name = label ?? t('requirements.engine')
  return (
    <label className="mb-5 grid gap-2 text-xs font-medium">
      {name}
      <Select
        aria-label={name}
        value={value ?? ''}
        onChange={(event) => onChange((event.target.value || null) as SupportedEngine | null)}
      >
        <option value="">{t('requirements.chooseEngine')}</option>
        {supportedEngines.map((kind) => (
          <option key={kind} value={kind}>
            {engineNames[kind]} {engineModelRequirements[kind].engineVersion}
          </option>
        ))}
      </Select>
    </label>
  )
}

export function ModelRequirements({
  kind,
  connection,
  model,
}: {
  kind: SupportedEngine | null
  connection?: ModelConnection | null
  model?: ModelProfile | null
}) {
  const { t, number } = useI18n()
  if (!kind)
    return (
      <section className="grid gap-2 rounded-lg border border-border p-3" aria-live="polite">
        <h3>{t('requirements.title')}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('requirements.none')}</p>
      </section>
    )
  const checks = describeModelRequirements(kind, { connection, model })
  const blocked = checks.filter((check) => check.status === 'blocked')
  const unset = checks.filter((check) => check.status === 'unset')
  return (
    <section
      className="grid gap-2 rounded-lg border border-border p-3"
      data-testid="model-requirements"
      data-engine={kind}
      data-blocked={blocked.length}
      data-unset={unset.length}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>
          {t('requirements.title')} · {engineNames[kind]}
        </h3>
        <Badge variant={blocked.length ? 'destructive' : unset.length ? 'warning' : 'success'}>
          {blocked.length
            ? t('requirements.blockedCount', { count: number(blocked.length) })
            : unset.length
              ? t('requirements.incomplete', { count: number(unset.length) })
              : t('requirements.ready')}
        </Badge>
      </div>
      <ul className="grid list-none gap-1.5 pl-0">
        {checks.map((check) => (
          <RequirementRow key={check.id} check={check} />
        ))}
      </ul>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('requirements.boundary')}</p>
    </section>
  )
}

function RequirementRow({ check }: { check: RequirementCheck }) {
  const { t } = useI18n()
  const { Icon, tone } = marks[check.status]
  return (
    <li className="flex items-start gap-2" data-requirement={check.id} data-status={check.status}>
      <Icon className={`mt-0.5 size-3.5 ${tone}`} aria-hidden="true" />
      <span className="grid min-w-0 gap-0.5">
        <strong className="text-[11px] font-medium">
          {t(`requirements.label.${check.id}` as MessageKey)}
        </strong>
        <small>
          {t(`requirements.${check.id}.${check.status}` as MessageKey, {
            detail: check.detail ?? '',
          })}
        </small>
      </span>
    </li>
  )
}
