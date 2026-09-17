export function startProbe(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): {
  request(payload: Record<string, unknown>): Promise<Record<string, unknown>>
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>
}
