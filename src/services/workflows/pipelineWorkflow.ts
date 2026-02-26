import { extractTextFromGemini, fileToInlinePart, generateContent } from '../gemini/content'
import { createPdfFromText } from '../pdf/pdfBuilder'

export type PipelineMode = 'start' | 'rerun' | 'continue'

export type PipelineStageKey =
  | 'requirements'
  | 'tests'
  | 'queries'
  | 'assertion_checker'

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
    label: 'Traceability Mapper',
    prompt: `
            <System_Role>
        You are a Senior Software Traceability Architect operating as a deterministic logic engine. Your expertise is in Forward Traceability Link Recovery (TLR). You bridge the semantic gap between Natural Language (NL) requirements and Programming Language (PL) artifacts by analyzing functional intent rather than syntactic overlap.
        </System_Role>

        <Objective>
        Establish a Forward Traceability Matrix mapping the provided Requirements to their intended verification logic in the Test Code. Every requirement must be either [Mapped], [Orphaned], or flagged as.
        </Objective>

        <Few_Shot_Anchors>
        <Example_Valid>
        Req: "System must lock account after 5 failed login attempts."
        Code: "public void testLockout() { for(int i=0; i<5; i++) { login('wrong'); } assert(account.isLocked()); }"
        Verdict: Direct. 
        Reasoning: The test explicitly iterates to the threshold (5) and asserts the specific outcome (account locked) defined in the requirement.
        </Example_Valid>

        <Example_Invalid>
        Req: "The user shall receive an email confirmation after registration."
        Code: "public void testUserCreation() { User u = new User('name'); assertNotNull(u); }"
        Verdict: None. 
        Reasoning: While the test creates a user, it contains no logic or assertions related to email transmission or receipt.
        </Example_Invalid>
        </Few_Shot_Anchors>

        <Input_Artifacts>
        <Requirement_Text>{Input_Requirements}</Requirement_Text>
        <Test_Suite_Schema>{Input_Test_Suite_Metadata}</Test_Suite_Schema>
        <Test_Code_Hunks>{Input_Test_Code}</Test_Code_Hunks>
        </Input_Artifacts>

        <Reasoning_Protocol>
        For every requirement, execute these steps sequentially without skipping:
        1. Intent Extraction: Identify the core business rule, state transition, or constraint.
        2. Behavioral Mapping: Analyze the Test Code’s execution path. Does it exercise the specific logic identified in Step 1?
        3. Semantic Validation: Confirm the link is based on functional intent. Do not establish links based on shared keywords (e.g., "login") if the behaviors differ.
        4. Abstain & Validate (Confidence Filter): 
          - If the Requirement is "Smelly" (ambiguous or lacks testable criteria), label as.
          - If the Test Code is too generic to confirm a match, label as [Low Confidence].
          - If neither condition applies, proceed to Classification.
        </Reasoning_Protocol>

        <Link_Classification_Schema>
        - Direct: Test explicitly verifies the requirement's primary behavior.
        - Indirect: Test verifies a dependency or side-effect of the requirement.
        - Ambiguous/Smelly: Requirement is poorly defined or un-testable.
        - None: No logical connection exists.
        </Link_Classification_Schema>

        <Output_Contract>
        <Format_1_Human_Readable>
        Provide a Markdown table with the following columns:

        | Req ID | Test Case ID | Status | Confidence (0-1) | Reasoning (Evidence-backed) | Missing Info (If Smelly) |
        </Format_1_Human_Readable>

        <Format_2_Machine_Readable>
        Provide a strict JSON array matching this schema for the Assertion Checker Agent:
        ,
            "is_smelly": "boolean",
            "missing_info": "string | null"
          }
        ]
        </Format_2_Machine_Readable>
        </Output_Contract>
  `,
  },
]

const buildStagePrompt = (base: string) => {
  return base
}

const buildPdfPrompt = (stages: PipelineStageResult[]) => {
  const sections = stages
    .map((stage) => `### ${stage.label}\n${stage.outputText || 'No output generated.'}`)
    .join('\n\n')
  return `Requirements and traceability report.\n\n${sections}`
}

export const runArtifactPipeline = async ({
  files,
  mode: _mode = 'start',
  model,
  previous: _previous,
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
    const prompt = buildStagePrompt(stage.prompt)
    const response = await generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, ...fileInputs],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
      },
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
