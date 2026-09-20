import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getErrorKey } from '../src/shared/errors'
import {
  downloadArguments,
  engineDownloads,
  entryStatus,
  preferredCandidate,
  unsupportedDiscovery,
  type EngineCandidate,
} from '../src/shared/engines/discovery'
import {
  discoverEngines,
  downloadEngine,
  managedEngineRoot,
  searchLocations,
} from '../src/main/engines/discovery'
import { createEngineWorkspace, type EngineWorkspace } from '../src/shared/engines/workspace'

const roots: string[] = []
async function workspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentmatrix-discovery-'))
  roots.push(root)
  return root
}
async function fakeCli(directory: string, name: string, version: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 })
  return path
}
function dependencies(
  root: string,
  environment: NodeJS.ProcessEnv,
  workspace: EngineWorkspace = createEngineWorkspace(),
) {
  return {
    environment,
    dataDirectory: join(root, 'data'),
    workspace: { load: async () => workspace },
    // Only the directories this test creates are searched, never the host's install roots.
    commonDirectories: [],
  }
}
const candidate = (values: Partial<EngineCandidate>): EngineCandidate => ({
  executable: '/usr/local/bin/opencode',
  version: null,
  matchesContract: false,
  origin: 'path',
  installationId: null,
  ...values,
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('engine download planning', () => {
  it('pins the published package and keeps install scripts disabled', () => {
    expect(downloadArguments('pi', '/data/engines/pi')).toEqual([
      'install',
      '--prefix',
      '/data/engines/pi',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      '@earendil-works/pi-coding-agent@0.85.1',
    ])
    expect(downloadArguments('opencode', '/data/engines/opencode')).toContain('opencode-ai@1.18.16')
    expect(downloadArguments('deepseek-harness', '/x')).toContain('@deepseek-ai/dsh@0.1.5-rc.2')
  })
  it('searches the managed directory before PATH and the common locations', () => {
    const locations = searchLocations(
      { PATH: '/first:/second', HOME: '/home/agent' },
      '/data',
      'opencode',
    )
    expect(locations[0]).toEqual({
      directory: join(managedEngineRoot('/data', 'opencode'), 'node_modules', '.bin'),
      origin: 'managed',
    })
    expect(locations.slice(1, 3)).toEqual([
      { directory: '/first', origin: 'path' },
      { directory: '/second', origin: 'path' },
    ])
    expect(locations.filter((entry) => entry.origin === 'common')).toContainEqual({
      directory: '/home/agent/.local/bin',
      origin: 'common',
    })
  })
  it('separates a pinned match, another version, and nothing installed', () => {
    expect(entryStatus([])).toBe('missing')
    expect(entryStatus([candidate({ version: '1.0.0' })])).toBe('version-mismatch')
    expect(entryStatus([candidate({ version: '1.18.16', matchesContract: true })])).toBe('ready')
    const pinned = candidate({ executable: '/managed/opencode', matchesContract: true })
    expect(
      preferredCandidate({
        kind: 'opencode',
        expectedVersion: '1.18.16',
        package: 'opencode-ai',
        command: 'npm install',
        status: 'ready',
        candidates: [candidate({ version: '0.9.0' }), pinned],
      }),
    ).toBe(pinned)
  })
  it('reports every supported engine as missing where no CLI can run', () => {
    const report = unsupportedDiscovery('browser')
    expect(report.supported).toBe(false)
    expect(report.downloadAvailable).toBe(false)
    expect(report.engines.map((entry) => entry.kind)).toEqual(Object.keys(engineDownloads))
    expect(report.engines.every((entry) => entry.status === 'missing')).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('installed engine detection', () => {
  it('reads versions, links saved installations, and leaves native settings untouched', async () => {
    const root = await workspaceRoot()
    const bin = join(root, 'bin')
    const opencode = await fakeCli(bin, 'opencode', '1.18.16')
    await fakeCli(bin, 'pi', '0.70.0')
    const workspace = createEngineWorkspace()
    workspace.installations.push({
      id: 'saved-opencode',
      name: 'Saved OpenCode',
      kind: 'opencode',
      executable: opencode,
      prefixArgs: [],
      platform: process.platform === 'darwin' ? 'darwin' : 'linux',
      version: null,
      modes: [],
      probedAt: null,
    })
    const report = await discoverEngines(
      dependencies(root, { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, 'home') }, workspace),
      new AbortController().signal,
    )
    const byKind = Object.fromEntries(report.engines.map((entry) => [entry.kind, entry]))
    expect(report.supported).toBe(true)
    expect(report.downloadAvailable).toBe(false)
    expect(byKind.opencode!.status).toBe('ready')
    expect(byKind.opencode!.candidates).toEqual([
      {
        executable: opencode,
        version: '1.18.16',
        matchesContract: true,
        origin: 'path',
        installationId: 'saved-opencode',
      },
    ])
    expect(byKind.pi!.status).toBe('version-mismatch')
    expect(byKind.pi!.candidates[0]).toMatchObject({ version: '0.70.0', installationId: null })
    expect(byKind['deepseek-harness']!.status).toBe('missing')
    expect(byKind['deepseek-harness']!.command).toContain('@deepseek-ai/dsh@0.1.5-rc.2')
  })
  it('keeps an unreadable version command out of the pinned match', async () => {
    const root = await workspaceRoot()
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'opencode'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    const report = await discoverEngines(
      dependencies(root, { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, 'home') }),
      new AbortController().signal,
    )
    const entry = report.engines.find((item) => item.kind === 'opencode')!
    expect(entry.status).toBe('version-mismatch')
    expect(entry.candidates[0]).toMatchObject({ version: null, matchesContract: false })
  })
})

describe.skipIf(process.platform === 'win32')('one-click download', () => {
  it('installs into the application directory and verifies the new executable', async () => {
    const root = await workspaceRoot()
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(
      join(bin, 'npm'),
      `#!/bin/sh
mkdir -p "$3/node_modules/.bin"
printf '#!/bin/sh\\necho 1.18.16\\n' > "$3/node_modules/.bin/opencode"
chmod +x "$3/node_modules/.bin/opencode"
echo "added 1 package"
`,
      { mode: 0o755 },
    )
    const environment = { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, 'home') }
    const result = await downloadEngine(
      { kind: 'opencode' },
      dependencies(root, environment),
      new AbortController().signal,
    )
    expect(result.kind).toBe('opencode')
    expect(result.candidate).toMatchObject({ origin: 'managed', version: '1.18.16' })
    expect(result.candidate.executable).toBe(
      join(managedEngineRoot(join(root, 'data'), 'opencode'), 'node_modules', '.bin', 'opencode'),
    )
    expect(result.discovery.downloadAvailable).toBe(true)
    expect(result.discovery.engines.find((entry) => entry.kind === 'opencode')!.status).toBe('ready')
  })
  it('reports a download that produced no runnable CLI instead of reporting success', async () => {
    const root = await workspaceRoot()
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'npm'), '#!/bin/sh\necho "up to date"\n', { mode: 0o755 })
    await expect(
      downloadEngine(
        { kind: 'pi' },
        dependencies(root, { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, 'home') }),
        new AbortController().signal,
      ),
    ).rejects.toSatisfy((error) => getErrorKey(error) === 'error.engineDownloadFailed')
  })
  it('refuses a download without npm and rejects an unsupported engine kind', async () => {
    const root = await workspaceRoot()
    const environment = { PATH: join(root, 'empty'), HOME: join(root, 'home') }
    await expect(
      downloadEngine({ kind: 'pi' }, dependencies(root, environment), new AbortController().signal),
    ).rejects.toSatisfy((error) => getErrorKey(error) === 'error.engineDownloadUnavailable')
    await expect(
      downloadEngine(
        { kind: 'claude-code' },
        dependencies(root, environment),
        new AbortController().signal,
      ),
    ).rejects.toThrow()
  })
})
