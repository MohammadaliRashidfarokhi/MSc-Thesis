import { collectExistingTestContexts } from './testSource.js'
import { saveGeneratedTestArtifact } from './artifacts.js'

const computeTemperature = ({ attempt, baseTemperature, step, maxTemperature }) => {
  const value = baseTemperature + (attempt - 1) * step
  return Math.min(maxTemperature, Number(value.toFixed(2)))
}

const buildFallbackCandidateCode = ({
  hypothesis,
  contexts,
  attempt,
  temperature,
  previousStackTrace,
}) => {
  const contextBlock =
    contexts.length > 0
      ? contexts.map((entry) => `// ${entry.file_path}\n${entry.snippet}`).join('\n\n')
      : '// No local test context was found.'

  const hypothesisAssertion =
    hypothesis.hypothesis_assertion && hypothesis.hypothesis_assertion !== '-'
      ? hypothesis.hypothesis_assertion
      : `assert semantic gap is closed for ${hypothesis.requirement_id}/${hypothesis.test_id}`

  return [
    `// Attempt ${attempt} | temperature=${temperature}`,
    `// Requirement: ${hypothesis.requirement_id}`,
    `// Test: ${hypothesis.test_id}`,
    `// Status: ${hypothesis.status}`,
    `// Reasoning: ${hypothesis.reasoning}`,
    previousStackTrace ? `// Previous stack trace: ${previousStackTrace}` : '// First attempt.',
    '',
    '// Existing test code context',
    contextBlock,
    '',
    '// Synthesized candidate assertion',
    hypothesisAssertion,
  ].join('\n')
}

export const runRepairLoopForHypothesis = async ({
  runId,
  hypothesis,
  repoRoot,
  generateCandidate,
  executeTestRunner,
  options = {},
}) => {
  const maxAttempts = Math.max(1, Number(options.maxAttempts ?? 3))
  const baseTemperature = Number(options.baseTemperature ?? 0.1)
  const temperatureStep = Number(options.temperatureStep ?? 0.15)
  const maxTemperature = Number(options.maxTemperature ?? 0.7)

  const existingContexts = await collectExistingTestContexts({
    repoRoot,
    testId: hypothesis.test_id,
  })

  const attempts = []
  let previousStackTrace = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const temperature = computeTemperature({
      attempt,
      baseTemperature,
      step: temperatureStep,
      maxTemperature,
    })

    let candidateCode = ''
    let generatorReasoning = 'Fallback candidate generator used.'

    if (typeof generateCandidate === 'function') {
      const generated = await generateCandidate({
        hypothesis,
        contexts: existingContexts,
        attempt,
        temperature,
        previousStackTrace,
      })
      candidateCode = generated.code
      generatorReasoning = generated.reasoning ?? generatorReasoning
    } else {
      candidateCode = buildFallbackCandidateCode({
        hypothesis,
        contexts: existingContexts,
        attempt,
        temperature,
        previousStackTrace,
      })
    }

    const artifactPath = await saveGeneratedTestArtifact({
      runId,
      hypothesisId: hypothesis.hypothesis_id,
      attempt,
      code: candidateCode,
    })

    const testResult = await executeTestRunner({
      runId,
      hypothesisId: hypothesis.hypothesis_id,
      attempt,
      temperature,
      artifactPath,
    })

    attempts.push({
      attempt,
      temperature,
      candidate_artifact_path: artifactPath,
      existing_context_files: existingContexts.map((entry) => entry.file_path),
      generator_reasoning: generatorReasoning,
      test_passed: Boolean(testResult.passed),
      test_summary: testResult.summary,
      stack_trace: testResult.stackTrace ?? null,
    })

    if (testResult.passed) {
      return {
        hypothesis_id: hypothesis.hypothesis_id,
        requirement_id: hypothesis.requirement_id,
        test_id: hypothesis.test_id,
        status: 'closed',
        attempts,
      }
    }

    previousStackTrace = testResult.stackTrace ?? testResult.summary
  }

  return {
    hypothesis_id: hypothesis.hypothesis_id,
    requirement_id: hypothesis.requirement_id,
    test_id: hypothesis.test_id,
    status: 'high_complexity',
    attempts,
  }
}
