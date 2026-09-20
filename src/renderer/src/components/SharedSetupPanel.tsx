import { useEffect, useState } from 'react'
import { Boxes, CircleAlert, Layers3, Save, Server, SlidersHorizontal } from 'lucide-react'
import { setSharedSetupParticipation, updateSharedSetup } from '../../../shared/engines/editing'
import type { EngineWorkspace, SharedSetup } from '../../../shared/engines/workspace'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { AssetBindings } from './AssetBindings'
import { ResourcePicker } from './ResourcePicker'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'
import { Checkbox } from './ui/checkbox'

export function SharedSetupPanel({
  workspace,
  busy,
  onSave,
}: {
  workspace: EngineWorkspace
  busy: boolean
  onSave: (workspace: EngineWorkspace) => Promise<void>
}) {
  const { t, locale, number } = useI18n()
  const [draft, setDraft] = useState<SharedSetup>(workspace.sharedSetup)
  const [error, setError] = useState<unknown>(null)
  // A save elsewhere replaces the saved setup; keep editing from the stored revision.
  useEffect(() => setDraft(workspace.sharedSetup), [workspace.sharedSetup])
  const patch = (changes: Partial<SharedSetup>) =>
    setDraft((current) => ({ ...current, ...changes }))
  const participants = workspace.agents.filter(
    (agent) => !draft.excludedAgentIds.includes(agent.id),
  )

  async function act(next: EngineWorkspace) {
    setError(null)
    try {
      await onSave(next)
    } catch (failure) {
      setError(failure)
    }
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
            <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />
            {t('sharedSetup.eyebrow')}
          </div>
          <h1>{t('nav.sharedSetup')}</h1>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {t('sharedSetup.description')}
          </p>
        </div>
        <Button
          disabled={busy}
          onClick={() => void act(updateSharedSetup(workspace, draft))}
          data-testid="save-shared-setup"
        >
          <Save aria-hidden="true" />
          {t(busy ? 'common.saving' : 'sharedSetup.save')}
        </Button>
      </div>
      {error != null && (
        <Alert variant="destructive" className="mb-4" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{formatError(error, locale)}</AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <Card>
          <CardContent className="grid gap-5">
            <section className="grid gap-2">
              <h2 className="flex items-center gap-2">
                <SlidersHorizontal size={16} aria-hidden="true" />
                {t('sharedSetup.prompts')}
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('sharedSetup.promptsHint')}
              </p>
              <AssetBindings
                title={t('sharedSetup.prompts')}
                assets={workspace.prompts}
                bindings={draft.promptBindings}
                prompts
                hideTitle
                onChange={(promptBindings) => patch({ promptBindings })}
              />
            </section>
            <section className="grid gap-2">
              <h2 className="flex items-center gap-2">
                <Layers3 size={16} aria-hidden="true" />
                {t('sharedSetup.skills')}
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('sharedSetup.skillsHint')}
              </p>
              <AssetBindings
                title={t('sharedSetup.skills')}
                assets={workspace.skills}
                bindings={draft.skillBindings}
                hideTitle
                onChange={(skillBindings) => patch({ skillBindings })}
              />
            </section>
            <section className="grid gap-2">
              <h2 className="flex items-center gap-2">
                <Server size={16} aria-hidden="true" />
                {t('sharedSetup.tools')}
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('sharedSetup.toolsHint')}
              </p>
              <ResourcePicker
                title={t('sharedSetup.tools')}
                items={workspace.mcpServers}
                selected={draft.mcpServerIds}
                hideTitle
                onChange={(mcpServerIds) => patch({ mcpServerIds })}
              />
            </section>
            <section className="grid gap-2">
              <h2 className="flex items-center gap-2">
                <Boxes size={16} aria-hidden="true" />
                {t('sharedSetup.bundles')}
              </h2>
              <ResourcePicker
                title={t('sharedSetup.bundles')}
                items={workspace.bundles}
                selected={draft.bundleIds}
                hideTitle
                onChange={(bundleIds) => patch({ bundleIds })}
              />
            </section>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('sharedSetup.boundary')}
            </p>
          </CardContent>
        </Card>
        <div className="grid gap-4">
          <Card>
            <CardContent className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2>{t('sharedSetup.participants')}</h2>
                <Badge variant="muted">
                  {t('sharedSetup.applies', {
                    count: number(participants.length),
                    total: number(workspace.agents.length),
                  })}
                </Badge>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('sharedSetup.participantHint')}
              </p>
              {workspace.agents.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                  {t('sharedSetup.noAgents')}
                </p>
              ) : (
                <ul className="grid list-none gap-1.5 pl-0">
                  {workspace.agents.map((agent) => (
                    <li key={agent.id}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:bg-accent/50">
                        <Checkbox
                          checked={!draft.excludedAgentIds.includes(agent.id)}
                          disabled={busy}
                          onChange={(event) =>
                            void act(
                              setSharedSetupParticipation(
                                updateSharedSetup(workspace, draft),
                                agent.id,
                                event.target.checked,
                              ),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate text-xs">{agent.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-2">
              <h2>{t('sharedSetup.personal')}</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('sharedSetup.personalHint')}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
