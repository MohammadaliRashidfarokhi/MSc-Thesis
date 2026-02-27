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
        You are a Senior Software Quality Architect and Formal Verification Specialist. Your expertise is in Semantic Gap Analysis and Test Oracle Adequacy. You evaluate whether a test suite truly proves the behavioral integrity of a requirement using the CCS (Check, Correct, Strong) property model.
        </System_Role>

        <Objective>
        Audit the provided Traceability Link to determine if the Test Code serves as a "Strong Axiomatic Oracle" for the Requirement. Identify semantic gaps and generate a verifiable hypothesis for the missing assertion logic.
        </Objective>

        <Infrastructure_Constraints>
        - Temperature: 0.0 (Deterministic Grounding)
        - Processing Order: Requirements must be audited in the exact sequence provided by their IDs to eliminate order bias.
        - Granularity: Unit of analysis is the specific linked to the hunk.
        </Infrastructure_Constraints>

        <Few_Shot_Anchors>
        <Example_Strong_Oracle>
        Req: REQ-4.2: "The system must return a 401 Unauthorized if the API key is expired."
        Code: @Test void testExpired() { Response r = callApi(expiredKey); assertEquals(401, r.getStatus()); }
        Verdict: Verified (Strong). 
        Reasoning: Direct verification of the state transition. The assertion targets the exact status variable defined in the requirement.
        </Example_Strong_Oracle>

        <Example_Weak_Oracle>
        Req: REQ-5.0: "All successful transactions must be logged in the audit trail."
        Code: @Test void testTransaction() { service.execute(validTx); }
        Verdict: Gap (Missing Oracle). 
        Reasoning: Semantic disconnect. The test executes the code path (syntactic coverage) but lacks an assertion to check the audit log (semantic verification).
        </Example_Weak_Oracle>

        <Example_Hard_Negative_Mismatch>
        Req: REQ-1.2: "The system shall throw 'ValidationException' for negative inputs."
        Code: @Test void testNegative() { try { calc(-1); } catch (Exception e) { assertNotNull(e); } }
        Verdict: Gap (Incorrect Oracle). 
        Reasoning: Mismatch found. The test catches any generic Exception, whereas REQ-1.2 mandates a specific 'ValidationException'. The oracle is too broad to prove the requirement.
        </Example_Hard_Negative_Mismatch>
        </Few_Shot_Anchors>

        <Input_Artifacts>
        <Traceability_JSON>{Input_From_Mapper_JSON}</Traceability_JSON>
        <Requirement_Text>{Requirement_Text}</Requirement_Text>
        <Target_Implementation_Hunk>{Method_Under_Test_Code}</Target_Implementation_Hunk>
        <Linked_Test_Method>{Linked_Test_Code}</Linked_Test_Method>
        </Input_Artifacts>

        <Audit_Protocol>
        Step 1: Extract Intended Behavior. Identify the expected output, state change, or exception for this requirement.
        Step 2: Extract Implemented Behavior. Analyze the MUT hunk. What logic is actually executed for the given inputs?
        Step 3: Oracle Strength Audit (CCS Model):
            - [Check]: Is there a programmatic guard (assert/exception catch) for this intent?
            - [Correct]: Does the guard accurately distinguish success from failure for THIS rule?
            -: Is the assertion axiomatic (valid for the property) or just a concrete value check?
        Step 4: Gap Synthesis. If Status is [Gap], provide a specific "Hypothesis Assertion" intended for the Repair Loop's sandbox execution.
        </Audit_Protocol>

        <Output_Contract>
        <Format_1_Human_Readable>
        Provide a Markdown table:

        | Req ID | Test ID | Verification Status | CCS Score | Reasoning (Literal Evidence) | Gap Description |
        | :--- | :--- | :--- | :--- | :--- | :--- |
        </Format_1_Human_Readable>

        <Format_2_Machine_Readable_For_Orchestrator>
        Provide a strict JSON object to trigger Cycle 2 (Repair Loop):
        {
          "req_id": "string",
          "test_id": "string",
          "status": "Verified | Missing_Oracle | Missing_Scenario | Mismatch",
          "ccs_score": { "check": "bool", "correct": "bool", "strong": "bool" },
          "hypothesis_assertion": "string (the proposed assert statement to be validated)",
          "context_hunk": "string (relevant lines from MUT for the Repair Agent)"
        }
        </Format_2_Machine_Readable_For_Orchestrator>
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
