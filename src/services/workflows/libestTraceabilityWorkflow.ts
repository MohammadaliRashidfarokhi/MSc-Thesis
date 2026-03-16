import { extractTextFromGemini, generateContent } from '../gemini/content'
import { createPdfFromText } from '../pdf/pdfBuilder'

export type LibestRequirement = {
  reqId: string
  filePath: string
  text: string
}

export type LibestCodeArtifact = {
  filePath: string
  content: string
}

export type LibestTraceabilityInput = {
  model?: string
  signal?: AbortSignal
  maxCodeCharsPerFile?: number
}

export type LibestTraceabilityResult = {
  requirements: LibestRequirement[]
  codeArtifacts: LibestCodeArtifact[]
  outputText: string
  raw: unknown
  pdf: {
    blob: Blob
    fileId: string
  }
}

const LIBEST_REQUIREMENT_MODULES = import.meta.glob('/src/dataset/req/*.txt', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const LIBEST_CODE_MODULES = import.meta.glob('/src/dataset/code/*.{c,h}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const TRACEABILITY_PROMPT = `
You are a deterministic traceability mapper for the LibEST dataset.

Input:
- Requirement artifacts (RQ*.txt)
- Source/Test code artifacts (.c, .h)

Task:
- Map each requirement to the most relevant code artifact(s).
- Use only the provided requirements and code as evidence.
- Do not use any gold CSV or external knowledge.

Return strict JSON:
{
  "links": [
    {
      "req_id": "RQ#",
      "code_file": "file name",
      "status": "Direct|Indirect|None",
      "confidence": 0.0,
      "reasoning": "Evidence-backed explanation from code and requirement text",
      "evidence_snippet": "Short quoted code/requirement evidence"
    }
  ],
  "summary": {
    "total_requirements": 0,
    "direct_links": 0,
    "indirect_links": 0,
    "none_links": 0
  }
}
`

const byPath = <T>(entries: T[], pathOf: (entry: T) => string) => {
  return [...entries].sort((a, b) => pathOf(a).localeCompare(pathOf(b)))
}

const parseReqIdFromPath = (filePath: string) => {
  const match = filePath.match(/RQ(\d+)\.txt$/i)
  if (!match) return filePath
  return `RQ${match[1]}`
}

const sortRequirements = (requirements: LibestRequirement[]) => {
  return [...requirements].sort((a, b) => {
    const aNum = Number(a.reqId.replace(/^RQ/i, ''))
    const bNum = Number(b.reqId.replace(/^RQ/i, ''))
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum
    return a.reqId.localeCompare(b.reqId)
  })
}

const loadRequirements = () => {
  const entries = Object.entries(LIBEST_REQUIREMENT_MODULES).map(([filePath, text]) => ({
    reqId: parseReqIdFromPath(filePath),
    filePath,
    text: String(text ?? '').trim(),
  }))

  return sortRequirements(entries)
}

const loadCodeArtifacts = () => {
  const entries = Object.entries(LIBEST_CODE_MODULES).map(([filePath, content]) => ({
    filePath,
    content: String(content ?? ''),
  }))
  return byPath(entries, (entry) => entry.filePath)
}

const buildPromptInput = ({
  requirements,
  codeArtifacts,
  maxCodeCharsPerFile,
}: {
  requirements: LibestRequirement[]
  codeArtifacts: LibestCodeArtifact[]
  maxCodeCharsPerFile: number
}) => {
  const requirementBlock = requirements
    .map((entry) => `${entry.reqId} (${entry.filePath})\n${entry.text}`)
    .join('\n\n---\n\n')

  const codeBlock = codeArtifacts
    .map((entry) => {
      const trimmed = entry.content.slice(0, maxCodeCharsPerFile)
      const clipped =
        entry.content.length > maxCodeCharsPerFile
          ? `${trimmed}\n\n/* [truncated for prompt size] */`
          : trimmed
      return `${entry.filePath}\n${clipped}`
    })
    .join('\n\n---\n\n')

  return `${TRACEABILITY_PROMPT}

Requirements:
${requirementBlock}

Code artifacts:
${codeBlock}`
}

export const runLibestTraceabilityMapper = async ({
  model,
  signal,
  maxCodeCharsPerFile = 12000,
}: LibestTraceabilityInput = {}): Promise<LibestTraceabilityResult> => {
  const requirements = loadRequirements()
  const codeArtifacts = loadCodeArtifacts()

  if (!requirements.length) {
    throw new Error('LibEST requirement files were not found in /src/dataset/req.')
  }

  if (!codeArtifacts.length) {
    throw new Error('LibEST code files were not found in /src/dataset/code.')
  }

  const prompt = buildPromptInput({
    requirements,
    codeArtifacts,
    maxCodeCharsPerFile,
  })

  const response = await generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
    },
    signal,
  })

  const outputText = extractTextFromGemini(response)
  const pdfBlob = await createPdfFromText(
    `LibEST traceability mapper output.\n\n${outputText || 'No output generated.'}`
  )

  return {
    requirements,
    codeArtifacts,
    outputText,
    raw: response,
    pdf: {
      blob: pdfBlob,
      fileId: 'local',
    },
  }
}
