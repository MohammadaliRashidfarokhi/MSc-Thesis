import express from 'express'
import cors from 'cors'
import path from 'path'
import { runRepairLoopForHypothesis } from './orchestrator/repairLoop.js'
import { generateCandidateTestCode } from './orchestrator/llmGenerator.js'

const app = express()
const port = Number(process.env.PORT ?? 8787)
const orchestratorRuns = new Map()

app.use(cors())
app.use(express.json({ limit: '10mb' }))

const normalizeToken = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const pickFirst = (row, keys) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }

  const entries = Object.entries(row)
  for (const key of keys) {
    const normalizedKey = normalizeToken(key)
    const match = entries.find(([entryKey]) => normalizeToken(entryKey) === normalizedKey)
    if (!match) continue
    const value = match[1]
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }

  return null
}

const toStringValue = (value, fallback = '-') => {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

const extractRows = (payload) => {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const candidates = [
    payload.rows,
    payload.requirements,
    payload.data,
    payload.traceability,
    payload.traceability_links,
    payload.links,
  ]
  for (const entry of candidates) {
    if (Array.isArray(entry) && entry.length > 0) return entry
  }
  return []
}

const resolveRepoRoot = (repoRootInput) => {
  if (typeof repoRootInput === 'string' && repoRootInput.trim()) {
    return path.resolve(repoRootInput.trim())
  }
  const cwd = process.cwd()
  if (path.basename(cwd) === 'backend') {
    return path.resolve(cwd, '..')
  }
  return cwd
}

const simulateTestRunner = (attempt) => {
  const shouldPass = Number(attempt ?? 1) >= 2
  if (shouldPass) {
    return {
      passed: true,
      summary: 'All tests passed (mock).',
      stackTrace: null,
    }
  }

  return {
    passed: false,
    summary: 'Tests failed (mock).',
    stackTrace:
      'AssertionError: expected user status to be ACTIVE but was PENDING at UserServiceTest.testActivation(UserServiceTest.java:42)',
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'multiagentsystem-backend',
    timestamp: new Date().toISOString(),
  })
})

app.post('/api/repair-agent/propose', (req, res) => {
  const body = req.body ?? {}
  const { run_id: runId, attempt, input, fault_evidence: faultEvidence } = body

  if (!input?.requirement_id || !input?.test_id || !input?.intent || !input?.context_hunk) {
    return res.status(400).json({
      message:
        'Invalid payload: input.requirement_id, input.test_id, input.intent, and input.context_hunk are required.',
    })
  }

  const candidateAssertion =
    input.hypothesis_assertion ??
    `assert requirement "${input.requirement_id}" is verified for "${input.test_id}"`

  const patch = [
    {
      op: 'replace',
      path: '/tests/0/assertion',
      value: candidateAssertion,
    },
  ]

  const reasoning = [
    `Attempt ${attempt ?? 1} for run ${runId ?? 'unknown'}.`,
    `Intent used: ${input.intent}`,
    faultEvidence?.stack_trace
      ? `Refined from stack trace: ${String(faultEvidence.stack_trace).slice(0, 240)}`
      : 'No stack trace provided yet; generated initial candidate assertion.',
  ].join(' ')

  return res.json({ patch, reasoning })
})

app.post('/api/sandbox/apply-patch', (req, res) => {
  const { patch } = req.body ?? {}
  if (!Array.isArray(patch) || patch.length === 0) {
    return res.status(400).json({ message: 'Invalid payload: non-empty patch array is required.' })
  }

  return res.json({
    applied: true,
    summary: `Applied ${patch.length} patch operation(s) in sandbox (mock).`,
  })
})

app.post('/api/assertion-checker/strengthen', (req, res) => {
  const {
    requirement_id: requirementId,
    test_id: testId,
    status,
    reasoning,
    context_hunk: contextHunk,
    hypothesis_assertion: hypothesisAssertion,
  } = req.body ?? {}

  if (!requirementId || !testId) {
    return res.status(400).json({
      message: 'Invalid payload: requirement_id and test_id are required.',
    })
  }

  const normalizedStatus = String(status ?? '').trim()
  const noteParts = []

  if (!reasoning || String(reasoning).trim() === '-' || String(reasoning).trim() === '') {
    noteParts.push('Reasoning is weak or missing.')
  }
  if (!contextHunk || String(contextHunk).trim().startsWith('No explicit method hunk provided')) {
    noteParts.push('Method context hunk is missing.')
  }
  if (!hypothesisAssertion) {
    noteParts.push('No draft hypothesis assertion provided.')
  }

  let strengthenedStatus = normalizedStatus || 'Ambiguous'
  if (normalizedStatus.toLowerCase() === 'missing_oracle' && noteParts.length === 0) {
    strengthenedStatus = 'Missing_Oracle'
  }

  const confidence = noteParts.length === 0 ? 0.95 : 0.65

  return res.json({
    requirement_id: requirementId,
    test_id: testId,
    status: strengthenedStatus,
    confidence,
    note: noteParts.length ? noteParts.join(' ') : 'Assertion checker output is internally consistent.',
  })
})

app.post('/api/orchestrator/intake-assertion-report', (req, res) => {
  const report = req.body?.assertion_report
  if (!report) {
    return res.status(400).json({
      message: 'Invalid payload: assertion_report is required.',
    })
  }

  const rows = extractRows(report)
  if (!rows.length) {
    return res.status(400).json({
      message: 'Invalid payload: assertion_report must include at least one row.',
    })
  }

  const hypotheses = rows
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const requirementId = toStringValue(
        pickFirst(entry, ['req_id', 'requirement_id', 'requirementId', 'id']),
        '-'
      )
      const testId = toStringValue(
        pickFirst(entry, ['test_id', 'testId', 'test_case_id', 'testCaseId', 'tc_id']),
        '-'
      )
      const status = toStringValue(pickFirst(entry, ['status', 'verification_status']), 'Ambiguous')
      const normalizedStatus = normalizeToken(status)

      if (requirementId === '-' || testId === '-') return null
      if (normalizedStatus === 'verified' || normalizedStatus === 'covered') return null

      return {
        hypothesis_id: `H-${index + 1}`,
        requirement_id: requirementId,
        test_id: testId,
        status,
        reasoning: toStringValue(pickFirst(entry, ['reasoning', 'summary']), '-'),
        context_hunk: toStringValue(
          pickFirst(entry, ['context_hunk', 'contextHunk', 'method_under_test_code']),
          '-'
        ),
        hypothesis_assertion: toStringValue(
          pickFirst(entry, ['hypothesis_assertion', 'hypothesisAssertion']),
          '-'
        ),
      }
    })
    .filter(Boolean)

  const orchestratorRunId = `orchestrator-${Date.now()}`
  const receivedAt = new Date().toISOString()

  orchestratorRuns.set(orchestratorRunId, {
    orchestrator_run_id: orchestratorRunId,
    received_at: receivedAt,
    assertion_report: report,
    hypotheses,
    status: 'queued',
  })

  return res.json({
    orchestrator_run_id: orchestratorRunId,
    received_at: receivedAt,
    report_rows: rows.length,
    queued_hypotheses: hypotheses.length,
    hypotheses,
    next_step: 'Middleware Bridge execution can now start per hypothesis.',
  })
})

app.post('/api/orchestrator/run-repair-loop', async (req, res) => {
  const {
    orchestrator_run_id: orchestratorRunId,
    repo_root: repoRootInput,
    max_attempts: maxAttempts,
    base_temperature: baseTemperature,
    temperature_step: temperatureStep,
    max_temperature: maxTemperature,
  } = req.body ?? {}

  if (!orchestratorRunId) {
    return res.status(400).json({
      message: 'Invalid payload: orchestrator_run_id is required.',
    })
  }

  const run = orchestratorRuns.get(orchestratorRunId)
  if (!run) {
    return res.status(404).json({
      message: `No orchestrator run found for id "${orchestratorRunId}".`,
    })
  }

  if (!Array.isArray(run.hypotheses) || run.hypotheses.length === 0) {
    return res.json({
      orchestrator_run_id: orchestratorRunId,
      status: 'completed',
      total_hypotheses: 0,
      closed: 0,
      high_complexity: 0,
      results: [],
    })
  }

  const repoRoot = resolveRepoRoot(repoRootInput)
  const results = []

  for (const hypothesis of run.hypotheses) {
    try {
      const result = await runRepairLoopForHypothesis({
        runId: orchestratorRunId,
        hypothesis,
        repoRoot,
        generateCandidate: async (input) => generateCandidateTestCode(input),
        executeTestRunner: async ({ attempt }) => simulateTestRunner(attempt),
        options: {
          maxAttempts,
          baseTemperature,
          temperatureStep,
          maxTemperature,
        },
      })
      results.push(result)
    } catch (error) {
      results.push({
        hypothesis_id: hypothesis.hypothesis_id,
        requirement_id: hypothesis.requirement_id,
        test_id: hypothesis.test_id,
        status: 'high_complexity',
        attempts: [],
        error: error instanceof Error ? error.message : 'Unknown repair-loop failure.',
      })
    }
  }

  const closed = results.filter((entry) => entry.status === 'closed').length
  const highComplexity = results.filter((entry) => entry.status === 'high_complexity').length

  orchestratorRuns.set(orchestratorRunId, {
    ...run,
    status: 'completed',
    completed_at: new Date().toISOString(),
    repo_root: repoRoot,
    results,
  })

  return res.json({
    orchestrator_run_id: orchestratorRunId,
    status: 'completed',
    repo_root: repoRoot,
    total_hypotheses: results.length,
    closed,
    high_complexity: highComplexity,
    results,
  })
})

app.post('/api/tests/run', (req, res) => {
  return res.json(simulateTestRunner(req.body?.attempt))
})

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend running on http://localhost:${port}`)
})
