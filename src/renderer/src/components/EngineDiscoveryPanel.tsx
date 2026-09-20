import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  CircleAlert,
  CircleSlash,
  Download,
  LoaderCircle,
  RefreshCw,
  Terminal,
} from 'lucide-react'
import type { SupportedEngine } from '../../../shared/engines/contracts'
import {
  preferredCandidate,
  type EngineCandidate,
  type EngineDiscovery,
  type EngineDiscoveryEntry,
} from '../../../shared/engines/discovery'
import { upsertConfiguration } from '../../../shared/engines/editing'
import type { EngineWorkspace } from '../../../shared/engines/workspace'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Skeleton } from './ui/skeleton'

const engineNames: Record<SupportedEngine, string> = {
  opencode: 'OpenCode',
  pi: 'Pi',
  'deepseek-harness': 'DeepSeek Harness',
}
const statusBadges = {
  ready: { variant: 'success', Icon: CheckCircle2 },
  'version-mismatch': { variant: 'warning', Icon: CircleAlert },
  missing: { variant: 'muted', Icon: CircleSlash },
} as const

export function EngineDiscoveryPanel({
  workspace,
  desktop,
  platform,
  busy,
  onSave,
  onWorkspace,
}: {
  workspace: EngineWorkspace
  desktop: boolean
  platform?: string
  busy: boolean
  onSave: (workspace: EngineWorkspace) => Promise<void>
  onWorkspace: (workspace: EngineWorkspace) => void
}) {
  const { t, locale } = useI18n()
  const [report, setReport] = useState<EngineDiscovery | null>(null)
  const [checking, setChecking] = useState(false)
  const [working, setWorking] = useState<SupportedEngine | null>(null)
  const [error, setError] = useState<unknown>(null)
  const locked = useRef(false)

  const check = useCallback(async () => {
    if (locked.current) return
    locked.current = true
    setChecking(true)
    setError(null)
    try {
      setReport(await api.discoverEngines())
    } catch (failure) {
      setError(failure)
    } finally {
      locked.current = false
      setChecking(false)
    }
  }, [])
  // The automatic check runs once when this page opens; later checks are explicit.
  useEffect(() => {
    void check()
  }, [check])

  async function act(kind: SupportedEngine, operation: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setWorking(kind)
    setError(null)
    try {
      await operation()
    } catch (failure) {
      setError(failure)
    } finally {
      locked.current = false
      setWorking(null)
    }
  }

  /** Saves the detected path as an installation, then runs the existing version check. */
  async function adopt(kind: SupportedEngine, candidate: EngineCandidate) {
    let installationId = candidate.installationId
    if (!installationId) {
      installationId = crypto.randomUUID()
      await onSave(
        upsertConfiguration(workspace, 'installations', {
          id: installationId,
          name: t('discovery.savedName', { engine: engineNames[kind] }),
          kind,
          executable: candidate.executable,
          prefixArgs: [],
          platform: platform === 'linux' ? 'linux' : platform === 'win32' ? 'win32' : 'darwin',
          version: null,
          modes: [],
          probedAt: null,
        }),
      )
    }
    onWorkspace(await api.probeEngine({ installationId }))
    setReport(await api.discoverEngines())
  }

  const entries = report?.engines ?? []
  return (
    <section
      className="mb-6 rounded-xl border border-border bg-card p-5 shadow-xs"
      aria-label={t('discovery.title')}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Terminal className="size-4 text-primary" aria-hidden="true" />
            {t('discovery.title')}
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {t('discovery.description')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void check()}
          disabled={checking || busy}
        >
          {checking ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          {t('discovery.check')}
        </Button>
      </div>
      {error != null && (
        <Alert variant="destructive" className="mt-4" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{formatError(error, locale)}</AlertDescription>
        </Alert>
      )}
      {!desktop && (
        <p className="mt-4 text-xs text-muted-foreground">{t('discovery.unsupported')}</p>
      )}
      {report && desktop && !report.supported && (
        <p className="mt-4 text-xs text-muted-foreground">{t('discovery.unsupported')}</p>
      )}
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {!report && checking
          ? [0, 1, 2].map((index) => <Skeleton key={index} className="h-44 w-full" />)
          : entries.map((entry) => (
              <EngineCard
                key={entry.kind}
                entry={entry}
                downloadable={Boolean(report?.supported && report.downloadAvailable && desktop)}
                busy={busy || checking || working !== null}
                working={working === entry.kind}
                nameOf={(id) => workspace.installations.find((item) => item.id === id)?.name ?? id}
                onAdopt={(candidate) => void act(entry.kind, () => adopt(entry.kind, candidate))}
                onDownload={() =>
                  void act(entry.kind, async () => {
                    const result = await api.downloadEngine({ kind: entry.kind })
                    setReport(result.discovery)
                    await adopt(entry.kind, result.candidate)
                  })
                }
              />
            ))}
      </div>
      {report && report.supported && !report.downloadAvailable && (
        <p className="mt-4 text-xs text-warning">{t('discovery.unavailable')}</p>
      )}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        {t('discovery.boundary')}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {report
            ? t('discovery.checkedAt', { time: new Date(report.checkedAt).toLocaleString(locale) })
            : t('discovery.never')}
        </span>
        {report?.managedRoot && (
          <span className="font-mono break-all">
            {t('discovery.managedRoot')}: {report.managedRoot}
          </span>
        )}
      </p>
    </section>
  )
}

function EngineCard({
  entry,
  downloadable,
  busy,
  working,
  nameOf,
  onAdopt,
  onDownload,
}: {
  entry: EngineDiscoveryEntry
  downloadable: boolean
  busy: boolean
  working: boolean
  nameOf: (installationId: string) => string
  onAdopt: (candidate: EngineCandidate) => void
  onDownload: () => void
}) {
  const { t } = useI18n()
  const { variant, Icon } = statusBadges[entry.status]
  const best = preferredCandidate(entry)
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>{engineNames[entry.kind]}</span>
          <Badge variant={variant}>
            <Icon aria-hidden="true" />
            {t(`discovery.status.${entry.status}`)}
          </Badge>
        </CardTitle>
        <CardDescription>
          {t('discovery.expected', { version: entry.expectedVersion })}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {entry.candidates.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('discovery.empty')}</p>
        )}
        {entry.candidates.map((candidate) => (
          <div key={candidate.executable} className="grid gap-1.5 rounded-lg bg-muted/60 p-3">
            <code className="text-[11px] break-all text-foreground">{candidate.executable}</code>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant={candidate.matchesContract ? 'success' : 'outline'}>
                {candidate.version ?? t('discovery.versionUnknown')}
              </Badge>
              <span>{t(`discovery.origin.${candidate.origin}`)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={candidate.matchesContract ? 'default' : 'outline'}
                disabled={busy}
                onClick={() => onAdopt(candidate)}
              >
                {working && <LoaderCircle className="animate-spin" aria-hidden="true" />}
                {t('discovery.use')}
              </Button>
              {candidate.installationId && (
                <span className="text-[11px] text-muted-foreground">
                  {t('discovery.linked', { name: nameOf(candidate.installationId) })}
                </span>
              )}
            </div>
          </div>
        ))}
        {entry.status !== 'ready' && (
          <div className="grid gap-2">
            {!best?.matchesContract && entry.candidates.length > 0 && (
              <p className="text-[11px] leading-relaxed text-warning">
                {t('discovery.mismatchHint')}
              </p>
            )}
            <Button
              size="sm"
              disabled={busy || !downloadable}
              onClick={onDownload}
              title={t('discovery.downloadHint', {
                package: entry.package,
                version: entry.expectedVersion,
              })}
            >
              {working ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Download aria-hidden="true" />
              )}
              {working
                ? t('discovery.downloading', { package: entry.package })
                : t('discovery.download', { version: entry.expectedVersion })}
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t('discovery.downloadHint', {
                package: entry.package,
                version: entry.expectedVersion,
              })}
            </p>
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">{t('discovery.manual')}</summary>
              <code className="mt-1 block break-all select-all">{entry.command}</code>
            </details>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
