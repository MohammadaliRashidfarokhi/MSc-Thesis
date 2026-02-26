import { extractTextFromGemini, fileToInlinePart, generateContent } from '../gemini/content'
import { createPdfFromText } from '../pdf/pdfBuilder'
import {
  PIPELINE_STAGES,
  runArtifactPipeline,
  type PipelineInput,
  type PipelineResult,
  type PipelineStage,
  type PipelineStageResult,
} from './pipelineWorkflow'

const ASSERTION_STAGE: PipelineStage = {
  key: 'assertion_checker',
  label: 'Assertion Checker',
  prompt: `
      <System_Role>
    You are a Senior Software Quality Architect and Formal Verification Specialist. Your expertise is in Semantic Gap Analysis and Test Oracle Adequacy. You evaluate whether a test suite truly proves the behavioral integrity of a requirement.
    </System_Role>

    <Objective>
    Analyze the provided Traceability Link. Determine if the Test Code serves as a "Strong Oracle" for the Requirement intent. If a gap exists, formulate a hypothesis for the missing verification logic.
    </Objective>

    <Few_Shot_Anchors>
    <Example_Weak_Oracle>
    Req: "System must throw 'InvalidDataException' if input is null."
    Code: "public void testNull() { system.process(null); }"
    Verdict: Gap (Missing Oracle). 
    Reasoning: The test executes the path but lacks an assertion or exception check. It only proves the code is "runnable," not "correct."
    </Example_Weak_Oracle>

    <Example_Strong_Oracle>
    Req: "Discount must not exceed 20%."
    Code: "public void testDiscount() { double d = getDiscount(); assertTrue(d <= 0.20); }"
    Verdict: Verified (Strong). 
    Reasoning: The test targets the specific functional constraint and asserts the exact boundary defined in the requirement.
    </Example_Strong_Oracle>
    </Few_Shot_Anchors>

    <Input_Artifacts>
    <Traceability_Link>{Input_From_Mapper_JSON}</Traceability_Link>
    <Requirement_Context>{Requirement_Text}</Requirement_Context>
    <Target_Implementation>{Method_Under_Test_Code}</Target_Implementation>
    <Existing_Test_Code>{Linked_Test_Code}</Existing_Test_Code>
    </Input_Artifacts>

    <Audit_Protocol>
    1. Extract Intended Behavior: Based on the Requirement, what is the expected outcome (state, return, or exception)?
    2. Extract Implemented Behavior: Based on the Target Implementation, what logic is actually executed?
    3. Oracle Strength Audit (CCS Model): 
      - [Check]: Is there an assertion linked to this specific intent?
      - [Correct]: Does it verify the requirement's outcome accurately?
      -: Does it check the variables that would reveal a failure in this logic?
    4. Gap Categorization: 
      - [Verified]: Assertion is strong and correct.
      - [Missing Oracle]: Path is executed, but no assertion validates the requirement.
      -: No part of the test code exercises this requirement.
    </Audit_Protocol>

    <Output_Contract>
    <Format_1_Human_Readable>

    | Req ID | Test ID | Verification Status | Oracle Strength | Reasoning | Missing Logic Description |
    </Format_1_Human_Readable>

    <Format_2_Machine_Readable_For_Repair_Loop>
    Provide a JSON object for the Orchestrator/Repair Agent:
    {
      "req_id": "string",
      "test_id": "string",
      "status": "Verified | Missing_Oracle | Missing_Scenario",
      "ccs_score": { "check": "bool", "correct": "bool", "strong": "bool" },
      "hypothesis_assertion": "string (the draft assert code to be tested in sandbox)",
      "context_hunk": "string (relevant logic from the MUT)"
    }
    </Format_2_Machine_Readable_For_Repair_Loop>
    </Output_Contract>
  `,
}

export const ASSERTION_PIPELINE_STAGES: PipelineStage[] = [
  ...PIPELINE_STAGES,
  ASSERTION_STAGE,
]

const stripCodeFence = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
}

const toJsonStringIfPossible = (value: string) => {
  const normalized = stripCodeFence(value)
  const parse = (input: string) => {
    try {
      return JSON.parse(input) as unknown
    } catch {
      return null
    }
  }

  const direct = parse(normalized)
  if (direct !== null) {
    return JSON.stringify(direct, null, 2)
  }

  const startObj = normalized.indexOf('{')
  const startArr = normalized.indexOf('[')
  let start = -1
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr)
  else if (startObj >= 0) start = startObj
  else if (startArr >= 0) start = startArr

  if (start < 0) return normalized

  const end = Math.max(normalized.lastIndexOf('}'), normalized.lastIndexOf(']'))
  if (end <= start) return normalized

  const candidate = normalized.slice(start, end + 1)
  const parsed = parse(candidate)
  if (parsed === null) return normalized
  return JSON.stringify(parsed, null, 2)
}

const buildAssertionPrompt = (traceabilityOutput: string) => {
  return `${ASSERTION_STAGE.prompt}

Traceability mapper output JSON:
${toJsonStringIfPossible(traceabilityOutput)}`
}

const buildPdfPrompt = (stages: PipelineStageResult[]) => {
  const sections = stages
    .map((stage) => `### ${stage.label}\n${stage.outputText || 'No output generated.'}`)
    .join('\n\n')
  return `Assertion checker report.\n\n${sections}`
}

export const runAssertionCheckerPipeline = async ({
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

  const traceabilityResult = await runArtifactPipeline({
    files,
    mode,
    model,
    previous,
    signal,
    onStageChange,
  })

  const traceabilityStageOutput =
    traceabilityResult.stages.find((stage) => stage.key === 'requirements')?.outputText ??
    traceabilityResult.stages.map((stage) => stage.outputText).join('\n')

  const fileInputs = await Promise.all(files.map((file) => fileToInlinePart(file)))
  onStageChange?.(ASSERTION_STAGE)

  const response = await generateContent({
    model,
      contents: [
        {
          role: 'user',
          parts: [{ text: buildAssertionPrompt(traceabilityStageOutput) }, ...fileInputs],
        },
      ],
    generationConfig: {
      responseMimeType: 'application/json',
    },
    signal,
  })

  const assertionStageResult: PipelineStageResult = {
    ...ASSERTION_STAGE,
    outputText: extractTextFromGemini(response),
    raw: response,
  }

  const stages: PipelineStageResult[] = [
    ...traceabilityResult.stages,
    assertionStageResult,
  ]

  const pdfPrompt = buildPdfPrompt(stages)
  const pdfBlob = await createPdfFromText(pdfPrompt)

  return {
    stages,
    pdf: {
      blob: pdfBlob,
      fileId: 'local',
    },
  }
}
