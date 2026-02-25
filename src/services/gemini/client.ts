export type GeminiConfig = {
  baseUrl: string
  apiKey: string
  defaultModel: string
}

const GEMINI_BASE_URL =
  (import.meta.env.VITE_GEMINI_BASE_URL as string | undefined) ??
  'https://generativelanguage.googleapis.com/v1beta'

// Backward-compatible fallback while migrating from old OpenAI env names.
const GEMINI_API_KEY =
  (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ??
  (import.meta.env.VITE_OPENAI_API_KEY as string | undefined) ??
  ''
const GEMINI_MODEL = (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? ''

const ensureApiKey = () => {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing VITE_GEMINI_API_KEY environment variable.')
  }
}

export const getGeminiConfig = (): GeminiConfig => {
  ensureApiKey()
  return {
    baseUrl: GEMINI_BASE_URL,
    apiKey: GEMINI_API_KEY,
    defaultModel: GEMINI_MODEL,
  }
}

export const resolveModel = (model?: string) => {
  const resolved = (model || GEMINI_MODEL).trim()
  if (!resolved) {
    throw new Error(
      'Missing VITE_GEMINI_MODEL environment variable. Example: VITE_GEMINI_MODEL=gemini-2.0-flash'
    )
  }
  return resolved
}

const parseError = async (response: Response) => {
  let message = `${response.status} ${response.statusText}`
  try {
    const data = await response.json()
    message = data?.error?.message ?? data?.message ?? message
  } catch {
    // no-op
  }
  return message
}

const withAuthHeaders = (headers?: HeadersInit) => {
  ensureApiKey()
  return {
    'x-goog-api-key': GEMINI_API_KEY,
    ...headers,
  }
}

export const geminiFetch = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${GEMINI_BASE_URL}${path}`, {
    ...init,
    headers: withAuthHeaders(init.headers),
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return response
}

export const geminiJson = async <T>(path: string, init: RequestInit = {}) => {
  const response = await geminiFetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  return (await response.json()) as T
}
