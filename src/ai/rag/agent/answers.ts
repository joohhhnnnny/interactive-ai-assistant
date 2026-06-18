import { formatStudentOutput } from '../../textCleanup';
import {
  cleanChunkText,
  isUsefulSentence,
  shortText,
  splitSentences,
  uniqueTexts,
} from '../chunks/text';

export type AnswerIntent = 'general' | 'grounded' | 'summary';

export function buildQuickGroundedAnswer(chunks: { text: string }[]) {
  const snippets = uniqueTexts(
    chunks
      .flatMap((chunk) => splitSentences([chunk]))
      .filter(isUsefulSentence)
  );
  const bestSnippet = snippets[0] ?? chunks
    .map((chunk) => cleanChunkText(chunk.text))
    .find(Boolean);

  if (!bestSnippet) {
    return 'I found a related part in your lesson, but I could not prepare a full answer yet. Please try asking in a simpler way.';
  }

  const support = snippets.find((snippet) => snippet !== bestSnippet);

  return formatStudentOutput([
    'I found this lesson idea:',
    '',
    shortText(bestSnippet, 190),
    support ? '' : null,
    support ? `A helpful detail is: ${shortText(support, 170)}` : null,
  ].filter(Boolean).join('\n'));
}

export function buildPdfSummary(chunks: { text: string; score?: number }[]) {
  const sentences = splitSentences(chunks);
  const cleanSentences = uniqueTexts(sentences).slice(0, 7);
  const mainIdea = cleanSentences[0] ?? shortText(chunks[0]?.text ?? '', 180);
  const bullets = cleanSentences
    .slice(mainIdea ? 1 : 0, 7)
    .slice(0, 5)
    .map((sentence) => `- ${shortText(sentence, 170)}`);

  if (bullets.length === 0) {
    return formatStudentOutput([
      'Here is a quick summary of your lesson.',
      '',
      'Main idea',
      shortText(mainIdea, 190),
    ].join('\n'));
  }

  return formatStudentOutput([
    'Here is a quick summary of your lesson.',
    '',
    'Main idea',
    shortText(mainIdea, 190),
    '',
    'Important points',
    ...bullets,
    '',
    `Remember this: ${shortText(bullets[0].replace(/^-\s*/, ''), 150)}`,
  ].join('\n'));
}

export function getAnswerIntent(question: string, hasSources: boolean): AnswerIntent {
  if (isSummaryRequest(question)) {
    return 'summary';
  }

  if (isExplicitLessonRequest(question)) {
    return 'grounded';
  }

  if (isGeneralKnowledgeRequest(question)) {
    return 'general';
  }

  return hasSources ? 'grounded' : 'general';
}

export function isBadGroundedAnswer(answer: string) {
  const normalized = answer.toLowerCase();

  return (
    normalized.includes('no pdf') ||
    normalized.includes('pdf included') ||
    normalized.includes('no document') ||
    normalized.includes('no file') ||
    normalized.includes('not provided')
  );
}

function isSummaryRequest(question: string) {
  const normalized = question.toLowerCase();

  return (
    normalized.includes('summarize') ||
    normalized.includes('summary') ||
    normalized.includes('sum up') ||
    normalized.includes('overview') ||
    normalized.includes('main idea') ||
    normalized.includes('what is this pdf about') ||
    normalized.includes('what is the pdf about')
  );
}

function isExplicitLessonRequest(question: string) {
  const normalized = question.toLowerCase();

  return (
    /\b(this|the|my|our)\s+(lesson|book|pdf|source|module|chapter|material|textbook)\b/.test(normalized) ||
    /\bfrom\s+(the|this|my|our)?\s*(lesson|book|pdf|source|module|chapter|material|textbook)\b/.test(normalized) ||
    /\baccording to\s+(the|this|my|our)?\s*(lesson|book|pdf|source|module|chapter|material|textbook)\b/.test(normalized) ||
    normalized.includes('in the uploaded') ||
    normalized.includes('in your uploaded') ||
    normalized.includes('based on the lesson') ||
    normalized.includes('based on my lesson')
  );
}

function isGeneralKnowledgeRequest(question: string) {
  const normalized = question.toLowerCase();

  if (
    /\b(java|javascript|python|html|css|sql|c\+\+|c#|code|program|function|class|algorithm)\b/.test(normalized) ||
    /\b(write|create|make|give me|show me)\b.+\b(code|program|example|template|letter|essay|story|sentence|paragraph)\b/.test(normalized) ||
    /\btranslate\b|\bgrammar\b|\brewrite\b|\bproofread\b/.test(normalized)
  ) {
    return true;
  }

  return /^[\d\s+\-*/().=]+$/.test(normalized.trim());
}
