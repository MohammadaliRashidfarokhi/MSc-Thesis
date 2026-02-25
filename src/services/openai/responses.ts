import { openaiJson, resolveModel } from './client'

export type OpenAIResponse = {
  id: string
  output?: Array<{
    content?: Array<{
      type?: string
      text?: string
      file_id?: string
    }>
  }>
  output_text?: string
  [key: string]: unknown
}

export type CreateResponseOptions = {
  model?: string
  input: unknown
  tools?: unknown
  tool_choice?: unknown
  signal?: AbortSignal
}

export const createResponse = async ({
  model,
  input,
  tools,
  tool_choice,
  signal,
}: CreateResponseOptions) => {
  return openaiJson<OpenAIResponse>('/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: resolveModel(model),
      input,
      tools,
      tool_choice,
    }),
    signal,
  })
}

export const extractOutputText = (data: OpenAIResponse) => {
  if (data.output_text) return data.output_text
  if (!data.output) return ''
  return data.output
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text')
    .map((content) => content.text ?? '')
    .join('\n')
}
