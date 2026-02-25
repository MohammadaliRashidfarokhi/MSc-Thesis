import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

type TextBlock = {
  text: string
  isHeading: boolean
}

const toBlocks = (text: string): TextBlock[] => {
  return text.split('\n').map((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('### ')) {
      return { text: trimmed.replace(/^###\s+/, ''), isHeading: true }
    }
    return { text: line, isHeading: false }
  })
}

const wrapLine = (
  line: string,
  font: { widthOfTextAtSize: (text: string, size: number) => number },
  fontSize: number,
  maxWidth: number
) => {
  if (!line.trim()) return ['']
  const words = line.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(next, fontSize) > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

export const createPdfFromText = async (text: string) => {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage()
  const { width, height } = page.getSize()
  const margin = 48
  const contentWidth = width - margin * 2
  const bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const headingFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const bodySize = 11
  const headingSize = 15
  const lineGap = 4
  let cursorY = height - margin
  let currentPage = page

  const drawLine = (line: string, isHeading: boolean) => {
    const font = isHeading ? headingFont : bodyFont
    const size = isHeading ? headingSize : bodySize
    const lineHeight = size + lineGap
    if (cursorY - lineHeight < margin) {
      currentPage = pdfDoc.addPage()
      cursorY = height - margin
    }
    currentPage.drawText(line, {
      x: margin,
      y: cursorY,
      size,
      font,
      color: rgb(0.1, 0.1, 0.1),
    })
    cursorY -= lineHeight
  }

  const blocks = toBlocks(text)
  blocks.forEach((block) => {
    const font = block.isHeading ? headingFont : bodyFont
    const size = block.isHeading ? headingSize : bodySize
    const wrapped = wrapLine(block.text, font, size, contentWidth)
    wrapped.forEach((line) => drawLine(line, block.isHeading))
    if (!block.isHeading) {
      cursorY -= lineGap
    }
  })

  const pdfBytes = await pdfDoc.save()
  const normalizedBytes = Uint8Array.from(pdfBytes)
  return new Blob([normalizedBytes], { type: 'application/pdf' })
}
