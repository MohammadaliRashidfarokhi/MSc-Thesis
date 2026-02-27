import path from 'path'
import { promises as fs } from 'fs'

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
])

const TEST_FILE_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/i,
  /\.spec\.[cm]?[jt]sx?$/i,
  /_test\.py$/i,
  /test_.*\.py$/i,
  /Test\.java$/i,
  /Tests\.java$/i,
]

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const isTestFile = (filePath) => {
  const name = path.basename(filePath)
  if (TEST_FILE_PATTERNS.some((pattern) => pattern.test(name))) return true
  const normalizedPath = filePath.toLowerCase()
  return (
    normalizedPath.includes('/test/') ||
    normalizedPath.includes('/tests/') ||
    normalizedPath.includes('__tests__')
  )
}

const walkFiles = async (rootDir, maxFiles = 400) => {
  const queue = [rootDir]
  const result = []

  while (queue.length > 0 && result.length < maxFiles) {
    const dir = queue.shift()
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (result.length >= maxFiles) break
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push(fullPath)
        }
        continue
      }
      if (entry.isFile()) {
        result.push(fullPath)
      }
    }
  }

  return result
}

const extractSnippetAround = (content, token, radius = 20) => {
  const lines = content.split(/\r?\n/)
  const index = lines.findIndex((line) => normalize(line).includes(normalize(token)))
  if (index < 0) return null
  const start = Math.max(0, index - radius)
  const end = Math.min(lines.length, index + radius + 1)
  return lines.slice(start, end).join('\n').trim()
}

const extractMethodLikeSnippet = (content, testId) => {
  const direct = extractSnippetAround(content, testId, 24)
  if (direct) return direct

  const markers = ['test(', 'it(', '@test', 'def test_', 'function test', 'class']
  for (const marker of markers) {
    const snippet = extractSnippetAround(content, marker, 20)
    if (snippet) return snippet
  }

  const lines = content.split(/\r?\n/)
  return lines.slice(0, Math.min(lines.length, 50)).join('\n').trim()
}

export const collectExistingTestContexts = async ({
  repoRoot,
  testId,
  maxFiles = 400,
  maxContexts = 3,
}) => {
  const allFiles = await walkFiles(repoRoot, maxFiles)
  const testFiles = allFiles.filter(isTestFile)

  const ranked = testFiles
    .map((filePath) => {
      const score =
        normalize(filePath).includes(normalize(testId)) ? 2 : 1
      return { filePath, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxContexts * 4)

  const contexts = []

  for (const item of ranked) {
    if (contexts.length >= maxContexts) break
    const content = await fs.readFile(item.filePath, 'utf8')
    const snippet = extractMethodLikeSnippet(content, testId)
    contexts.push({
      source: 'existing_test_code',
      file_path: item.filePath,
      snippet,
    })
  }

  return contexts
}

