import { useState } from 'react'
import { CircleAlert, KeyRound, Link2, Link2Off } from 'lucide-react'
import { isSupportedEngine } from '../../../shared/engines/contracts'
import { bindConnectionToEngine, releaseEngineBinding } from '../../../shared/engines/editing'
import {
  bindingFor,
  bindingIssues,
  defaultRoute,
  grantCoversRoute,
} from '../../../shared/engines/provider'
import { adapterVersionFor } from '../../../shared/engines/provider'
import type { EngineWorkspace } from '../../../shared/engines/workspace'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { EvidenceBadge } from './EvidenceBadge'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader } from './ui/card'

/**
 * Which connections each installed CLI may be handed.
 *
 * Connections are managed once for the workspace; this is where a connection becomes usable by
 * one CLI. Nothing else grants it — not protocol compatibility, not a complete requirements
 * checklist, and not another CLI already using the same provider.
 */
export function EngineGrants({
  workspace,
  busy,
  onSave,
}: {
  workspace: EngineWorkspace
  busy: boolean
  onSave: (workspace: EngineWorkspace) => Promise<void>
}) {
  const { t, number } = useI18n()
  const [error, setError] = useState<unknown>(null)
  const installations = workspace.installations.filter((item) => isSupportedEngine(item.kind))
  if (!installations.length) return null

  async function act(next: EngineWorkspace) {
    setError(null)
    try {
      await onSave(next)
    } catch (failure) {
      setError(failure)
    }
  }

  return (
    <section className="mb-6 grid gap-4">
      <div className="grid gap-1">
        <h2 className="flex items-center gap-2">
          <KeyRound size={16} aria-hidden="true" />
          {t('grants.title')}
        </h2>
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
          {t('grants.description')}
        </p>
      </div>
      {error != null && (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{formatError(error)}</AlertDescription>
        </Alert>
      )}
      {workspace.connections.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          {t('grants.noConnections')}
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {installations.map((installation) => {
            const kind = installation.kind
            if (!isSupportedEngine(kind)) return null
            const granted = workspace.engineBindings.filter(
              (binding) => binding.installationId === installation.id,
            )
            return (
              <Card asChild key={installation.id}>
                <article>
                  <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm">
                      {installation.name} · {kind}
                    </h3>
                    <Badge variant="muted">
                      {t('grants.engines', {
                        count: number(granted.length),
                        total: number(workspace.connections.length),
                      })}
                    </Badge>
                  </CardHeader>
                  <CardContent className="grid gap-2">
                    {workspace.connections.map((connection) => {
                      const binding = bindingFor(workspace, installation.id, connection.id)
                      const route = defaultRoute(connection, kind)
                      const issues = bindingIssues(workspace, {
                        id: 'draft',
                        installationId: installation.id,
                        connectionId: connection.id,
                        route,
                      }).filter((issue) => issue !== 'duplicate')
                      const blocked = issues.length > 0
                      return (
                        <div
                          key={connection.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                        >
                          <div className="grid min-w-0 gap-0.5">
                            <span className="truncate text-xs font-medium">{connection.name}</span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {connection.provider?.vendor ?? t('provider.unknown')} ·{' '}
                              {binding
                                ? t('grants.route') + ': ' + binding.route
                                : (connection.protocol ?? t('config.choose'))}
                            </span>
                            {binding && binding.adapterVersion !== adapterVersionFor(kind) && (
                              <span className="truncate text-[11px] text-warning">
                                {t('grants.adapterChanged', { adapter: binding.adapterVersion })}
                              </span>
                            )}
                            {binding && !grantCoversRoute(binding, connection) && (
                              <span className="truncate text-[11px] text-warning">
                                {t('grants.routeStale', {
                                  route: binding.route,
                                  protocol: connection.protocol ?? '',
                                })}
                              </span>
                            )}
                            {!binding && blocked && (
                              <span className="truncate text-[11px] text-muted-foreground">
                                {issues.includes('route-mismatch')
                                  ? t('grants.routeMismatch', {
                                      protocol: connection.protocol ?? '',
                                    })
                                  : t('grants.unsupported')}
                              </span>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {binding && (
                              <EvidenceBadge
                                workspace={workspace}
                                subject={{ kind: 'binding', id: binding.id }}
                              />
                            )}
                            {binding && !grantCoversRoute(binding, connection) && (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    bindConnectionToEngine(workspace, {
                                      id: binding.id,
                                      installationId: installation.id,
                                      connectionId: connection.id,
                                      route,
                                      nativeProviderId: binding.nativeProviderId,
                                    }),
                                  )
                                }
                              >
                                {t('grants.regrant')}
                              </Button>
                            )}
                            {binding ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                aria-label={t('grants.withdrawNamed', {
                                  connection: connection.name,
                                  engine: installation.name,
                                })}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      t('grants.confirmWithdraw', {
                                        connection: connection.name,
                                        engine: installation.name,
                                      }),
                                    )
                                  )
                                    void act(releaseEngineBinding(workspace, binding.id))
                                }}
                              >
                                <Link2Off aria-hidden="true" />
                                {t('grants.withdraw')}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                disabled={busy || blocked}
                                aria-label={t('grants.makeNamed', {
                                  connection: connection.name,
                                  engine: installation.name,
                                })}
                                onClick={() =>
                                  void act(
                                    bindConnectionToEngine(workspace, {
                                      id: crypto.randomUUID(),
                                      installationId: installation.id,
                                      connectionId: connection.id,
                                      route,
                                    }),
                                  )
                                }
                              >
                                <Link2 aria-hidden="true" />
                                {t('grants.make')}
                              </Button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </CardContent>
                </article>
              </Card>
            )
          })}
        </div>
      )}
    </section>
  )
}
