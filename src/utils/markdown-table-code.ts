function isTableDelimiterRow(line: string): boolean {
  const indent = line.match(/^ */)?.[0].length ?? 0;
  if (indent > 3) return false;

  let value = line.trim();
  if (!value.includes('|')) return false;
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);

  const cells = value.split('|');
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function stripBlockquotePrefix(line: string): string {
  return line.replace(/^ {0,3}> ?/, '');
}

function isEscaped(value: string, index: number): boolean {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) {
    backslashCount++;
  }
  return backslashCount % 2 === 1;
}

function escapeCodeSpanPipes(line: string): string {
  let result = '';
  let cursor = 0;

  while (cursor < line.length) {
    if (line[cursor] !== '`' || isEscaped(line, cursor)) {
      result += line[cursor];
      cursor++;
      continue;
    }

    let delimiterLength = 1;
    while (line[cursor + delimiterLength] === '`') {
      delimiterLength++;
    }

    const delimiter = '`'.repeat(delimiterLength);
    let closingIndex = line.indexOf(delimiter, cursor + delimiterLength);
    while (
      closingIndex !== -1 &&
      (line[closingIndex - 1] === '`' || line[closingIndex + delimiterLength] === '`')
    ) {
      closingIndex = line.indexOf(delimiter, closingIndex + delimiterLength);
    }

    if (closingIndex === -1) {
      result += line.slice(cursor);
      break;
    }

    result += delimiter;
    const content = line.slice(cursor + delimiterLength, closingIndex);
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '|' && !isEscaped(content, i)) {
        result += '\\';
      }
      result += content[i];
    }
    result += delimiter;
    cursor = closingIndex + delimiterLength;
  }

  return result;
}

/**
 * Preserve pipe characters inside inline code spans in GFM tables.
 *
 * remark-gfm treats unescaped pipes as table delimiters even when they are
 * enclosed by backticks. Escaping only those pipes before parsing retains the
 * intended cell structure, and remark removes the escape from inline-code text.
 */
export function escapePipesInTableCodeSpans(markdown: string): string {
  const lines = markdown.split('\n');
  const tableRows = new Set<number>();
  let fence: { marker: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripBlockquotePrefix(lines[i]);
    const fenceMatch = stripped.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const length = fenceMatch[1].length;
      if (!fence) {
        fence = { marker, length };
      } else if (
        fence.marker === marker &&
        length >= fence.length &&
        stripped.slice(fenceMatch[0].length).trim() === ''
      ) {
        fence = null;
      }
      continue;
    }

    if (fence || i === 0 || !isTableDelimiterRow(stripped)) {
      continue;
    }

    tableRows.add(i - 1);
    for (let row = i + 1; row < lines.length; row++) {
      const rowStripped = stripBlockquotePrefix(lines[row]);
      if (rowStripped.trim() === '' || !rowStripped.includes('|')) {
        break;
      }
      tableRows.add(row);
    }
  }

  for (const row of tableRows) {
    lines[row] = escapeCodeSpanPipes(lines[row]);
  }

  return lines.join('\n');
}
