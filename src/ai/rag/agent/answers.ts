import { formatGeneralOutput, formatStudentOutput } from '../../textCleanup';
import {
  cleanChunkText,
  isUsefulSentence,
  shortText,
  splitSentences,
  uniqueTexts,
} from '../chunks/text';

export type AnswerIntent = 'general' | 'grounded' | 'summary';

export function buildDirectGroundedAnswer(
  question: string,
  chunks: { text: string }[]
) {
  const queryTerms = getAnswerTerms(question);
  const definitionTopic = getDefinitionTopic(question);
  const snippets = uniqueTexts(
    chunks
      .flatMap((chunk) => splitSentences([chunk]))
      .filter(isUsefulSentence)
  );
  const rankedSnippets = snippets
    .map((snippet, index) => ({
      snippet,
      score: scoreAnswerSnippet(
        snippet,
        queryTerms,
        definitionTopic,
        index
      ),
    }))
    .sort((left, right) => right.score - left.score);
  const bestRankedSnippet = rankedSnippets[0];
  const bestSnippet = bestRankedSnippet &&
    (queryTerms.length === 0 || bestRankedSnippet.score > 0.5)
    ? bestRankedSnippet.snippet
    : queryTerms.length === 0
      ? chunks.map((chunk) => cleanChunkText(chunk.text)).find(Boolean)
      : undefined;

  if (!bestSnippet) {
    return '';
  }

  const support = rankedSnippets.find(
    ({ snippet, score }) => snippet !== bestSnippet && score > 0.5
  )?.snippet;

  return formatGeneralOutput([
    shortText(bestSnippet, 240),
    support ? shortText(support, 200) : null,
  ].filter(Boolean).join('\n\n'));
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
    normalized.trim().length < 12 ||
    normalized.includes('no pdf') ||
    normalized.includes('pdf included') ||
    normalized.includes('no document') ||
    normalized.includes('no file') ||
    normalized.includes('not provided') ||
    normalized.includes('lesson context:') ||
    normalized.includes('student question:') ||
    normalized.includes('chunk_id') ||
    normalized.includes('retrieval score') ||
    /^(i found (this|a|the)|a helpful detail is|according to (the|your) (pdf|lesson|source))/i.test(
      normalized.trim()
    )
  );
}

function scoreAnswerSnippet(
  snippet: string,
  queryTerms: string[],
  definitionTopic: string,
  originalIndex: number
) {
  const normalized = normalizeAnswerText(snippet);
  const matchedTerms = queryTerms.filter((term) => normalized.includes(term));
  const coverage = queryTerms.length > 0
    ? matchedTerms.length / queryTerms.length
    : 0;
  const definitionBonus = definitionTopic && normalized.includes(definitionTopic)
    && /\b(is|are|means|refers to|defined as|describes)\b/.test(normalized)
    ? 2.5
    : 0;
  const directnessPenalty = /^(page\s+\d+|section:|the importance of|you may|in this (lesson|chapter))/i.test(
    normalized
  )
    ? 1
    : 0;

  return coverage * 5 + definitionBonus - directnessPenalty - originalIndex * 0.01;
}

function getDefinitionTopic(question: string) {
  const match = question.match(
    /^\s*(?:what|who)\s+(?:is|are|was|were)\s+(.+?)[?.!]*\s*$/i
  );

  return match ? normalizeAnswerText(match[1]) : '';
}

function getAnswerTerms(question: string) {
  return Array.from(
    new Set(
      normalizeAnswerText(question)
        .split(/\s+/)
        .filter((term) => term.length > 2 && !answerStopWords.has(term))
    )
  ).slice(0, 10);
}

function normalizeAnswerText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const answerStopWords = new Set([
  'about',
  'according',
  'alab',
  'book',
  'chapter',
  'could',
  'does',
  'explain',
  'from',
  'lesson',
  'material',
  'please',
  'source',
  'tell',
  'that',
  'this',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
]);

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
