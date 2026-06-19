export function cleanStudentReadableText(text: string) {
  return text
    .replace(/\r/g, '\n')
    .replace(/```(?:[a-zA-Z0-9_-]+)?/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/#{2,}/g, ' ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|/gm, '')
    .replace(/\|\s*$/gm, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/_{2,}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([.!?])(?=[A-Z])/g, '$1 ')
    .replace(/[!?]{2,}/g, '!')
    .replace(/\.{4,}/g, '...')
    .trim();
}

export function cleanLessonText(text: string) {
  return cleanStudentReadableText(text)
    .replace(/\bPage\s+\d+\b/gi, ' ')
    .replace(/\b(?:in|from)\s+(?:this\s+)?chapter\b/gi, ' ')
    .replace(/\baccording to (?:the\s+)?(?:pdf|uploaded pdf|chapter|lesson)\b/gi, ' ')
    .replace(/\b(?:the\s+)?uploaded\s+pdf\b/gi, 'lesson')
    .replace(/\b(?:this\s+)?pdf\b/gi, 'lesson')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatStudentOutput(text: string) {
  const boldSegments: string[] = [];
  const protectedText = text.replace(/\*\*(.*?)\*\*/g, (_, segment: string) => {
    const index = boldSegments.push(segment) - 1;
    return `ALAB_BOLD_${index}`;
  });
  const cleanLines = cleanLessonText(protectedText)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\|?\s*-{3,}/.test(line))
    .map((line) => line.replace(/^[-*]\s*/, '- '))
    .map((line) => line.replace(/^(\d+)[.)]\s+/, '$1. '));
  const normalizedLines: string[] = [];

  for (const line of cleanLines) {
    const isListLine = /^(-|\d+\.)\s+/.test(line);
    const isLabelLine = /^(Main idea|Important points|Remember this)\b/i.test(line);
    const pieces = isListLine || isLabelLine
      ? [line]
      : splitReadableSentences(line);

    for (const piece of pieces) {
      const shortPiece = piece.trim();

      if (!shortPiece) {
        continue;
      }

      if (
        normalizedLines.length > 0 &&
        !isListLine &&
        !isLabelLine &&
        !/^(-|\d+\.)\s+/.test(normalizedLines[normalizedLines.length - 1])
      ) {
        normalizedLines.push('');
      }

      normalizedLines.push(shortPiece);
    }
  }

  return normalizedLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(
      /\bALAB_BOLD_(\d+)\b/g,
      (_, index: string) => `**${boldSegments[Number(index)] ?? ''}**`
    )
    .trim();
}

export function formatGeneralOutput(text: string) {
  return cleanStudentReadableText(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => {
      if (line.trim()) {
        return true;
      }

      return Boolean(lines[index - 1]?.trim() && lines[index + 1]?.trim());
    })
    .join('\n')
    .replace(/\n{4,}/g, '\n\n')
    .trim();
}

export function formatDirectAnswer(text: string) {
  return formatGeneralOutput(text)
    .replace(
      /^\s*(?:sure[,.!]?|of course[,.!]?|here(?:'s| is) (?:the|a) (?:answer|explanation)[.:]?|i found (?:this|a|the) lesson idea[.:]?)\s*/i,
      ''
    )
    .replace(
      /^\s*(?:according to|based on) (?:the|your|this) (?:lesson|pdf|source|material)[,.:]?\s*/i,
      ''
    )
    .replace(/^\s*answer\s*:\s*/i, '')
    .trim();
}

export function splitReadableSentences(text: string) {
  return cleanLessonText(text)
    .split(/(?<=[.!?])\s+|(?=\b(?:Question|Front|Back|Answer|Explanation|Correct answer)\s*:)/i)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
