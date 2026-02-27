import type {
  JsonPatchDocument,
  JsonPatchOperation,
  RepairAgentRequest,
  RepairAgentResponse,
  RepairAttemptRecord,
  RepairContextSegment,
  RepairFaultEvidence,
} from './types'

type RepairAgentHistoryContract = {
  attempt: number
  temperature: number
  test_passed: boolean
  test_summary: string
  stack_trace: string | null
}

export type RepairAgentContractRequest = {
  run_id: string
  attempt: number
  temperature: number
  input: {
    requirement_id: string
    test_id: string
    intent: string
    context_hunk: string
    hypothesis_assertion: string | null
    traceability_link?: unknown
  }
  fault_evidence: {
    last_failed_assertion: string | null
    stack_trace: string | null
  }
  previous_patch: JsonPatchDocument | null
  history: RepairAgentHistoryContract[]
  metadata?: Record<string, unknown>
}

type RepairAgentContractResponse = {
  patch: JsonPatchDocument
  reasoning?: string | null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asTrimmedString = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Repair agent contract requires non-empty "${label}".`)
  }
  return value.trim()
}

const asNullableTrimmedString = (value: unknown) => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

const assertPatchOperation = (value: unknown, index: number): JsonPatchOperation => {
  if (!isObject(value)) {
    throw new Error(`Invalid JSON patch operation at index ${index}: not an object.`)
  }

  const op = value.op
  if (typeof op !== 'string') {
    throw new Error(`Invalid JSON patch operation at index ${index}: missing "op".`)
  }

  if (op === 'add' || op === 'replace' || op === 'test') {
    const path = value.path
    if (typeof path !== 'string' || !path.trim()) {
      throw new Error(`Invalid JSON patch operation at index ${index}: missing "path".`)
    }
    return { op, path, value: value.value }
  }

  if (op === 'remove') {
    const path = value.path
    if (typeof path !== 'string' || !path.trim()) {
      throw new Error(`Invalid JSON patch operation at index ${index}: missing "path".`)
    }
    return { op, path }
  }

  if (op === 'move' || op === 'copy') {
    const path = value.path
    const from = value.from
    if (typeof path !== 'string' || !path.trim() || typeof from !== 'string' || !from.trim()) {
      throw new Error(`Invalid JSON patch operation at index ${index}: requires "from" and "path".`)
    }
    return { op, from, path }
  }

  throw new Error(`Unsupported JSON patch op "${op}" at index ${index}.`)
}

export const validateJsonPatchDocument = (value: unknown): JsonPatchDocument => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Repair agent must return a non-empty JSON patch array.')
  }
  return value.map((entry, index) => assertPatchOperation(entry, index))
}

const toHistoryContract = (history: RepairAttemptRecord[]): RepairAgentHistoryContract[] =>
  history.map((attempt) => ({
    attempt: attempt.attempt,
    temperature: attempt.temperature,
    test_passed: attempt.testPassed,
    test_summary: attempt.testSummary,
    stack_trace: attempt.stackTrace,
  }))

const sanitizeContext = (context: RepairContextSegment): RepairContextSegment => ({
  requirementId: asTrimmedString(context.requirementId, 'context.requirementId'),
  testId: asTrimmedString(context.testId, 'context.testId'),
  intent: asTrimmedString(context.intent, 'context.intent'),
  contextHunk: asTrimmedString(context.contextHunk, 'context.contextHunk'),
  hypothesisAssertion: asNullableTrimmedString(context.hypothesisAssertion),
  traceabilityLink: context.traceabilityLink,
})

const sanitizeFaultEvidence = (faultEvidence: RepairFaultEvidence): RepairFaultEvidence => ({
  lastFailedAssertion: asNullableTrimmedString(faultEvidence.lastFailedAssertion),
  stackTrace: asNullableTrimmedString(faultEvidence.stackTrace),
})

export const toRepairAgentContractRequest = (
  input: RepairAgentRequest
): RepairAgentContractRequest => {
  const context = sanitizeContext(input.context)
  const faultEvidence = sanitizeFaultEvidence(input.faultEvidence)

  return {
    run_id: asTrimmedString(input.runId, 'runId'),
    attempt: input.attempt,
    temperature: input.temperature,
    input: {
      requirement_id: context.requirementId,
      test_id: context.testId,
      intent: context.intent,
      context_hunk: context.contextHunk,
      hypothesis_assertion: context.hypothesisAssertion ?? null,
      traceability_link: context.traceabilityLink,
    },
    fault_evidence: {
      last_failed_assertion: faultEvidence.lastFailedAssertion ?? null,
      stack_trace: faultEvidence.stackTrace ?? null,
    },
    previous_patch: input.previousPatch,
    history: toHistoryContract(input.history),
    metadata: input.metadata,
  }
}

export const fromRepairAgentContractResponse = (
  value: unknown
): RepairAgentResponse => {
  if (!isObject(value)) {
    throw new Error('Repair agent response must be a JSON object.')
  }

  const patch = validateJsonPatchDocument(value.patch)
  const reasoning = asNullableTrimmedString(value.reasoning)

  return {
    patch,
    reasoning,
    raw: value as RepairAgentContractResponse,
  }
}

