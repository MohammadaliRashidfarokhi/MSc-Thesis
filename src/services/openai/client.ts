export type OpenAIConfig = {
  baseUrl: string
  apiKey: string
  defaultModel: string
}

const OPENAI_BASE_URL =
  (import.meta.env.VITE_OPENAI_BASE_URL as string | undefined) ??
  'https://api.openai.com/v1'

const OPENAI_API_KEY = (import.meta.env.VITE_OPENAI_API_KEY as string | undefined) ?? ''
const OPENAI_MODEL = (import.meta.env.VITE_OPENAI_MODEL as string | undefined) ?? ''

const ensureApiKey = () => {
  if (!OPENAI_API_KEY) {
    throw new Error('Missing VITE_OPENAI_API_KEY environment variable.')
  }
}

export const getOpenAIConfig = (): OpenAIConfig => {
  ensureApiKey()
  return {
    baseUrl: OPENAI_BASE_URL,
    apiKey: OPENAI_API_KEY,
    defaultModel: OPENAI_MODEL,
  }
}

export const resolveModel = (model?: string) => {
  const resolved = model || OPENAI_MODEL
  if (!resolved) {
    throw new Error('Missing VITE_OPENAI_MODEL environment variable.')
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
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    ...headers,
  }
}

export const openaiFetch = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
    ...init,
    headers: withAuthHeaders(init.headers),
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  return response
}

export const openaiJson = async <T>(path: string, init: RequestInit = {}) => {
  const response = await openaiFetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  return (await response.json()) as T
}
