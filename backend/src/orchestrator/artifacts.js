import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'

const toSafeName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80) || 'item'

const baseDir = path.join(os.tmpdir(), 'multiagentsystem-orchestrator')

export const saveGeneratedTestArtifact = async ({
  runId,
  hypothesisId,
  attempt,
  code,
}) => {
  const runDir = path.join(baseDir, toSafeName(runId), toSafeName(hypothesisId))
  await fs.mkdir(runDir, { recursive: true })

  const filePath = path.join(runDir, `attempt-${attempt}.candidate.txt`)
  await fs.writeFile(filePath, code, 'utf8')
  return filePath
}

