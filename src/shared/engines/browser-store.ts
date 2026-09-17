import { appError } from '../errors'
import type { Locale } from '../i18n'
import { createInitialEngineWorkspace, validateAssetHistory } from './editing'
import { migrateWorkspaceDocument } from './migration'
import { engineWorkspaceSchema, type EngineWorkspace } from './workspace'

export const previewStorageKey = 'agent-matrix:preview:v2'
export const legacyPreviewStorageKey = 'agent-matrix:preview:v1'

/** Retains the legacy key unchanged as a backup; never falls back from an unreadable v2 document. */
export class BrowserWorkspaceStore {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly locale: Locale,
  ) {}

  load(): EngineWorkspace {
    const current = this.storage.getItem(previewStorageKey)
    if (current !== null) {
      try {
        return engineWorkspaceSchema.parse(JSON.parse(current))
      } catch {
        throw appError('error.unreadable', { path: 'localStorage' })
      }
    }
    const legacy = this.storage.getItem(legacyPreviewStorageKey)
    let workspace: EngineWorkspace
    try {
      workspace =
        legacy === null
          ? createInitialEngineWorkspace(this.locale)
          : migrateWorkspaceDocument(JSON.parse(legacy)).workspace
    } catch {
      throw appError('error.unreadable', { path: 'localStorage' })
    }
    this.storage.setItem(previewStorageKey, JSON.stringify(workspace))
    return workspace
  }

  save(input: unknown): EngineWorkspace {
    const next = engineWorkspaceSchema.parse(input)
    const current = this.load()
    if (next.revision !== current.revision) throw appError('error.conflict')
    validateAssetHistory(current, next)
    const saved = { ...next, revision: current.revision + 1 }
    this.storage.setItem(previewStorageKey, JSON.stringify(saved))
    return saved
  }
}
