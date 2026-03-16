import { useMemo, useRef, useState } from 'react'
import {
  PIPELINE_STAGES,
  runArtifactPipeline,
} from './services/workflows/pipelineWorkflow'
import type {
  PipelineMode,
  PipelineStage,
  PipelineStageResult,
} from './services/workflows/pipelineWorkflow'
import './App.css'

type SelectedFile = {
  id: string
  file: File
}

type JsonObject = Record<string, unknown>
type FinalOutputRow = {
  reqId: string
  testCaseId: string
  status: string
  confidence: string
  reasoning: string
  missingInfo: string
}

type MachineReportStage = {
  stage_key: string
  stage_label: string
  parse_status: 'ok' | 'parse_error'
  parse_error: string | null
  payload: unknown
  raw_output: string
}

type MachineReport = {
  generated_at: string
  total_stage_outputs: number
  total_final_rows: number
  stages: MachineReportStage[]
  final_output_rows: FinalOutputRow[]
}

const LIBEST_REQUIREMENT_MODULES = import.meta.glob('/src/dataset/req/*.txt', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const LIBEST_CODE_MODULES = import.meta.glob('/src/dataset/code/*.{c,h}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const fileNameFromPath = (filePath: string) => {
  const parts = filePath.split('/')
  return parts[parts.length - 1] || filePath
}

const createDatasetEntries = (): SelectedFile[] => {
  const entries: SelectedFile[] = []

  Object.entries(LIBEST_REQUIREMENT_MODULES)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([filePath, text]) => {
      entries.push({
        id: filePath,
        file: new File([String(text ?? '')], `req/${fileNameFromPath(filePath)}`, {
          type: 'text/plain',
        }),
      })
    })

  Object.entries(LIBEST_CODE_MODULES)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([filePath, content]) => {
      const fileName = fileNameFromPath(filePath)
      entries.push({
        id: filePath,
        file: new File([String(content ?? '')], `code/${fileName}`, {
          type: 'text/plain',
        }),
      })
    })

  return entries
}

const DATASET_ENTRIES = createDatasetEntries()
const DATASET_REQUIREMENT_COUNT = Object.keys(LIBEST_REQUIREMENT_MODULES).length
const DATASET_CODE_COUNT = Object.keys(LIBEST_CODE_MODULES).length

const FINAL_OUTPUT_FIELD_KEYS = {
  reqId: ['req_id', 'requirement_id', 'requirementId', 'id', 'Req ID'],
  testCaseId: [
    'test_case_id',
    'testCaseId',
    'test_id',
    'tc_id',
    'test_method',
    'test_method_id',
    'test_method_name',
    'Test Case ID',
  ],
  status: [
    'status',
    'link_status',
    'traceability_status',
    'mapping_status',
    'Link Status',
  ],
  confidence: [
    'confidence',
    'confidence_score',
    'score',
    'confidence (0-1)',
    'confidence_0_1',
    'confidence01',
  ],
  reasoning: [
    'reasoning',
    'evidence',
    'evidence_backed_reasoning',
    'summary',
    'source_text',
    'reasoning (evidence-backed)',
    'evidence-backed reasoning',
  ],
  missingInfo: [
    'missing_info',
    'missingInfo',
    'open_questions',
    'notes',
    'missing info',
    'missing info (if smelly)',
  ],
} as const

const normalizeLookupKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '')

const isEmptyCellValue = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  value === '-' ||
  value === 'N/A' ||
  value === 'n/a'

const pickDeepByNormalizedKeys = (row: JsonObject, keys: string[]) => {
  const target = new Set(keys.map((key) => normalizeLookupKey(key)))
  const visited = new Set<object>()
  const stack: unknown[] = [row]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue

    if (Array.isArray(current)) {
      current.forEach((entry) => stack.push(entry))
      continue
    }

    if (visited.has(current)) continue
    visited.add(current)

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      const normalized = normalizeLookupKey(key)
      if (target.has(normalized) && !isEmptyCellValue(value)) {
        return value
      }
    }

    for (const value of Object.values(current as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        stack.push(value)
      }
    }
  }

  return undefined
}

const pickFirst = (row: JsonObject, keys: string[]) => {
  for (const key of keys) {
    const value = row[key]
    if (!isEmptyCellValue(value)) {
      return value
    }
  }

  const normalizedRowEntries = Object.entries(row).reduce<Record<string, unknown>>(
    (acc, [key, value]) => {
      const normalized = normalizeLookupKey(key)
      if (normalized && acc[normalized] === undefined) {
        acc[normalized] = value
      }
      return acc
    },
    {}
  )

  for (const key of keys) {
    const normalized = normalizeLookupKey(key)
    const value = normalizedRowEntries[normalized]
    if (!isEmptyCellValue(value)) {
      return value
    }
  }

  const deepValue = pickDeepByNormalizedKeys(row, keys)
  if (!isEmptyCellValue(deepValue)) {
    return deepValue
  }

  return undefined
}

const extractRequirementsEntries = (payload: JsonObject) => {
  const candidates = [
    payload.requirements,
    payload.mappings,
    payload.traceability,
    payload.traceability_links,
    payload.links,
    payload.rows,
    payload.data,
  ]
  for (const candidate of candidates) {
    const arr = toArray(candidate)
    if (arr.length > 0) return arr
  }
  return []
}

const toObject = (value: unknown): JsonObject | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as JsonObject
}

const toArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) return []
  return value
}

const normalizeJsonText = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
}

const extractJsonCandidate = (value: string) => {
  const startObj = value.indexOf('{')
  const startArr = value.indexOf('[')
  let start = -1
  if (startObj >= 0 && startArr >= 0) {
    start = Math.min(startObj, startArr)
  } else if (startObj >= 0) {
    start = startObj
  } else if (startArr >= 0) {
    start = startArr
  }
  if (start < 0) return value
  const lastObj = value.lastIndexOf('}')
  const lastArr = value.lastIndexOf(']')
  const end = Math.max(lastObj, lastArr)
  if (end <= start) return value
  return value.slice(start, end + 1)
}

const parseJsonOutput = (value: string) => {
  const normalized = normalizeJsonText(value)
  if (!normalized) return { data: null as unknown, error: 'Empty JSON response.' }

  const tryParse = (input: string): unknown | null => {
    try {
      return JSON.parse(input) as unknown
    } catch {
      return null
    }
  }

  let parsed = tryParse(normalized)
  if (parsed === null) {
    parsed = tryParse(extractJsonCandidate(normalized))
  }
  if (parsed === null) {
    return { data: null as unknown, error: 'Invalid JSON response.' }
  }

  if (typeof parsed === 'string') {
    const nested = tryParse(parsed)
    if (nested !== null) {
      parsed = nested
    }
  }

  return { data: parsed, error: null as string | null }
}

const normalizeStagePayload = (
  stageKey: PipelineStageResult['key'],
  data: unknown
) => {
  const payload = toObject(data)
  if (payload) return payload
  if (Array.isArray(data)) {
    if (stageKey === 'requirements') return { requirements: data }
    if (stageKey === 'assertion_checker') return { rows: data }
    if (stageKey === 'tests') return { tests: data }
    if (stageKey === 'queries') return { queries: data }
    return { rows: data }
  }
  return null
}

const valueToCell = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '-'
  if (Array.isArray(value)) {
    if (value.length === 0) return '-'
    return value.map((item): string => valueToCell(item)).join('; ')
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

const toCsvCell = (value: string) => `"${value.replace(/"/g, '""')}"`

const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

const summarizeTraceabilityStage = (stage: PipelineStageResult | undefined) => {
  if (!stage) return 'Traceability mapper output not found.'

  const parsed = parseJsonOutput(stage.outputText)
  if (parsed.error || !parsed.data) {
    return `Traceability mapper completed with parse error: ${parsed.error ?? 'unknown error'}.`
  }

  const payload = normalizeStagePayload('requirements', parsed.data)
  if (!payload) return 'Traceability mapper completed but payload is not a JSON object/array.'

  const entries = extractRequirementsEntries(payload)
  if (!entries.length) return 'Traceability mapper completed with 0 rows.'

  const statusCounts = new Map<string, number>()
  entries.forEach((entry) => {
    const row = toObject(entry)
    if (!row) return
    const status = valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.status]))
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
  })

  const mix = Array.from(statusCounts.entries())
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ')

  return `Traceability mapper completed. Rows: ${entries.length}. Status mix: ${mix || '-'}.`
}

function App() {
  const files = useMemo(() => DATASET_ENTRIES, [])
  const [isProcessing, setIsProcessing] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pipelineStages, setPipelineStages] = useState<PipelineStageResult[]>([])
  const [activeStage, setActiveStage] = useState<PipelineStage | null>(null)
  const requestRef = useRef<AbortController | null>(null)

  const totalSize = useMemo(
    () => files.reduce((acc, entry) => acc + entry.file.size, 0),
    [files]
  )

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const index = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    )
    const value = bytes / 1024 ** index
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
  }

  const activePipelineStages = PIPELINE_STAGES

  const appendLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setLogs((prev) => [...prev, `[${timestamp}] ${message}`])
  }

  const handleProcessFiles = async (mode: PipelineMode = 'start') => {
    const selectedFiles = files.map((entry) => entry.file)
    if (!selectedFiles.length) return
    const currentStages = pipelineStages

    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller

    setIsProcessing(true)
    setError(null)
    setActiveStage(null)

    if (mode === 'continue' && currentStages.length > 0) {
      setLogs([])
      appendLog(
        '[Traceability Mapper] Continue mode: reusing previous output (no new LLM call).'
      )

      try {
        appendLog('[Traceability Mapper] Continue completed. Final report is ready.')
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return
        }
        const message =
          err instanceof Error ? err.message : 'Something went wrong while continuing.'
        setError(message)
      } finally {
        setIsProcessing(false)
        setActiveStage(null)
      }
      return
    }

    setLogs([])
    setPipelineStages([])

    try {
      const previous =
        mode === 'continue'
          ? currentStages.reduce<Record<string, string>>((acc, stage) => {
              acc[stage.key] = stage.outputText
              return acc
            }, {})
          : undefined

      const result = await runArtifactPipeline({
        files: selectedFiles,
        mode,
        previous,
        signal: controller.signal,
        onStageChange: (stage) => {
          setActiveStage(stage)
          if (stage.key === 'requirements') {
            appendLog('[Traceability Mapper] Started.')
          }
        },
      })
      setPipelineStages(result.stages)
      appendLog(
        summarizeTraceabilityStage(
          result.stages.find((stage) => stage.key === 'requirements')
        )
      )
      appendLog('[Traceability Mapper] Finished. Final report ready.')
      setActiveStage(null)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      const message =
        err instanceof Error ? err.message : 'Something went wrong while processing.'
      setError(message)
    } finally {
      setIsProcessing(false)
      setActiveStage(null)
    }
  }

  const canFollowUp = pipelineStages.length > 0 && !isProcessing
  const stageViews = useMemo(
    () =>
      pipelineStages.map((stage) => {
        const parsed = parseJsonOutput(stage.outputText)
        return {
          stage,
          ...parsed,
        }
      }),
    [pipelineStages]
  )
  const finalOutputRows = useMemo(() => {
    const traceabilityRows: FinalOutputRow[] = []
    const assertionRows: FinalOutputRow[] = []

    stageViews.forEach(({ stage, data, error }) => {
      if (error || !data) return
      const payload = normalizeStagePayload(stage.key, data)
      if (!payload) return

      if (stage.key === 'requirements') {
        extractRequirementsEntries(payload).forEach((entry) => {
          const row = toObject(entry) ?? {}
          const reqId = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.reqId])
          const testCaseId = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.testCaseId])
          const status = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.status])
          const confidence = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.confidence])
          const reasoning = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.reasoning])
          const missingInfo = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.missingInfo])

          traceabilityRows.push({
            reqId: valueToCell(reqId),
            testCaseId: valueToCell(testCaseId),
            status: valueToCell(status),
            confidence: valueToCell(confidence),
            reasoning: valueToCell(reasoning),
            missingInfo: valueToCell(missingInfo),
          })
        })
      }

      if (stage.key === 'assertion_checker') {
        extractRequirementsEntries(payload).forEach((entry) => {
          const row = toObject(entry) ?? {}
          const reqId = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.reqId])
          const testCaseId = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.testCaseId])
          const status = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.status])
          const confidence = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.confidence])
          const reasoning = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.reasoning])
          const missingInfo = pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.missingInfo])

          assertionRows.push({
            reqId: valueToCell(reqId),
            testCaseId: valueToCell(testCaseId),
            status: valueToCell(status),
            confidence: valueToCell(confidence),
            reasoning: valueToCell(reasoning),
            missingInfo: valueToCell(missingInfo),
          })
        })
      }

      if (stage.key === 'tests') {
        toArray(payload.tests).forEach((entry) => {
          const row = toObject(entry) ?? {}
          traceabilityRows.push({
            reqId: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.reqId])),
            testCaseId: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.testCaseId])),
            status: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.status])),
            confidence: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.confidence])),
            reasoning: valueToCell(
              pickFirst(row, [
                ...FINAL_OUTPUT_FIELD_KEYS.reasoning,
                'purpose_summary',
                'assertion_text',
              ])
            ),
            missingInfo: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.missingInfo])),
          })
        })
      }

      if (stage.key === 'queries') {
        toArray(payload.queries).forEach((entry) => {
          const row = toObject(entry) ?? {}
          traceabilityRows.push({
            reqId: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.reqId])),
            testCaseId: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.testCaseId])),
            status: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.status])),
            confidence: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.confidence])),
            reasoning: valueToCell(pickFirst(row, ['q', ...FINAL_OUTPUT_FIELD_KEYS.reasoning])),
            missingInfo: valueToCell(pickFirst(row, [...FINAL_OUTPUT_FIELD_KEYS.missingInfo])),
          })
        })
      }
    })

    if (!assertionRows.length) {
      return traceabilityRows
    }

    const traceabilityByReqAndTest = new Map(
      traceabilityRows.map((row) => [`${row.reqId}::${row.testCaseId}`, row])
    )
    const traceabilityByReq = new Map(
      traceabilityRows.map((row) => [row.reqId, row])
    )

    return assertionRows.map((row) => {
      const exact = traceabilityByReqAndTest.get(`${row.reqId}::${row.testCaseId}`)
      const byReq = traceabilityByReq.get(row.reqId)
      const fallback = exact ?? byReq

      return {
        ...row,
        confidence:
          row.confidence !== '-' ? row.confidence : fallback?.confidence ?? '-',
        reasoning:
          row.reasoning !== '-' ? row.reasoning : fallback?.reasoning ?? '-',
        missingInfo:
          row.missingInfo !== '-' ? row.missingInfo : fallback?.missingInfo ?? '-',
      }
    })
  }, [stageViews])

  const machineReport = useMemo<MachineReport>(() => {
    return {
      generated_at: new Date().toISOString(),
      total_stage_outputs: stageViews.length,
      total_final_rows: finalOutputRows.length,
      stages: stageViews.map(({ stage, data, error }) => ({
        stage_key: stage.key,
        stage_label: stage.label,
        parse_status: error ? 'parse_error' : 'ok',
        parse_error: error,
        payload: data,
        raw_output: stage.outputText,
      })),
      final_output_rows: finalOutputRows,
    }
  }, [finalOutputRows, stageViews])
  const machineReportText = useMemo(
    () => JSON.stringify(machineReport, null, 2),
    [machineReport]
  )

  const auditReportText = useMemo(() => {
    if (!finalOutputRows.length) {
      return 'No output rows available yet. Run the pipeline to generate the audit report.'
    }

    const header = [
      'AUDIT REPORT',
      `Generated At: ${new Date().toISOString()}`,
      `Total Rows: ${finalOutputRows.length}`,
      '',
    ]

    const lines = finalOutputRows.flatMap((row, index) => [
      `${index + 1}. Req ID: ${row.reqId}`,
      `   Test Case ID: ${row.testCaseId}`,
      `   Status: ${row.status}`,
      `   Confidence (0-1): ${row.confidence}`,
      `   Reasoning: ${row.reasoning}`,
      `   Missing Info: ${row.missingInfo}`,
      '',
    ])

    return [...header, ...lines].join('\n')
  }, [finalOutputRows])

  const handleDownloadFinalTable = () => {
    if (!finalOutputRows.length) return
    const header = [
      'Req ID',
      'Test Case ID',
      'Status',
      'Confidence (0-1)',
      'Reasoning (Evidence-backed)',
      'Missing Info (If Smelly)',
    ]
    const body = finalOutputRows.map((row) => [
      row.reqId,
      row.testCaseId,
      row.status,
      row.confidence,
      row.reasoning,
      row.missingInfo,
    ])
    const csv = [header, ...body]
      .map((line) => line.map((cell) => toCsvCell(cell)).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    downloadBlob(blob, 'final-output-table.csv')
  }

  const handleDownloadAuditReport = () => {
    const blob = new Blob([auditReportText], { type: 'text/plain;charset=utf-8;' })
    downloadBlob(blob, 'human-readable-audit-report.txt')
  }

  const handleDownloadMachineReport = () => {
    const blob = new Blob([machineReportText], { type: 'application/json;charset=utf-8;' })
    downloadBlob(blob, 'machine-readable-report.json')
  }

  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">Multi Agent System</p>
        <h1>Run LibEST artifact set.</h1>
        <p className="hero-copy">
          Uses dataset files from <code>src/dataset/req</code> and <code>src/dataset/code</code>.
        </p>
        <div className="hero-stats">
          <div>
            <span className="stat-value">{files.length || 0}</span>
            <span className="stat-label">Dataset files</span>
          </div>
          <div>
            <span className="stat-value">{formatBytes(totalSize)}</span>
            <span className="stat-label">Total size</span>
          </div>
        </div>
      </header>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Run dataset pipeline</h2>
            <p>
              Traceability Mapper using local LibEST dataset artifacts.
            </p>
          </div>
          <div className="panel-actions">
            <button type="button" className="primary" onClick={() => handleProcessFiles('start')} disabled={isProcessing || files.length === 0}>
              Run
            </button>
          </div>
        </div>

        <div className="upload-hint">
          <div>
            <h3>Dataset source</h3>
            <p>
              Requirements: {DATASET_REQUIREMENT_COUNT} files | Code: {DATASET_CODE_COUNT} files
            </p>
          </div>
        </div>

        {isProcessing && (
          <div className="processing">
            <span className="spinner" aria-hidden="true" />
            <span>
              Processing
              {activeStage ? ` - ${activeStage.label}` : ''}
            </span>
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <div className="stage-list">
          {activePipelineStages.map((stage) => {
            const done = pipelineStages.some((item) => item.key === stage.key)
            const active = activeStage?.key === stage.key && isProcessing
            return (
              <div
                key={stage.key}
                className={`stage-chip ${done ? 'done' : ''} ${active ? 'active' : ''}`}
              >
                <span className="stage-title">{stage.label}</span>
                <span className="stage-status">
                  {done ? 'Done' : active ? 'Running' : 'Queued'}
                </span>
              </div>
            )
          })}
        </div>

        <div className="report-panel">
          <div className="report-header">
            <div>
              <h3>Logs</h3>
              <p>Traceability Mapper timeline</p>
            </div>
          </div>
          <pre className="report-pre report-pre-json">
            {logs.length > 0
              ? logs.join('\n')
              : 'No logs yet.'}
          </pre>
        </div>

        <div className="final-table-panel">
          <div className="final-table-header">
            <div>
              <h3>Final output table</h3>
              <p>Combined rows from pipeline stages.</p>
            </div>
            <div className="final-table-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => handleProcessFiles('rerun')}
                disabled={!canFollowUp}
              >
                Rerun
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => handleProcessFiles('continue')}
                disabled={!canFollowUp}
              >
                Continue
              </button>
              <button
                type="button"
                className="secondary"
                onClick={handleDownloadFinalTable}
                disabled={!finalOutputRows.length}
              >
                Download table (CSV)
              </button>
            </div>
          </div>
          {finalOutputRows.length === 0 ? (
            <div className="empty-state">
              <p>No final rows yet.</p>
              <span>Run the pipeline to create a downloadable final table.</span>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="result-table">
                <thead>
                  <tr>
                    <th>Req ID</th>
                    <th>Test Case ID</th>
                    <th>Status</th>
                    <th>Confidence (0-1)</th>
                    <th>Reasoning (Evidence-backed)</th>
                    <th>Missing Info (If Smelly)</th>
                  </tr>
                </thead>
                <tbody>
                  {finalOutputRows.map((row, index) => (
                    <tr key={`final-row-${index}`}>
                      <td className="table-cell">{row.reqId}</td>
                      <td className="table-cell">{row.testCaseId}</td>
                      <td className="table-cell">{row.status}</td>
                      <td className="table-cell">{row.confidence}</td>
                      <td className="table-cell">{row.reasoning}</td>
                      <td className="table-cell">{row.missingInfo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="report-panel">
          <div className="report-header">
            <div>
              <h3>Report</h3>
              <p>Narrative report generated from the final output rows.</p>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={handleDownloadAuditReport}
            >
              Download audit report
            </button>
          </div>
          <pre className="report-pre">{auditReportText}</pre>
        </div>

        <div className="report-panel">
          <div className="report-header">
            <div>
              <h3>Next Agent Input</h3>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={handleDownloadMachineReport}
              disabled={!stageViews.length}
            >
              Download machine JSON
            </button>
          </div>
          <pre className="report-pre report-pre-json">{machineReportText}</pre>
        </div>

      </section>
    </div>
  )
}

export default App
