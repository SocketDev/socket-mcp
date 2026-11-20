import { screenshotSvg, type Cell, type TestTerminal } from '@termless/core'

const svgOptions = {
  fontFamily: "'JetBrains Mono', 'Noto Sans Symbols 2', monospace",
  fontSize: 14,
  padding: 16,
  borderRadius: 8,
  windowBar: 'colorful' as const,
}

function isVisiblyOccupied(cell: Cell): boolean {
  return (
    (cell.char !== '' && cell.char !== ' ') ||
    cell.bg !== null ||
    cell.inverse ||
    (cell.underline !== false && cell.underline !== 'none') ||
    cell.strikethrough === true ||
    cell.overline === true ||
    cell.wide ||
    cell.continuation
  )
}

function emptyCell(): Cell {
  return {
    char: '',
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    underlineColor: null,
    strikethrough: false,
    inverse: false,
    blink: false,
    overline: false,
    hidden: false,
    wide: false,
    continuation: false,
    hyperlink: null,
  }
}

export function renderScreenshot(terminal: TestTerminal): string {
  const rows = terminal.getRows()
  const cursor = terminal.getCursor()
  const scrollback = terminal.getScrollback()
  const cursorRow =
    cursor.row + Math.max(0, scrollback.totalRows - scrollback.screenRows)
  const lastRow = rows.findLastIndex(row => row.some(isVisiblyOccupied))
  const height = Math.max(lastRow, cursor.visible ? cursorRow : -1) + 3
  const visibleRows = rows.slice(0, height)
  while (visibleRows.length < height) {
    visibleRows.push(Array.from({ length: terminal.cols }, emptyCell))
  }
  return screenshotSvg(
    {
      ...terminal,
      getRows: () => visibleRows,
      getCursor: () => ({ ...cursor, row: cursorRow, y: cursorRow }),
    },
    svgOptions,
  )
}
