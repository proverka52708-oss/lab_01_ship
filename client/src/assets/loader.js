export class HttpError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} while loading ${url}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

export class RequiredAssetsError extends Error {
  constructor(failures) {
    super('Some required assets could not be loaded')
    this.name = 'RequiredAssetsError'
    this.failures = failures
  }
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? abortError()
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    const timer = setTimeout(done, ms)

    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }

    function onAbort() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? abortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isClientError(error) {
  return error instanceof HttpError && error.status >= 400 && error.status < 500
}

export async function withRetry(
  operation,
  { attempts = 3, baseMs = 180, signal, random = Math.random } = {},
) {
  let lastError

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal)
    try {
      return await operation(signal)
    } catch (error) {
      lastError = error
      if (signal?.aborted || error.name === 'AbortError' || isClientError(error))
        throw error
      if (attempt + 1 < attempts) {
        const jitter = 0.5 + random()
        await wait(baseMs * 2 ** attempt * jitter, signal)
      }
    }
  }

  throw lastError
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function fetchJson(
  url,
  { signal, timeoutMs = 5000, fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(url, {
    signal: requestSignal(signal, timeoutMs),
  })
  if (!response.ok) throw new HttpError(url, response.status)
  return response.json()
}

export async function loadImage(url, signal) {
  const response = await fetch(url, {
    signal: requestSignal(signal, 8000),
  })
  if (!response.ok) throw new HttpError(url, response.status)
  const blob = await response.blob()
  throwIfAborted(signal)
  const objectUrl = URL.createObjectURL(blob)

  return new Promise((resolve, reject) => {
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
      reject(signal.reason ?? abortError())
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

export async function loadAudio(context, url, signal) {
  throwIfAborted(signal)
  const response = await fetch(url, {
    signal: requestSignal(signal, 8000),
  })
  if (!response.ok) throw new HttpError(url, response.status)
  const bytes = await response.arrayBuffer()
  throwIfAborted(signal)
  return context.decodeAudioData(bytes)
}

export function loadJson(url, signal) {
  return fetchJson(url, { signal })
}

export async function loadAll(manifest, { context, onProgress, signal } = {}) {
  const entries = [
    ...(manifest.sprites ?? []).map((asset) => ({ ...asset, type: 'sprite' })),
    ...(manifest.sounds ?? []).map((asset) => ({ ...asset, type: 'sound' })),
    ...(manifest.data ?? []).map((asset) => ({ ...asset, type: 'data' })),
  ]
  const assets = { sprites: {}, sounds: {}, data: {} }
  const failures = []
  let completed = 0

  const tasks = entries.map(async (asset) => {
    try {
      const value = await withRetry(
        (retrySignal) => {
          if (asset.type === 'sprite') return loadImage(asset.url, retrySignal)
          if (asset.type === 'sound') return loadAudio(context, asset.url, retrySignal)
          return loadJson(asset.url, retrySignal)
        },
        { signal, attempts: asset.attempts ?? 3 },
      )
      assets[
        asset.type === 'sprite' ? 'sprites' : asset.type === 'sound' ? 'sounds' : 'data'
      ][asset.id] = value
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
