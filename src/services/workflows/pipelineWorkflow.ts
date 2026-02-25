import { extractTextFromGemini, fileToInlinePart, generateContent } from '../gemini/content'
import { createPdfFromText } from '../pdf/pdfBuilder'

export type PipelineMode = 'start' | 'rerun' | 'continue'

export type PipelineStageKey = 'requirements' | 'tests' | 'queries'

export type PipelineStage = {
  key: PipelineStageKey
  label: string
  prompt: string
}

export type PipelineStageResult = PipelineStage & {
  outputText: string
  raw: unknown
}

export type PipelinePreviousOutputs = Partial<Record<PipelineStageKey, string>>

export type PipelineInput = {
  files: File[]
  mode?: PipelineMode
  model?: string
  previous?: PipelinePreviousOutputs
  signal?: AbortSignal
  onStageChange?: (stage: PipelineStage) => void
}

export type PipelineResult = {
  stages: PipelineStageResult[]
  pdf: {
    blob: Blob
    fileId: string
  }
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    key: 'requirements',
    label: 'Behavior Specs',
    prompt: `You are an Artifact Normalizer for a Semantic Test Gap Analysis system.
Convert raw requirements/user stories into ATOMIC, TESTABLE behaviors.

Rules:
- Output ONLY valid JSON matching the schema.
- Do not invent missing details. If unclear, set fields to null and add a question in "open_questions".
- Each atomic requirement must be observable (what can be verified by a test).
- Preserve original wording in "source_text".

JSON Schema:
{
  "requirements": [
    {
      "req_id": "R-###.#",
      "title": "...",
      "source_text": "...",
      "preconditions": ["..."],
      "trigger": "...",
      "expected_outcomes": ["..."],
      "negative_cases": ["..."],
      "notes": "...",
      "open_questions": ["..."]
    }
  ]
}`,
  },
  {
    key: 'tests',
    label: 'Test Catalog + Oracles',
    prompt: `You are an Artifact Normalizer for test suites.
Extract a structured test inventory from the provided test code/spec.

Rules:
- Output ONLY valid JSON.
- Do not guess runtime behavior; only extract what is explicitly in the test.
- Extract assertions as plain-language checks + referenced variables.

JSON Schema:
{
  "tests": [
    {
      "test_id": "T-###",
      "file_path": "...",
      "test_name": "...",
      "purpose_summary": "...",
      "steps": ["..."],
      "assertions": [
        {"assertion_text": "...", "evidence_snippet": "..."}
      ],
      "touched_components": ["..."],
      "tags": ["..."]
    }
  ]
}`,
  },
  {
    key: 'queries',
    label: 'Retrieval Queries',
    prompt: `You are a retrieval query builder for semantic traceability.
Given one atomic requirement, produce 3 queries:
1) find matching tests
2) find relevant code/docs
3) find edge-case/negative scenario references

Return JSON:
{
  "queries": [
    {"target":"tests", "q":"..."},
    {"target":"code_docs", "q":"..."},
    {"target":"tickets_docs", "q":"..."}
  ],
  "keywords":["..."],
  "entities":["..."]
}`,
  },
]

const buildStagePrompt = (
  base: string,
  mode: PipelineMode,
  previousOutput?: string
) => {
  if (mode !== 'continue' || !previousOutput?.trim()) {
    return base
  }
  return `${base}\n\nPrevious output:\n${previousOutput}\n\nContinue from the previous output. Extend and refine it.`
}

const buildPdfPrompt = (stages: PipelineStageResult[]) => {
  const sections = stages
    .map(
      (stage) =>
        `### ${stage.label}\n${stage.outputText || 'No output generated.'}`
    )
    .join('\n\n')
  return `Requirments .\n\n${sections}`
}

export const runArtifactPipeline = async ({
  files,
  mode = 'start',
  model,
  previous,
  signal,
  onStageChange,
}: PipelineInput): Promise<PipelineResult> => {
  if (!files.length) {
    throw new Error('No files provided for upload.')
  }

  const fileInputs = await Promise.all(files.map((file) => fileToInlinePart(file)))

  const results: PipelineStageResult[] = []

  for (const stage of PIPELINE_STAGES) {
    onStageChange?.(stage)
    const prompt = buildStagePrompt(stage.prompt, mode, previous?.[stage.key])
    const response = await generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, ...fileInputs],
        },
      ],
      signal,
    })
    const outputText = extractTextFromGemini(response)
    results.push({
      ...stage,
      prompt,
      outputText,
      raw: response,
    })
  }

  const pdfPrompt = buildPdfPrompt(results)
  const pdfBlob = await createPdfFromText(pdfPrompt)

  return {
    stages: results,
    pdf: {
      blob: pdfBlob,
      fileId: 'local',
    },
  }
}
