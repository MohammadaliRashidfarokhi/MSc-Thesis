import { useMemo, useRef, useState } from 'react'
import {
  PIPELINE_STAGES,
  runArtifactPipeline,
  type PipelineMode,
  type PipelineStage,
  type PipelineStageResult,
} from './services/serviceManager'
import './App.css'

type SelectedFile = {
  id: string
  file: File
}

type JsonObject = Record<string, unknown>
type FinalOutputRow = {
  stage: string
  itemId: string
  name: string
  summary: string
  details: string
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

const parseJsonOutput = (value: string) => {
  const normalized = normalizeJsonText(value)
  if (!normalized) return { data: null as unknown, error: 'Empty JSON response.' }
  try {
    return { data: JSON.parse(normalized) as unknown, error: null as string | null }
  } catch {
    return { data: null as unknown, error: 'Invalid JSON response.' }
  }
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

const assertionsToCell = (value: unknown): string => {
  const assertions = toArray(value)
  if (assertions.length === 0) return '-'
  return assertions
    .map((entry) => {
      const item = toObject(entry)
      if (!item) return valueToCell(entry)
      const assertionText = valueToCell(item.assertion_text)
      const snippet = valueToCell(item.evidence_snippet)
      return `${assertionText} (snippet: ${snippet})`
    })
    .join('; ')
}

const toCsvCell = (value: string) => `"${value.replace(/"/g, '""')}"`

function App() {
  const [files, setFiles] = useState<SelectedFile[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pipelineStages, setPipelineStages] = useState<PipelineStageResult[]>([])
  const [activeStage, setActiveStage] = useState<PipelineStage | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
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

  const toKey = (file: File) => `${file.name}-${file.size}-${file.lastModified}`

  const mergeFiles = (existing: SelectedFile[], incoming: FileList | null) => {
    if (!incoming) return existing
    const map = new Map(existing.map((entry) => [entry.id, entry]))
    Array.from(incoming).forEach((file) => {
      const key = toKey(file)
      if (!map.has(key)) {
        map.set(key, { id: key, file })
      }
    })
    return Array.from(map.values())
  }

  const handleProcessFiles = async (
    selectedFiles: File[],
    mode: PipelineMode = 'start'
  ) => {
    if (!selectedFiles.length) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller

    setIsProcessing(true)
    setError(null)
    setPipelineStages([])
    setActiveStage(null)

    try {
      const previous =
        mode === 'continue'
          ? pipelineStages.reduce<Record<string, string>>((acc, stage) => {
              acc[stage.key] = stage.outputText
              return acc
            }, {})
          : undefined

      const result = await runArtifactPipeline({
        files: selectedFiles,
        mode,
        previous,
        signal: controller.signal,
        onStageChange: (stage) => setActiveStage(stage),
      })
      setPipelineStages(result.stages)
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

  const handleAddFiles = (incoming: FileList | null) => {
    if (!incoming) return
    const next = mergeFiles(files, incoming)
    setFiles(next)
    void handleProcessFiles(next.map((entry) => entry.file), 'start')
  }

  const handlePickFiles = () => {
    inputRef.current?.click()
  }

  const handleClear = () => {
    setFiles([])
    setError(null)
    setPipelineStages([])
    setActiveStage(null)
    requestRef.current?.abort()
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  const handleRemove = (id: string) => {
    setFiles((prev) => prev.filter((entry) => entry.id !== id))
    setPipelineStages([])
    setActiveStage(null)
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
    const rows: FinalOutputRow[] = []

    stageViews.forEach(({ stage, data, error }) => {
      if (error || !data) return
      const payload = toObject(data)
      if (!payload) return

      if (stage.key === 'requirements') {
        toArray(payload.requirements).forEach((entry) => {
          const row = toObject(entry) ?? {}
          rows.push({
            stage: 'requirements',
            itemId: valueToCell(row.req_id),
            name: valueToCell(row.title),
            summary: valueToCell(row.source_text),
            details: `Trigger: ${valueToCell(row.trigger)} | Expected: ${valueToCell(
              row.expected_outcomes
            )} | Negative: ${valueToCell(row.negative_cases)} | Questions: ${valueToCell(
              row.open_questions
            )}`,
          })
        })
      }

      if (stage.key === 'tests') {
        toArray(payload.tests).forEach((entry) => {
          const row = toObject(entry) ?? {}
          rows.push({
            stage: 'tests',
            itemId: valueToCell(row.test_id),
            name: valueToCell(row.test_name),
            summary: valueToCell(row.purpose_summary),
            details: `File: ${valueToCell(row.file_path)} | Assertions: ${assertionsToCell(
              row.assertions
            )} | Components: ${valueToCell(row.touched_components)} | Tags: ${valueToCell(
              row.tags
            )}`,
          })
        })
      }

      if (stage.key === 'queries') {
        toArray(payload.queries).forEach((entry) => {
          const row = toObject(entry) ?? {}
          rows.push({
            stage: 'queries',
            itemId: valueToCell(row.target),
            name: valueToCell(row.target),
            summary: valueToCell(row.q),
            details: `Keywords: ${valueToCell(payload.keywords)} | Entities: ${valueToCell(
              payload.entities
            )}`,
          })
        })
      }
    })

    return rows
  }, [stageViews])

  const handleDownloadFinalTable = () => {
    if (!finalOutputRows.length) return
    const header = ['Stage', 'Item ID', 'Name', 'Summary', 'Details']
    const body = finalOutputRows.map((row) => [
      row.stage,
      row.itemId,
      row.name,
      row.summary,
      row.details,
    ])
    const csv = [header, ...body]
      .map((line) => line.map((cell) => toCsvCell(cell)).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'final-output-table.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const renderStageTable = (stageKey: PipelineStageResult['key'], data: unknown) => {
    const payload = toObject(data)
    if (!payload) {
      return <p className="table-note">Response root is not a JSON object.</p>
    }

    if (stageKey === 'requirements') {
      const rows = toArray(payload.requirements)
      if (rows.length === 0) return <p className="table-note">No requirements returned.</p>
      return (
        <div className="table-wrap">
          <table className="result-table">
            <thead>
              <tr>
                <th>Req ID</th>
                <th>Title</th>
                <th>Source Text</th>
                <th>Preconditions</th>
                <th>Trigger</th>
                <th>Expected Outcomes</th>
                <th>Negative Cases</th>
                <th>Notes</th>
                <th>Open Questions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry, index) => {
                const row = toObject(entry) ?? {}
                return (
                  <tr key={`requirement-${index}`}>
                    <td className="table-cell">{valueToCell(row.req_id)}</td>
                    <td className="table-cell">{valueToCell(row.title)}</td>
                    <td className="table-cell">{valueToCell(row.source_text)}</td>
                    <td className="table-cell">{valueToCell(row.preconditions)}</td>
                    <td className="table-cell">{valueToCell(row.trigger)}</td>
                    <td className="table-cell">{valueToCell(row.expected_outcomes)}</td>
                    <td className="table-cell">{valueToCell(row.negative_cases)}</td>
                    <td className="table-cell">{valueToCell(row.notes)}</td>
                    <td className="table-cell">{valueToCell(row.open_questions)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )
    }

    if (stageKey === 'tests') {
      const rows = toArray(payload.tests)
      if (rows.length === 0) return <p className="table-note">No tests returned.</p>
      return (
        <div className="table-wrap">
          <table className="result-table">
            <thead>
              <tr>
                <th>Test ID</th>
                <th>File Path</th>
                <th>Test Name</th>
                <th>Purpose</th>
                <th>Steps</th>
                <th>Assertions</th>
                <th>Touched Components</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry, index) => {
                const row = toObject(entry) ?? {}
                return (
                  <tr key={`test-${index}`}>
                    <td className="table-cell">{valueToCell(row.test_id)}</td>
                    <td className="table-cell">{valueToCell(row.file_path)}</td>
                    <td className="table-cell">{valueToCell(row.test_name)}</td>
                    <td className="table-cell">{valueToCell(row.purpose_summary)}</td>
                    <td className="table-cell">{valueToCell(row.steps)}</td>
                    <td className="table-cell">{assertionsToCell(row.assertions)}</td>
                    <td className="table-cell">{valueToCell(row.touched_components)}</td>
                    <td className="table-cell">{valueToCell(row.tags)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )
    }

    const queries = toArray(payload.queries)
    return (
      <div className="query-results">
        {queries.length > 0 ? (
          <div className="table-wrap">
            <table className="result-table">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Query</th>
                </tr>
              </thead>
              <tbody>
                {queries.map((entry, index) => {
                  const row = toObject(entry) ?? {}
                  return (
                    <tr key={`query-${index}`}>
                      <td className="table-cell">{valueToCell(row.target)}</td>
                      <td className="table-cell">{valueToCell(row.q)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="table-note">No queries returned.</p>
        )}
        <div className="query-meta">
          <div>
            <p className="meta-label">Keywords</p>
            <p className="meta-value">{valueToCell(payload.keywords)}</p>
          </div>
          <div>
            <p className="meta-label">Entities</p>
            <p className="meta-value">{valueToCell(payload.entities)}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">Multi Agent System</p>
        <h1>Upload your artificat.</h1>
        <p className="hero-copy">
          Select multiple files, artifact eg: test cases, test suit, requirment document etc..
        </p>
        <div className="hero-stats">
          <div>
            <span className="stat-value">{files.length || 0}</span>
            <span className="stat-label">Files queued</span>
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
            <h2>Upload files</h2>
            <p>
              Choose multiple documents files to start interact with Multi Agent System
            </p>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              className="ghost"
              onClick={handleClear}
              disabled={!files.length || isProcessing}
            >
              Clear all
            </button>
            <button type="button" className="primary" onClick={handlePickFiles} disabled={isProcessing}>
              Select files
            </button>
          </div>
        </div>

        <div className="upload-box">
          <input
            ref={inputRef}
            className="file-input"
            type="file"
            multiple
            onChange={(event) => {
              handleAddFiles(event.target.files)
              event.currentTarget.value = ''
            }}
            disabled={isProcessing}
          />
          <div className="upload-hint">
            <div className="upload-icon" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <h3>Drop files here or use the button</h3>
              <p>PDF, DOCX, TXT, or images. Up to 25MB per file.</p>
            </div>
          </div>
        </div>

        {isProcessing && (
          <div className="processing">
            <span className="spinner" aria-hidden="true" />
            <span>
              Processing{activeStage ? ` - ${activeStage.label}` : ''}
            </span>
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <div className="stage-list">
          {PIPELINE_STAGES.map((stage) => {
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

        <div className="results-panel">
          <div className="results-header">
            <h3>Structured stage output</h3>
            <p>Each pipeline response is parsed and displayed in table form.</p>
          </div>
          {stageViews.length === 0 ? (
            <div className="empty-state">
              <p>No stage output yet.</p>
              <span>Upload files to run the pipeline and populate the tables.</span>
            </div>
          ) : (
            stageViews.map(({ stage, data, error }) => (
              <article key={`stage-result-${stage.key}`} className="result-card">
                <div className="result-card-header">
                  <h4>{stage.label}</h4>
                </div>
                {error || !data ? (
                  <div className="result-raw">
                    <p className="table-note">{error ?? 'Unable to render JSON response.'}</p>
                    <pre>{stage.outputText}</pre>
                  </div>
                ) : (
                  renderStageTable(stage.key, data)
                )}
              </article>
            ))
          )}
        </div>

        <div className="final-table-panel">
          <div className="final-table-header">
            <div>
              <h3>Final output table</h3>
              <p>Combined rows from all three stages.</p>
            </div>
            <div className="final-table-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => handleProcessFiles(files.map((entry) => entry.file), 'rerun')}
                disabled={!canFollowUp}
              >
                Rerun
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => handleProcessFiles(files.map((entry) => entry.file), 'continue')}
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
                    <th>Stage</th>
                    <th>Item ID</th>
                    <th>Name</th>
                    <th>Summary</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {finalOutputRows.map((row, index) => (
                    <tr key={`final-row-${index}`}>
                      <td className="table-cell">{row.stage}</td>
                      <td className="table-cell">{row.itemId}</td>
                      <td className="table-cell">{row.name}</td>
                      <td className="table-cell">{row.summary}</td>
                      <td className="table-cell">{row.details}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="file-list">
          {files.length === 0 ? (
            <div className="empty-state">
              <p>No files added yet.</p>
              <span>Select multiple files to begin.</span>
            </div>
          ) : (
            <ul>
              {files.map((entry, index) => (
                <li key={entry.id} style={{ animationDelay: `${index * 0.05}s` }}>
                  <div>
                    <p className="file-name">{entry.file.name}</p>
                    <p className="file-meta">
                      {formatBytes(entry.file.size)} -{' '}
                      {entry.file.type || 'Unknown type'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text"
                    onClick={() => handleRemove(entry.id)}
                    disabled={isProcessing}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

export default App
