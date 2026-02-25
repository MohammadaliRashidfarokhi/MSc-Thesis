import { createPdfResponse } from '../openai/pdf'

export type PdfWorkflowMode = 'start' | 'rerun' | 'continue'

export type PdfWorkflowInput = {
  files: File[]
  feedback?: string
  mode?: PdfWorkflowMode
  model?: string
  signal?: AbortSignal
}

export type PdfWorkflowResult = {
  blob: Blob
  fileId: string
  raw: unknown
  mode: PdfWorkflowMode
  prompt: string
  feedback?: string
}

const BASE_PROMPT =
  'Create a clean PDF report summarizing the uploaded files. Include headings, bullet points, and a short executive summary.'

const CONTINUE_PROMPT =
  'Continue the PDF report with deeper insights and any missing details based on the uploaded files.'

const buildPrompt = (mode: PdfWorkflowMode, feedback?: string) => {
  const base = mode === 'continue' ? CONTINUE_PROMPT : BASE_PROMPT
  const trimmed = feedback?.trim()
  if (!trimmed) return base
  return `${base}\n\nUser feedback to incorporate:\n${trimmed}`
}

export const runPdfWorkflow = async ({
  files,
  feedback,
  mode = 'start',
  model,
  signal,
}: PdfWorkflowInput): Promise<PdfWorkflowResult> => {
  const prompt = buildPrompt(mode, feedback)
  const result = await createPdfResponse({
    files,
    prompt,
    model,
    signal,
  })

  return {
    ...result,
    mode,
    prompt,
    feedback,
  }
}
