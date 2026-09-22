import { appError } from '../../shared/errors'
import type {
  NativeImportRecord,
  OpenCodePromptReference,
} from '../../shared/engines/native-import'
import { createSecretMatcher } from '../engines/process/redacted-tail'
import type { NativeImportPlan } from './plan'

/** Reject copied known credentials before either a preview or ordinary workspace data escapes. */
export function verifyImportSecretBoundary(
  plan: NativeImportPlan,
  record: NativeImportRecord,
  promptReferences: OpenCodePromptReference[] | undefined,
): void {
  // A multi-provider import may exceed a single run's secret count. Compile bounded batches
  // without imposing that per-run limit on an otherwise valid file group.
  const matchers: ((value: string) => boolean)[] = []
  let batch: string[] = [],
    characters = 0
  for (const value of new Set(plan.credentials.map((credential) => credential.value))) {
    if (batch.length === 256 || characters + value.length > 1_048_576) {
      matchers.push(createSecretMatcher(batch))
      batch = []
      characters = 0
    }
    batch.push(value)
    characters += value.length
  }
  if (batch.length) matchers.push(createSecretMatcher(batch))
  if (!matchers.length) return
  const checkText = (text: string) => {
    // Provenance uses JSON pointers; endpoint normalization can percent-encode only part
    // of a value. Decode once as data, without resolving native references or expressions.
    const forms = [text, text.replaceAll('~1', '/').replaceAll('~0', '~')]
    for (const form of [...forms]) {
      try {
        forms.push(decodeURIComponent(form))
      } catch {
        /* Literal malformed escapes. */
      }
    }
    if (forms.some((value) => matchers.some((match) => match(value))))
      throw appError('error.nativeImportSecretCopy')
  }
  const inspect = (value: unknown): void => {
    if (typeof value === 'string') checkText(value)
    else if (Array.isArray(value)) for (const item of value) inspect(item)
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        checkText(key)
        inspect(item)
      }
  }
  inspect({
    additions: plan.additions,
    bindings: plan.bindings,
    record,
    promptReferences,
    credentials: plan.credentials.map((credential) =>
      Object.fromEntries(Object.entries(credential).filter(([key]) => key !== 'value')),
    ),
  })
}
