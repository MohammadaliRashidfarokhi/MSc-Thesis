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
    You are a Senior Software Traceability Architect operating as a deterministic logic engine. Your expertise is in Forward Traceability Link Recovery (TLR) at sub-artifact granularity. You bridge the semantic gap between Natural Language (NL) requirement sentences and Programming Language (PL) test methods by analyzing functional intent rather than syntactic overlap.
    </System_Role>

    <Objective>
    Establish a Forward Traceability Matrix by mapping each atomic Requirement Sentence to the specific Test Methods intended to verify its logic. Every requirement must be classified as [Mapped], [Orphaned], or.
    </Objective>

    <Infrastructure_Constraints>
    - Temperature: 0.0 (Greedy Decoding)
    - Determinism: Process input artifacts in the exact sequential order provided by their IDs.
    - Granularity: Map individual requirement IDs to specific test method signatures.
    </Infrastructure_Constraints>

    <Few_Shot_Anchors>
    <Example_Valid_Direct>
    Req: REQ-EST-1.1: "The server shall lock an account after N consecutive failed authentication attempts."
    Code: @Test public void test_auth_failures_trigger_lockout() { for(int i=0; i<N; i++) { estAuthenticate("badUser","badPass"); } assertTrue(isAccountLocked("badUser")); }
    Verdict: Direct. 
    Reasoning: Functional alignment found. The test drives the exact state transition (failed attempts → lockout) and asserts the required outcome (locked) defined in REQ-EST-1.1.
    </Example_Valid_Direct>

    <Example_Valid_Indirect>
    Req: REQ-EST-2.0: "The server shall support re-enrollment by accepting a valid client certificate and returning a renewed certificate."
    Code: @Test public void test_reenroll_endpoint_exists_and_requires_client_cert() { HttpResponse r = post("/.well-known/est/simplereenroll", withClientCert(validCert)); assertEquals(200, r.status()); assertNotNull(r.body()); }
    Verdict: Indirect. 
    Reasoning: Dependency alignment. The test verifies the endpoint behavior and presence of a response body under client-cert conditions, but does not validate that the returned certificate is actually renewed relative to the prior certificate.
    </Example_Valid_Indirect>

    <Example_Invalid_None>
    Req: REQ-EST-3.5: "The server shall use TLS for all EST endpoints and reject non-TLS requests."
    Code: @Test public void test_csr_payload_is_parsed() { Csr csr = parseCsr(samplePem); assertNotNull(csr.getSubject()); }
    Verdict: None. 
    Reasoning: Semantic mismatch. The test verifies CSR parsing logic but contains no logic or assertions about transport security, TLS negotiation, or rejection of non-TLS requests.
    </Example_Invalid_None>
    </Few_Shot_Anchors>

    <Input_Artifacts>
    <Requirement_Set_NL>{Input_LibEST_Requirements_NL}</Requirement_Set_NL>
    <Test_Suite_Schema>{Input_LibEST_Test_Suite_Metadata}</Test_Suite_Schema>
    <Test_Code_Methods_PL>{Input_LibEST_Test_Code_Methods_PL}</Test_Code_Methods_PL>
    </Input_Artifacts>

    <Reasoning_Protocol>
    For every requirement, execute these four steps sequentially:
    1. Intent Extraction: Identify the core behavioral constraint, state transition, or business rule.
    2. Behavioral Mapping: Analyze the specific Test Method's execution path. Does it exercise the logic from Step 1?
    3. Semantic Validation: Confirm the link is based on intent. CRITICAL: Reject links based on shared keywords (e.g., "login") if the implemented behavior differs from the requirement.
    4. Confidence Filtering (Abstain & Backtrack): 
      - If the Requirement is "Smelly" (ambiguous/untestable), label as.
      - If Test Code is too generic to confirm a match, label as [Low Confidence].
      - If confidence is < 0.8, add a "Request_Context" tag specifying what missing code hunk would resolve the link.
    </Reasoning_Protocol>

    <Link_Classification_Schema>
    - Direct: Test explicitly verifies the requirement's primary behavior.
    - Indirect: Test verifies a side-effect or dependency of the requirement.
    - Ambiguous/Smelly: Requirement is poorly defined or un-testable.
    - None: No logical connection exists.
    </Link_Classification_Schema>

    <Output_Contract>
    <Format_1_Human_Readable>
    Provide a Markdown table:

    | Req ID | Test Method | Status | Confidence | Reasoning (Literal Evidence) | Backtrack (Missing Info) |
    | :--- | :--- | :--- | :--- | :--- | :--- |
    </Format_1_Human_Readable>

    <Format_2_Machine_Readable>
    Provide a strict JSON array for the Assertion Checker Agent:
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
