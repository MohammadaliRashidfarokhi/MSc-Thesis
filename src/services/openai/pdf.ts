import { downloadFileContent, uploadFile } from './files'
import { createResponse } from './responses'
import type { OpenAIResponse } from './responses'

export type PdfResponseOptions = {
  files: File[]
  prompt: string
  model?: string
  signal?: AbortSignal
}

const collectFileIds = (value: unknown, results: Set<string>) => {
  if (!value) return
  if (Array.isArray(value)) {
    value.forEach((entry) => collectFileIds(entry, results))
    return
  }
  if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
      if (key === 'file_id' && typeof entry === 'string') {
        results.add(entry)
      } else {
        collectFileIds(entry, results)
      }
    })
  }
}

const findOutputFileId = (data: OpenAIResponse, inputIds: string[] = []) => {
  const found = new Set<string>()
  collectFileIds(data, found)
  if (inputIds.length === 0) {
    return Array.from(found)[0] ?? ''
  }
  const inputSet = new Set(inputIds)
  return Array.from(found).find((id) => !inputSet.has(id)) ?? ''
}

export const createPdfResponse = async ({
  files,
  prompt,
  model,
  signal,
}: PdfResponseOptions) => {
  if (!files.length) {
    throw new Error('No files provided for upload.')
  }

  const uploaded = await Promise.all(files.map((file) => uploadFile(file, signal)))
  const inputContent = [
    { type: 'input_text', text: prompt },
    ...uploaded.map((file) => ({ type: 'input_file', file_id: file.id })),
  ]

  const response = await createResponse({
    model,
    tools: [{ type: 'code_interpreter' }],
    tool_choice: 'required',
    input: [
      {
        role: 'user',
        content: inputContent,
      },
    ],
    signal,
  })

  const outputFileId = findOutputFileId(response, uploaded.map((file) => file.id))
  if (!outputFileId) {
    throw new Error('No PDF file returned by the API.')
  }

  const blob = await downloadFileContent(outputFileId, signal)

  return {
    blob,
    fileId: outputFileId,
    raw: response,
    inputFileIds: uploaded.map((file) => file.id),
  }
}

export const createPdfFromText = async ({
  text,
  model,
  signal,
}: {
  text: string
  model?: string
  signal?: AbortSignal
}) => {
  if (!text.trim()) {
    throw new Error('No text provided for PDF generation.')
  }

  const response = await createResponse({
    model,
    tools: [{ type: 'code_interpreter' }],
    tool_choice: 'required',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    ],
    signal,
  })

  const outputFileId = findOutputFileId(response)
  if (!outputFileId) {
    throw new Error('No PDF file returned by the API.')
  }

  const blob = await downloadFileContent(outputFileId, signal)

  return {
    blob,
    fileId: outputFileId,
    raw: response,
  }
}
