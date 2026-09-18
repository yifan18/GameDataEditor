export function encodeClipboardCell(value: string) {
  if (!/["\t\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function parseClipboardText(text: string) {
  const normalizedText = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let isQuoted = false;

  for (let index = 0; index < normalizedText.length; index += 1) {
    const character = normalizedText[index];

    if (isQuoted) {
      if (character === '"') {
        if (normalizedText[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          isQuoted = false;
        }
      } else {
        value += character;
      }
      continue;
    }

    if (character === '"' && value.length === 0) {
      isQuoted = true;
    } else if (character === '\t') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }

  row.push(value);
  rows.push(row);
  return rows;
}
