import type {
  JsonPatchDocument,
  RepairAgentAdapter,
  RepairAttemptRecord,
  RepairContextSegment,
  RepairLoopInput,
  RepairLoopProgressEvent,
  RepairLoopResult,
  SandboxAdapter,
  TestRunnerAdapter,
} from './types'

type OrchestratorOptions = {
  signal?: AbortSignal
  onProgress?: (event: RepairLoopProgressEvent) => void
}

type MiddlewareOrchestratorConfig = {
  repairAgent: RepairAgentAdapter
  sandbox: SandboxAdapter
  testRunner: TestRunnerAdapter
  maxIterations?: number
  baseTemperature?: number
  temperatureStep?: number
  maxTemperature?: number
  runIdFactory?: () => string
}

const defaultRunIdFactory = () =>
  `repair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const emit = (
  onProgress: OrchestratorOptions['onProgress'],
  event: RepairLoopProgressEvent
) => {
  onProgress?.(event)
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError')
  }
}

const asNonEmpty = (value: string, label: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`Missing required repair context field "${label}".`)
  }
  return trimmed
}

const sanitizeContext = (context: RepairContextSegment): RepairContextSegment => ({
  requirementId: asNonEmpty(context.requirementId, 'requirementId'),
  testId: asNonEmpty(context.testId, 'testId'),
  intent: asNonEmpty(context.intent, 'intent'),
  contextHunk: asNonEmpty(context.contextHunk, 'contextHunk'),
  hypothesisAssertion: context.hypothesisAssertion?.trim() || null,
  traceabilityLink: context.traceabilityLink,
})

const extractAssertionCandidateFromPatch = (patch: JsonPatchDocument) => {
  for (const operation of patch) {
    if (!('value' in operation)) continue
    const candidate = operation.value
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (!trimmed) continue
    if (/assert|expect|verify|should/i.test(trimmed)) return trimmed
  }
  return null
}

export class MiddlewareOrchestrator {
  private readonly repairAgent: RepairAgentAdapter
  private readonly sandbox: SandboxAdapter
  private readonly testRunner: TestRunnerAdapter
  private readonly maxIterations: number
  private readonly baseTemperature: number
  private readonly temperatureStep: number
  private readonly maxTemperature: number
  private readonly runIdFactory: () => string

  constructor({
    repairAgent,
    sandbox,
    testRunner,
    maxIterations = 3,
    baseTemperature = 0,
    temperatureStep = 0.1,
    maxTemperature = 0.7,
    runIdFactory = defaultRunIdFactory,
  }: MiddlewareOrchestratorConfig) {
    this.repairAgent = repairAgent
    this.sandbox = sandbox
    this.testRunner = testRunner
    this.maxIterations = Math.max(1, maxIterations)
    this.baseTemperature = Math.max(0, baseTemperature)
    this.temperatureStep = Math.max(0, temperatureStep)
    this.maxTemperature = Math.max(this.baseTemperature, maxTemperature)
    this.runIdFactory = runIdFactory
  }

  private getTemperatureForAttempt(attempt: number) {
    const temperature = this.baseTemperature + (attempt - 1) * this.temperatureStep
    return Math.min(this.maxTemperature, Number(temperature.toFixed(2)))
  }

  async run(input: RepairLoopInput, options: OrchestratorOptions = {}): Promise<RepairLoopResult> {
    const runId = this.runIdFactory()
    const context = sanitizeContext(input.context)
    const attempts: RepairAttemptRecord[] = []
    let previousStackTrace: string | null = null
    let lastFailedAssertion: string | null = context.hypothesisAssertion ?? null
    let previousPatch: RepairAttemptRecord['patch'] | null = null

    for (let attempt = 1; attempt <= this.maxIterations; attempt += 1) {
      throwIfAborted(options.signal)
      const temperature = this.getTemperatureForAttempt(attempt)

      emit(options.onProgress, {
        runId,
        attempt,
        stage: attempt === 1 ? 'repair_agent' : 'repair_refinement',
        message:
          attempt === 1
            ? 'Generating initial repair patch from segmented requirement/test context.'
            : 'Refining repair patch using latest stack trace.',
      })

      const agentResult = await this.repairAgent.proposePatch({
        runId,
        attempt,
        temperature,
        context,
        faultEvidence: {
          lastFailedAssertion,
          stackTrace: previousStackTrace,
        },
        previousPatch,
        history: attempts,
        metadata: input.metadata,
        signal: options.signal,
      })

      if (!agentResult.patch?.length) {
        throw new Error(`Repair agent returned an empty JSON patch on attempt ${attempt}.`)
      }

      emit(options.onProgress, {
        runId,
        attempt,
        stage: 'json_patch',
        message: `JSON patch generated with ${agentResult.patch.length} operation(s).`,
      })

      emit(options.onProgress, {
        runId,
        attempt,
        stage: 'docker_sandbox',
        message: 'Applying JSON patch in Docker sandbox.',
      })

      const sandboxResult = await this.sandbox.applyPatch({
        runId,
        attempt,
        patch: agentResult.patch,
        metadata: input.metadata,
        signal: options.signal,
      })

      emit(options.onProgress, {
        runId,
        attempt,
        stage: 'test_runner',
        message: 'Running test suite after patch application.',
      })

      const testResult = await this.testRunner.runTests({
        runId,
        attempt,
        metadata: input.metadata,
        signal: options.signal,
      })

      const stackTrace = testResult.stackTrace?.trim()
      const summary = testResult.summary.trim() || 'No test summary returned.'

      attempts.push({
        attempt,
        temperature,
        patch: agentResult.patch,
        agentReasoning: agentResult.reasoning ?? null,
        sandboxApplied: sandboxResult.applied,
        testPassed: testResult.passed,
        testSummary: summary,
        stackTrace: stackTrace || null,
      })

      if (testResult.passed) {
        return {
          runId,
          status: 'fixed',
          attempts,
          finalStackTrace: null,
        }
      }

      lastFailedAssertion = extractAssertionCandidateFromPatch(agentResult.patch) || lastFailedAssertion
      previousStackTrace = stackTrace || summary
      previousPatch = agentResult.patch
    }

    return {
      runId,
      status: 'high_complexity',
      attempts,
      finalStackTrace: previousStackTrace,
    }
  }
}
