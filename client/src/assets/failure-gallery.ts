import { HttpError, fetchJson, loadImage, withRetry } from './loader.ts'

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error'
}

export interface FailureResult {
  label: string
  recovered: boolean
  message: string
}

export async function runFailureGallery(): Promise<FailureResult[]> {
  const results: FailureResult[] = []

  let notFoundRetries = 0
  try {
    await withRetry(() => loadImage('/api/test/missing-sprite.svg'), {
      attempts: 3,
      baseMs: 0,
    })
  } catch (error) {
    if (error instanceof HttpError) notFoundRetries = 1
    results.push({
      label: '404 sprite',
      recovered: error instanceof HttpError && error.status === 404,
      message: `${errorName(error)} ${error instanceof HttpError ? error.status : ''} · retries ${notFoundRetries}`,
    })
  }

  try {
    await fetchJson('/api/test/timeout', { timeoutMs: 120 })
  } catch (error) {
    results.push({
      label: 'Network timeout',
      recovered: errorName(error) === 'TimeoutError' || errorName(error) === 'AbortError',
      message: `${errorName(error)} · lobby/game remains usable`,
    })
  }

  const controller = new AbortController()
  const slowLoad = loadImage('/api/test/slow-sprite.svg', controller.signal)
  setTimeout(() => controller.abort(), 80)
  try {
    await slowLoad
  } catch (error) {
    results.push({
      label: 'Abort mid-load',
      recovered: errorName(error) === 'AbortError',
      message: `${errorName(error)} · request cancelled`,
    })
  }

  try {
    await fetchJson('/api/test/corrupt-json')
  } catch (error) {
    results.push({
      label: 'Corrupt JSON',
      recovered: error instanceof SyntaxError,
      message: `${errorName(error)} · parse error surfaced and caught`,
    })
  }

  return results
}

export async function compareLoadingTimes(
  wait: (ms: number) => Promise<unknown> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ sequential: number; concurrent: number }> {
  const startSequential = performance.now()
  await wait(250)
  await wait(250)
  const sequential = Math.round(performance.now() - startSequential)

  const startConcurrent = performance.now()
  await Promise.all([wait(250), wait(250)])
  const concurrent = Math.round(performance.now() - startConcurrent)

  return { sequential, concurrent }
}
