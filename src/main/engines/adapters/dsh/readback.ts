import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { RunInputManifest } from '../../../../shared/engines/run-inputs'
import { RuntimeFailure } from '../../runtime'
import type { ConfigurationField } from '../../../../shared/engines/configuration-report'

/** DSH 0.1.5-rc.2 encodes an opaque selector as a JSON route tuple, not provider/model. */
export function verifyDshOptions(
  options: SessionConfigOption[] | null | undefined,
  manifest: Pick<RunInputManifest, 'connection' | 'model'>,
): string {
  const fields: ConfigurationField[] = []
  try {
    const model = options?.filter((option) => option.id === 'model')
    if (model?.length !== 1 || model[0]?.type !== 'select') throw new Error('Missing model')
    const value = model[0].currentValue
    const route: unknown = JSON.parse(value)
    const provider =
      manifest.connection.protocol === 'deepseek-official'
        ? 'deepseek-official'
        : `agentmatrix-${manifest.connection.id}`
    if (
      !Array.isArray(route) ||
      route.length !== 2 ||
      route.some((part) => typeof part !== 'string')
    )
      throw new Error('Invalid model route')
    if (route[0] !== provider) fields.push('connection')
    if (route[1] !== manifest.model.modelId) fields.push('model')
    // The generic provider is configured with reasoning disabled and advertises no selector.
    // The native DeepSeek component advertises off/low/high/max and must report the exact choice.
    const reasoning = options?.filter((option) => option.id === 'reasoning_effort') ?? []
    if (
      manifest.connection.protocol === 'deepseek-official'
        ? reasoning.length !== 1 ||
          reasoning[0]?.type !== 'select' ||
          reasoning[0].currentValue !== (manifest.model.parameters.reasoning ?? 'off')
        : reasoning.some((option) => option.type !== 'select' || option.currentValue !== 'off')
    )
      fields.push('reasoning')
    if (fields.length)
      throw new RuntimeFailure('configuration', 'dsh.session-options', {
        check: 'dsh-session',
        reason: 'mismatch',
        fields,
      })
    return value
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error
    throw new RuntimeFailure('configuration', 'dsh.session-options', {
      check: 'dsh-session',
      reason: 'unavailable',
      fields: [],
    })
  }
}
