import { geminiJson, resolveModel } from './client'

export type GeminiInlineData = {
  mime_type: string
  data: string
}

export type GeminiPart = {
  text?: string
  inline_data?: GeminiInlineData
}

export type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export type GeminiCandidate = {
  content?: {
    parts?: Array<{
      text?: string
    }>
  }
}

export type GeminiGenerateResponse = {
  candidates?: GeminiCandidate[]
  [key: string]: unknown
}

export type GenerateContentOptions = {
  model?: string
  contents: GeminiContent[]
  generationConfig?: {
    responseMimeType?: string
  }
  signal?: AbortSignal
}

export const generateContent = async ({
  model,
  contents,
  generationConfig,
  signal,
}: GenerateContentOptions) => {
  const resolved = resolveModel(model)
  return geminiJson<GeminiGenerateResponse>(`/models/${resolved}:generateContent`, {
    method: 'POST',
    body: JSON.stringify({ contents, generationConfig }),
    signal,
  })
}

export const extractTextFromGemini = (data: GeminiGenerateResponse) => {
  const parts =
    data.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? []
  return parts.map((part) => part.text ?? '').join('\n').trim()
}

const bytesToBase64 = (bytes: Uint8Array) => {
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export const fileToInlinePart = async (file: File): Promise<GeminiPart> => {
  const buffer = await file.arrayBuffer()
  const base64 = bytesToBase64(new Uint8Array(buffer))
  return {
    inline_data: {
      mime_type: file.type || 'application/octet-stream',
      data: base64,
    },
  }
}
