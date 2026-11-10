export class HttpError extends Error {
  status: number
  url: string

  constructor(url: string, status: number) {
    super(`HTTP ${status} while loading ${url}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

export class RequiredAssetsError extends Error {
  failures: AssetFailure[]

  constructor(failures: AssetFailure[]) {
    super('Some required assets could not be loaded')
    this.name = 'RequiredAssetsError'
    this.failures = failures
  }
}

export interface AssetFailure {
  id: string
  type: AssetType
  url: string
  error: unknown
  required: boolean
}

export type AssetType = 'sprite' | 'sound' | 'data'
export interface AssetDescriptor {
  id: string
  url: string
  required: boolean
  attempts?: number
}
export interface AssetManifest {
  sprites?: AssetDescriptor[]
  sounds?: AssetDescriptor[]
  data?: AssetDescriptor[]
}
export interface LoadedAssets {
  sprites: Record<string, HTMLImageElement>
  sounds: Record<string, AudioBuffer | null>
  data: Record<string, unknown> & {
    arena?: { width?: number; height?: number; asteroidCount?: number }
  }
}
export interface LoadProgress {
  completed: number
  total: number
  id?: string
}
export interface RetryOptions {
  attempts?: number
  baseMs?: number
  signal?: AbortSignal
  random?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAssetManifest(value: unknown): AssetManifest {
  if (!isRecord(value)) {
    throw new TypeError('Asset manifest must be an object')
  }
  const parseEntries = (entries: unknown): AssetDescriptor[] => {
    if (entries === undefined) return []
    if (!Array.isArray(entries)) throw new TypeError('Asset manifest entry list is invalid')
    return entries.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        typeof entry.id !== 'string' ||
        typeof entry.url !== 'string' ||
        typeof entry.required !== 'boolean' ||
        (entry.attempts !== undefined && typeof entry.attempts !== 'number')
      ) {
        throw new TypeError('Asset manifest entry is invalid')
      }
      return {
        id: entry.id,
        url: entry.url,
        required: entry.required,
        ...(typeof entry.attempts === 'number' ? { attempts: entry.attempts } : {}),
      }
    })
  }
  return {
    sprites: parseEntries(value.sprites),
    sounds: parseEntries(value.sounds),
    data: parseEntries(value.data),
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? abortError()
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal)
    const timer = setTimeout(done, ms)

    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }

    function onAbort() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? abortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isClientError(error: unknown): boolean {
  return error instanceof HttpError && error.status >= 400 && error.status < 500
}

export async function withRetry<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  { attempts = 3, baseMs = 180, signal, random = Math.random }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal)
    try {
      return await operation(signal)
    } catch (error) {
      lastError = error
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError') ||
        isClientError(error)
      )
        throw error
      if (attempt + 1 < attempts) {
        const jitter = 0.5 + random()
        await wait(baseMs * 2 ** attempt * jitter, signal)
      }
    }
  }

  throw lastError
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function fetchJson(
  url: string,
  {
    signal,
    timeoutMs = 5000,
    fetchImpl = fetch,
  }: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const response = await fetchImpl(url, {
    signal: requestSignal(signal, timeoutMs),
  })
  if (!response.ok) throw new HttpError(url, response.status)
  return response.json()
}

export async function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  const response = await fetch(url, {
    signal: requestSignal(signal, 8000),
  })
  if (!response.ok) throw new HttpError(url, response.status)
  const blob = await response.blob()
  throwIfAborted(signal)
  const objectUrl = URL.createObjectURL(blob)

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()

    const cleanup = () => {
      image.onload = null
      image.onerror = null
      signal?.removeEventListener('abort', onAbort)
      URL.revokeObjectURL(objectUrl)
    }

    const onAbort = () => {
      cleanup()
      image.src = ''
      reject(signal?.reason ?? abortError())
    }

    image.onload = () => {
      cleanup()
      resolve(image)
    }
    image.onerror = () => {
      cleanup()
      reject(new Error(`Image failed to decode: ${url}`))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    image.src = objectUrl
  })
}

export async function loadAudio(
  context: AudioContext,
  url: string,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  throwIfAborted(signal)
  const response = await fetch(url, {
    signal: requestSignal(signal, 8000),
  })
  if (!response.ok) throw new HttpError(url, response.status)
  const bytes = await response.arrayBuffer()
  throwIfAborted(signal)
  return context.decodeAudioData(bytes)
}

export function loadJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return fetchJson(url, { signal })
}

export async function loadAll(
  manifest: AssetManifest,
  {
    context,
    onProgress,
    signal,
  }: { context?: AudioContext | null; onProgress?: (progress: LoadProgress) => void; signal?: AbortSignal } = {},
): Promise<{ assets: LoadedAssets; failures: AssetFailure[] }> {
  const entries: (AssetDescriptor & { type: AssetType })[] = [
    ...(manifest.sprites ?? []).map((asset): AssetDescriptor & { type: AssetType } => ({ ...asset, type: 'sprite' })),
    ...(manifest.sounds ?? []).map((asset): AssetDescriptor & { type: AssetType } => ({ ...asset, type: 'sound' })),
    ...(manifest.data ?? []).map((asset): AssetDescriptor & { type: AssetType } => ({ ...asset, type: 'data' })),
  ]
  const assets: LoadedAssets = { sprites: {}, sounds: {}, data: {} }
  const failures: AssetFailure[] = []
  let completed = 0

  const tasks = entries.map(async (asset) => {
    try {
      const value: unknown = await withRetry(
        (retrySignal) => {
          if (asset.type === 'sprite') return loadImage(asset.url, retrySignal)
          if (asset.type === 'sound') {
            if (!context) throw new Error('Audio context is unavailable')
            return loadAudio(context, asset.url, retrySignal)
          }
          return loadJson(asset.url, retrySignal)
        },
        { signal, attempts: asset.attempts ?? 3 },
      )
      if (asset.type === 'sprite') {
        if (!(value instanceof HTMLImageElement)) throw new TypeError('Loaded sprite is invalid')
        assets.sprites[asset.id] = value
      } else if (asset.type === 'sound') {
        if (!(value instanceof AudioBuffer)) throw new TypeError('Loaded sound is invalid')
        assets.sounds[asset.id] = value
      } else {
        assets.data[asset.id] = value
      }
    } catch (error) {
      failures.push({
        id: asset.id,
        type: asset.type,
        url: asset.url,
        error,
        required: asset.required,
      })
      if (asset.type === 'sound') assets.sounds[asset.id] = null
    } finally {
      completed += 1
      onProgress?.({ completed, total: entries.length, id: asset.id })
    }
  })

  await Promise.all(tasks)
  throwIfAborted(signal)

  const requiredFailures = failures.filter((failure) => failure.required)
  if (requiredFailures.length) throw new RequiredAssetsError(requiredFailures)

  return { assets, failures }
}
