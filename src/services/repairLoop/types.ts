export type JsonPatchOperation =
  | {
      op: 'add' | 'replace' | 'test'
      path: string
      value: unknown
    }
  | {
      op: 'remove'
      path: string
    }
  | {
      op: 'move' | 'copy'
      from: string
      path: string
    }

export type JsonPatchDocument = JsonPatchOperation[]

export type RepairFaultEvidence = {
  lastFailedAssertion: string | null
  stackTrace: string | null
}

export type RepairContextSegment = {
  requirementId: string
  testId: string
  intent: string
  contextHunk: string
  hypothesisAssertion?: string | null
  traceabilityLink?: unknown
}

export type RepairLoopStage =
  | 'repair_agent'
  | 'json_patch'
  | 'docker_sandbox'
  | 'test_runner'
  | 'repair_refinement'

export type RepairLoopProgressEvent = {
  runId: string
  attempt: number
  stage: RepairLoopStage
  message: string
}

export type RepairLoopInput = {
  context: RepairContextSegment
  metadata?: Record<string, unknown>
}

export type RepairAttemptRecord = {
  attempt: number
  temperature: number
  patch: JsonPatchDocument
  agentReasoning: string | null
  sandboxApplied: boolean
  testPassed: boolean
  testSummary: string
  stackTrace: string | null
}

export type RepairLoopResult = {
  runId: string
  status: 'fixed' | 'high_complexity'
  attempts: RepairAttemptRecord[]
  finalStackTrace: string | null
}

export type RepairAgentRequest = {
  runId: string
  attempt: number
  temperature: number
  context: RepairContextSegment
  faultEvidence: RepairFaultEvidence
  previousPatch: JsonPatchDocument | null
  history: RepairAttemptRecord[]
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}

export type RepairAgentResponse = {
  patch: JsonPatchDocument
  reasoning?: string | null
  raw?: unknown
}

export type SandboxApplyRequest = {
  runId: string
  attempt: number
  patch: JsonPatchDocument
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}

export type SandboxApplyResponse = {
  applied: boolean
  summary?: string
  raw?: unknown
}

export type TestRunnerRequest = {
  runId: string
  attempt: number
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}

export type TestRunnerResponse =
  | {
      passed: true
      summary: string
      stackTrace?: null
      raw?: unknown
    }
  | {
      passed: false
      summary: string
      stackTrace: string
      raw?: unknown
    }

export interface RepairAgentAdapter {
  proposePatch(input: RepairAgentRequest): Promise<RepairAgentResponse>
}

export interface SandboxAdapter {
  applyPatch(input: SandboxApplyRequest): Promise<SandboxApplyResponse>
}

export interface TestRunnerAdapter {
  runTests(input: TestRunnerRequest): Promise<TestRunnerResponse>
}
