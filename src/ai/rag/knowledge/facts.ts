import { cleanLessonText, splitReadableSentences } from '../../textCleanup';
import {
  cleanChunkText,
  isNoisyLessonText,
  isUsefulSentence,
  shortText,
  uniqueTexts,
} from '../chunks/text';

export type LessonFact = {
  term: string;
  detail: string;
  sourceText: string;
  kind?: 'term' | 'statement';
};

export function buildStudyFacts(chunks: { text: string }[]) {
  const sentences = uniqueTexts(
    chunks
      .flatMap((chunk) => splitReadableSentences(cleanChunkText(chunk.text)))
      .filter(isUsefulSentence)
  );
  const baseSnippets = sentences.length > 0
    ? sentences
    : chunks.map((chunk) => cleanChunkText(chunk.text)).filter(Boolean);
  const facts = extractLessonFacts(chunks);
  const snippetFacts = buildFactsFromSnippets(baseSnippets);
  const emergencyFacts = buildEmergencyFactsFromChunks(chunks);

  return {
    baseSnippets,
    facts: uniqueFacts([
      ...facts,
      ...snippetFacts,
      ...emergencyFacts,
    ]),
  };
}

export function buildQuizFacts(
  facts: LessonFact[],
  snippets: string[],
  targetCount: number
) {
  const selectedFacts = uniqueFacts(facts).slice(0, targetCount);

  if (selectedFacts.length >= targetCount) {
    return selectedFacts;
  }

  const extraFacts = uniqueFacts([
    ...selectedFacts,
    ...buildFactsFromSnippets(snippets),
  ]).slice(0, targetCount);

  if (extraFacts.length >= targetCount) {
    return extraFacts;
  }

  return extraFacts;
}

export function uniqueFacts(facts: LessonFact[]) {
  const seen = new Set<string>();
  const unique: LessonFact[] = [];

  for (const fact of facts) {
    const key = normalizeOption(fact.term);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(fact);
  }

  return unique;
}

export function cleanStudyTerm(term: string) {
  const cleanTerm = normalizeStudyTermPhrase(
    cleanLessonText(term)
      .replace(/^\W+|\W+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );

  return titleCase(cleanTerm);
}

export function normalizeOption(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractLessonFacts(chunks: { text: string }[]): LessonFact[] {
  const facts = chunks
    .flatMap((chunk) => getLessonFactCandidates(chunk.text))
    .map(parseLessonFact)
    .filter((fact): fact is LessonFact => Boolean(fact));

  return uniqueFacts(facts);
}

function buildFactsFromSnippets(snippets: string[]): LessonFact[] {
  const definitionFacts = uniqueTexts(snippets)
    .map(parseLessonFactFromDefinition)
    .filter((fact): fact is LessonFact => Boolean(fact));

  if (definitionFacts.length > 0) {
    return definitionFacts;
  }

  return uniqueTexts(snippets)
    .filter(isUsefulSentence)
    .slice(0, 50)
    .map((snippet) => ({
      term: shortText(snippet, 130),
      detail: 'This statement is true based on the lesson.',
      sourceText: snippet,
      kind: 'statement' as const,
    }));
}

function buildEmergencyFactsFromChunks(chunks: { text: string }[]): LessonFact[] {
  return uniqueTexts(
    chunks
      .map((chunk) => cleanChunkText(chunk.text))
      .flatMap((text) => text.split(/(?<=[.!?])\s+|\n+/))
      .map((text) => shortText(text, 160))
      .filter(isUsefulEmergencyFactText)
  )
    .slice(0, 50)
    .map((snippet) => ({
      term: snippet,
      detail: 'This statement is true based on the lesson.',
      sourceText: snippet,
      kind: 'statement' as const,
    }));
}

function isUsefulEmergencyFactText(text: string) {
  const cleanText = cleanLessonText(text);
  const words = cleanText.split(/\s+/).filter(Boolean);

  return (
    cleanText.length >= 28 &&
    cleanText.length <= 180 &&
    words.length >= 5 &&
    !isNoisyLessonText(cleanText)
  );
}

function parseLessonFact(sentence: string): LessonFact | null {
  const cleanSentence = cleanChunkText(sentence);

  if (!isUsefulSentence(cleanSentence) || isNoisyLessonText(cleanSentence)) {
    return null;
  }

  const definitionFact = parseLessonFactFromDefinition(cleanSentence);

  if (definitionFact) {
    return definitionFact;
  }

  const patterns = [
    /^(.{2,70}?)(?:\s+-\s+|\s*[:\u2013\u2014]\s*)(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = cleanSentence.match(pattern);

    if (!match) {
      continue;
    }

    const rawTerm = cleanStudyTerm(match[1]);
    const rawDetail = match.length >= 4
      ? `${match[2]} ${match[3]}`
      : match[2];
    const detail = cleanStudyDetail(rawDetail, rawTerm);

    if (isUsefulTerm(rawTerm) && isUsefulSentence(detail)) {
      return {
        term: rawTerm,
        detail,
        sourceText: cleanSentence,
        kind: 'term',
      };
    }
  }

  return null;
}

function parseLessonFactFromDefinition(sentence: string): LessonFact | null {
  const cleanSentence = cleanChunkText(sentence);
  const calledPhraseMatch = cleanSentence.match(
    /^(.{4,170}?)\s+(?:is|are)\s+called\s+(?:a|an|the)?\s*([A-Za-z][A-Za-z0-9 /()+#.-]{1,35})(?:[,.;:]|\s+and\b|$)/i
  );

  if (calledPhraseMatch) {
    const rawTerm = cleanStudyTerm(calledPhraseMatch[2]);
    const calledSubject = cleanCalledSubject(calledPhraseMatch[1]);
    const detail = `${calledSubject} is called _____`;

    if (
      isUsefulTerm(rawTerm) &&
      isUsefulSentence(detail) &&
      isAnswerableFact(rawTerm, detail)
    ) {
      return {
        term: rawTerm,
        detail,
        sourceText: cleanSentence,
        kind: 'term',
      };
    }
  }

  const calledMatch = cleanSentence.match(
    /^(.{12,170}?)\s+(?:is|are)\s+called\s+(?:a|an|the)?\s*([A-Za-z][A-Za-z0-9 /()+#.-]{1,35})\.?$/i
  );

  if (calledMatch) {
    const rawTerm = cleanStudyTerm(calledMatch[2]);
    const detail = cleanStudyDetail(`${calledMatch[1]} is called ${rawTerm}`, rawTerm);

    if (
      isUsefulTerm(rawTerm) &&
      isUsefulSentence(detail) &&
      isAnswerableFact(rawTerm, detail)
    ) {
      return {
        term: rawTerm,
        detail,
        sourceText: cleanSentence,
        kind: 'term',
      };
    }
  }

  const definitionPatterns = [
    /\b([A-Z][A-Za-z0-9 /()+#.-]{2,45})\s+(is|are|means|refers to|describes|uses|is used for|is used to|are used for|are used to)\s+(.+)$/i,
    /\b([A-Z][A-Za-z0-9 /()+#.-]{2,45})(?:\s+-\s+|\s*[:\u2013\u2014]\s+)(.+)$/i,
  ];

  for (const pattern of definitionPatterns) {
    const match = cleanSentence.match(pattern);

    if (!match) {
      continue;
    }

    const rawTerm = cleanStudyTerm(match[1]);
    const rawDetail = match.length >= 4 ? `${match[2]} ${match[3]}` : match[2];
    const detail = cleanStudyDetail(rawDetail, rawTerm);

    if (
      isUsefulTerm(rawTerm) &&
      isUsefulSentence(detail) &&
      isAnswerableFact(rawTerm, detail)
    ) {
      return {
        term: rawTerm,
        detail,
        sourceText: cleanSentence,
        kind: 'term',
      };
    }
  }

  return null;
}

function cleanStudyDetail(detail: string, term: string) {
  return cleanLessonText(detail)
    .replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'), '_____')
    .replace(/\s+/g, ' ')
    .replace(/^\W+/, '')
    .trim();
}

function normalizeStudyTermPhrase(term: string) {
  let cleanTerm = term
    .replace(/^(the|a|an|n)\s+/i, '')
    .replace(/^(?:concept|idea|meaning|definition)\s+of\s+(?:the|a|an)?\s*/i, '')
    .replace(/^(?:term|word|phrase)\s+(?:for|called|named)\s+(?:the|a|an)?\s*/i, '')
    .replace(/^(?:called|named|known as)\s+(?:the|a|an)?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  cleanTerm = collapseRepeatedWords(cleanTerm);
  cleanTerm = collapseRepeatedArticlePhrase(cleanTerm);
  cleanTerm = collapseRepeatedPhrase(cleanTerm);

  return cleanTerm;
}

function collapseRepeatedWords(value: string) {
  const words = value.split(/\s+/).filter(Boolean);
  const collapsedWords: string[] = [];

  for (const word of words) {
    const previousWord = collapsedWords[collapsedWords.length - 1];

    if (previousWord && normalizeOption(previousWord) === normalizeOption(word)) {
      continue;
    }

    collapsedWords.push(word);
  }

  return collapsedWords.join(' ');
}

function collapseRepeatedPhrase(value: string) {
  const words = value.split(/\s+/).filter(Boolean);

  for (let size = Math.floor(words.length / 2); size >= 1; size -= 1) {
    const left = words.slice(0, size).join(' ');
    const right = words.slice(size, size * 2).join(' ');

    if (
      size * 2 === words.length &&
      normalizeOption(left) === normalizeOption(right)
    ) {
      return left;
    }
  }

  return value;
}

function collapseRepeatedArticlePhrase(value: string) {
  const match = value.match(/^(.+?)\s+(?:a|an|the|n)\s+(.+)$/i);

  if (!match) {
    return value;
  }

  const left = stripLeadingArticleFragment(match[1]);
  const right = stripLeadingArticleFragment(match[2]);

  if (normalizeOption(left) === normalizeOption(right)) {
    return right;
  }

  return value;
}

function stripLeadingArticleFragment(value: string) {
  return value.replace(/^(?:a|an|the|n)\s+/i, '').trim();
}

function isUsefulTerm(term: string) {
  const normalized = term.toLowerCase();

  return (
    term.length >= 3 &&
    term.length <= 45 &&
    normalized.split(/\s+/).length <= 5 &&
    !term.includes(',') &&
    !term.includes('?') &&
    !/^(this|that|these|those|they|them|their|it|its|you|your|we|our|what|which|who|when|where|why|how)\b/i.test(term) &&
    !/\b(is|are|means|refers|called|enough|erased|first|level|pages|designed|absolute|beginner|everywhere|today)\b/i.test(term) &&
    !normalized.includes('question') &&
    !normalized.includes('answer') &&
    !normalized.includes('according') &&
    !normalized.includes('pdf') &&
    !normalized.includes('chapter') &&
    !normalized.includes('page') &&
    !normalized.includes('lesson detail') &&
    !genericStudyTerms.has(normalized) &&
    !/^\d+$/.test(normalized)
  );
}

function isAnswerableFact(term: string, detail: string) {
  const normalizedTerm = normalizeOption(term);
  const normalizedDetail = normalizeOption(detail);

  return (
    normalizedTerm.length > 0 &&
    normalizedDetail.length >= 20 &&
    !normalizedDetail.includes(normalizedTerm) &&
    !normalizedDetail.includes('no prior knowledge') &&
    !normalizedDetail.includes('beginner pages') &&
    !normalizedDetail.includes('first edition') &&
    !normalizedDetail.includes('ready to study') &&
    (detail.includes('_____') || !normalizedDetail.startsWith('this ')) &&
    (detail.includes('_____') || !normalizedDetail.startsWith('it ')) &&
    normalizedDetail.split(/\s+/).length >= 4
  );
}

function cleanCalledSubject(value: string) {
  return cleanLessonText(value)
    .replace(/\b(?:this|that)\s+/i, 'the ')
    .replace(/\s+/g, ' ')
    .replace(/[.?!]+$/g, '')
    .trim();
}

function getLessonFactCandidates(text: string) {
  const cleanText = cleanLessonText(text);
  const lineCandidates = cleanText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      line.length <= 180 &&
      /(?:\s+-\s+|[:\u2013\u2014]|\b(?:is|are|means|refers to|is used for|is used to|called)\b)/i.test(line)
    );

  return uniqueTexts([
    ...lineCandidates,
    ...splitReadableSentences(cleanText),
  ]).filter((candidate) => !isNoisyLessonText(candidate));
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.length <= 3 && word === word.toUpperCase()
        ? word
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`
    )
    .join(' ');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const genericStudyTerms = new Set([
  'activity',
  'application',
  'chapter',
  'definition',
  'digital tool',
  'edition',
  'example',
  'fun fact',
  'hardware',
  'lesson',
  'module',
  'page',
  'paragraph',
  'question',
  'section',
  'software',
  'software hardware',
  'system',
  'this mistake',
  'this',
  'topic',
]);
