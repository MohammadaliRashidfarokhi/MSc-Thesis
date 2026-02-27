const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ??
  process.env.VITE_GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta'

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ??
  process.env.VITE_GEMINI_MODEL ??
  'gemini-2.5-flash'

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ??
  process.env.VITE_GEMINI_API_KEY ??
  process.env.VITE_OPENAI_API_KEY ??
  ''

const ensureGeminiConfig = () => {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'Missing GEMINI_API_KEY (or VITE_GEMINI_API_KEY) for orchestrator LLM generation.'
    )
  }
}

const stripCodeFence = (value) => {
  const trimmed = String(value ?? '').trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
}

const parseJsonLoose = (value) => {
  const normalized = stripCodeFence(value)
  const direct = (() => {
    try {
      return JSON.parse(normalized)
    } catch {
      return null
    }
  })()
  if (direct) return direct

  const startObj = normalized.indexOf('{')
  const startArr = normalized.indexOf('[')
  let start = -1
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr)
  else if (startObj >= 0) start = startObj
  else if (startArr >= 0) start = startArr
  if (start < 0) return null

  const end = Math.max(normalized.lastIndexOf('}'), normalized.lastIndexOf(']'))
  if (end <= start) return null

  try {
    return JSON.parse(normalized.slice(start, end + 1))
  } catch {
    return null
  }
}

const extractText = (response) => {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : []
  const parts = candidates.flatMap((candidate) =>
    Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  )
  return parts.map((part) => part?.text ?? '').join('\n').trim()
}

const buildPrompt = ({
  hypothesis,
  contexts,
  attempt,
  temperature,
  previousStackTrace,
}) => {
  const contextText =
    contexts.length > 0
      ? contexts
          .map(
            (entry) =>
              `File: ${entry.file_path}\nSnippet:\n${entry.snippet || '// empty snippet'}`
          )
          .join('\n\n---\n\n')
      : 'No existing test context was found in local repository scan.'

  return `<System_Role>
You are a Senior Test Automation Engineer specializing in Behavioral-Driven Development (BDD) and Formal Property Verification. Your expertise lies in synthesizing "Strong Oracles" that verify the semantic intent of requirements rather than just code execution paths.
</System_Role>

<Objective>
Generate targeted test code (PL) to close the specific Semantic Gap identified by the Gap Analyzer. Your output must be a self-contained test method that exercises the "Intended Behavior" and includes assertions matching the CCS (Check, Correct, Strong) property model.
</Objective>

<Infrastructure_Constraints>
- Temperature: 0.0 (Deterministic Synthesis)
- Target Language: {Target_Language}
- Test Framework: {Test_Framework} (e.g., JUnit 5, Pytest)
- Isolation: Assume the test will run in a secure Docker sandbox.
</Infrastructure_Constraints>

<Few_Shot_Anchors>
<Example_Gap_Filling>
Gap_Report: "REQ-2.1 (Account Lockout) is executed but the 'locked' status variable is never asserted."
Source_Context: "public void login(String p) { attempts++; if(attempts >= 5) this.locked = true; }"
Generated_Test: 
@Test
void testAccountLockoutThreshold() {
    Account acc = new Account();
    for(int i=0; i<5; i++) { acc.login("wrong"); }
    assertTrue(acc.isLocked(), "Account must be locked after 5 failed attempts.");
}
</Example_Valid>
</Few_Shot_Anchors>

<Input_Artifacts>
<Requirement_Intent_NL>{Requirement_Text}</Requirement_Intent_NL>
<Gap_Report_Diagnosis>{Gap_Analyzer_JSON}</Gap_Analyzer_JSON>
<Target_Implementation_Hunk>{Method_Under_Test_Code}</Target_Implementation_Hunk>
<Test_Suite_Patterns>{Metadata_Existing_Test_Styles}</Test_Suite_Patterns>
</Input_Artifacts>

<Synthesis_Protocol>
Step 1: Intent Mapping. Extract the expected state change or return value from the Requirement_Intent_NL.
Step 2: Dependency Analysis. Identify required imports, mock objects, or setup states from the Target_Implementation_Hunk.
Step 3: Oracle Construction. Design a "Strong Oracle" assertion that validates the semantic outcome identified in Step 1. Avoid weak assertions (e.g., just checking if a return is not null).
Step 4: Style Alignment. Format the code to match the existing patterns in Test_Suite_Patterns.
</Synthesis_Protocol>

<Output_Contract>
Provide the result as a strict JSON object for the Orchestrator/Repair Loop:
{
  "req_id": "string",
  "generated_code": "string",
  "required_imports": ["string"],
  "test_setup_logic": "string",
  "oracle_type": "Axiomatic | Concrete",
  "confidence_score": "float (0-1)"
}
</Output_Contract>`
}

export const generateCandidateTestCode = async ({
  hypothesis,
  contexts,
  attempt,
  temperature,
  previousStackTrace,
}) => {
  ensureGeminiConfig()

  const prompt = buildPrompt({
    hypothesis,
    contexts,
    attempt,
    temperature,
    previousStackTrace,
  })

  const response = await fetch(`${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
      },
    }),
  })

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const data = await response.json()
      message = data?.error?.message ?? data?.message ?? message
    } catch {
      // no-op
    }
    throw new Error(`Orchestrator LLM generation failed: ${message}`)
  }

  const data = await response.json()
  const text = extractText(data)
  const parsed = parseJsonLoose(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Orchestrator LLM returned invalid JSON for candidate test code.')
  }

  const code =
    typeof parsed.candidate_test_code === 'string' && parsed.candidate_test_code.trim()
      ? parsed.candidate_test_code.trim()
      : ''

  if (!code) {
    throw new Error('Orchestrator LLM returned empty candidate_test_code.')
  }

  const reasoning =
    typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
      ? parsed.reasoning.trim()
      : 'No reasoning returned.'

  return {
    code,
    reasoning,
    raw: data,
  }
}

