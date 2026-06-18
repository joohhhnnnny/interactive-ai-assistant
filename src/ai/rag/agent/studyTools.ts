import { shortText } from '../chunks/text';
import {
  buildQuizFacts,
  buildStudyFacts,
  cleanStudyTerm,
  LessonFact,
  normalizeOption,
} from '../knowledge/facts';

export type StudyToolMode = 'mcq' | 'fill_blank' | 'essay';

type QuizQuestionStyle = 'meaning' | 'term' | 'direct';

const quizItemCount = 10;
const flashcardItemCount = 20;
const meaningQuestionRatio = 0.25;

export function buildSimpleStudyToolFallback(
  tool: 'quiz' | 'flashcards',
  chunks: { text: string }[],
  mode: StudyToolMode = 'mcq',
  itemCount = tool === 'quiz' ? quizItemCount : flashcardItemCount,
  variant = 0
) {
  const { baseSnippets, facts } = buildStudyFacts(chunks);
  const targetCount = getStudyToolItemCount(tool, itemCount);
  const quizFacts = tool === 'quiz'
    ? buildQuizFacts(facts, baseSnippets, targetCount)
    : [];
  const selectedFacts = tool === 'quiz'
    ? repeatToCount(quizFacts, targetCount)
    : repeatToCount(facts, targetCount);
  const variedFacts = rotateItems(selectedFacts, variant);

  if (variedFacts.length === 0) {
    return tool === 'quiz'
      ? 'ALAB needs clearer lesson definitions before making a quiz.'
      : 'ALAB needs clearer lesson definitions before making flashcards.';
  }

  if (tool === 'flashcards') {
    return repeatToCount(variedFacts, targetCount)
      .map((fact) =>
        [
          `Front: ${fact.term}`,
          `Back: ${shortText(fact.detail.replace(/_____+/g, fact.term), 220)}`,
        ].join('\n')
      )
      .join('\n\n');
  }

  const questionStyles = buildQuizQuestionStyles(variedFacts.length, variant);
  const quizQuestions = variedFacts
    .map((fact, index) =>
      buildFallbackQuizQuestion(
        fact,
        variedFacts,
        index + variant,
        mode,
        questionStyles[index] ?? 'direct'
      )
    )
    .filter((question): question is string => Boolean(question));

  if (quizQuestions.length === 0) {
    return 'ALAB needs clearer lesson definitions before making a quiz.';
  }

  return quizQuestions.join('\n\n');
}

export function getStudyToolItemCount(
  tool: 'quiz' | 'flashcards',
  requestedCount?: number
) {
  const fallbackCount = tool === 'quiz' ? quizItemCount : flashcardItemCount;

  if (!requestedCount || !Number.isFinite(requestedCount)) {
    return fallbackCount;
  }

  return Math.max(1, Math.min(50, Math.round(requestedCount)));
}

export function hasValidMcqQuiz(text: string) {
  return countValidMcqQuestions(text) > 0;
}

export function countValidMcqQuestions(text: string) {
  return text
    .split(/(?=Question\s*\d*\s*[:.)-])/i)
    .map((block) => block.trim())
    .filter((block) => /^question\s*\d*\s*[:.)-]/i.test(block))
    .filter(hasValidMcqBlock)
    .length;
}

export function countFlashcards(text: string) {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let count = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (/^front\s*:/i.test(lines[index]) && /^back\s*:/i.test(lines[index + 1] ?? '')) {
      count += 1;
      index += 1;
    }
  }

  return count;
}

export function normalizeStudyToolOutput(text: string) {
  return text
    .replace(/\r/g, '\n')
    .replace(/```(?:[a-zA-Z0-9_-]+)?/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/^\s*[-*]\s+(?=(Question|Front|Back|Answer|Correct answer|Explanation)\s*:)/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasValidMcqBlock(block: string) {
  const lines = block
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const options = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const optionMatch = line.match(/^([A-D])[.)]\s*(.*)$/i);

    if (!optionMatch) {
      continue;
    }

    const letter = optionMatch[1].toUpperCase();
    const inlineText = optionMatch[2].trim();
    const optionText = inlineText || lines[index + 1]?.trim() || '';

    if (optionText) {
      options.set(letter, optionText);
    }
  }

  const answerMatch = block.match(
    /(?:^|\n)Correct\s*answer\s*:\s*([A-D])[.)]?(?:\s+|\n)?([^\n]*)/i
  );

  if (options.size < 4 || !answerMatch) {
    return false;
  }

  const answerLetter = answerMatch[1].toUpperCase();
  const correctOption = options.get(answerLetter);
  const answerText = answerMatch[2]?.trim() ?? '';

  if (!correctOption) {
    return false;
  }

  return (
    !answerText ||
    normalizeAnswerText(answerText) === normalizeAnswerText(correctOption) ||
    normalizeAnswerText(answerText).includes(normalizeAnswerText(correctOption))
  );
}

function normalizeAnswerText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function repeatToCount<T>(items: T[], count: number) {
  if (items.length === 0) {
    return [];
  }

  return Array.from({ length: count }, (_, index) => items[index % items.length]);
}

function buildFallbackQuizQuestion(
  fact: LessonFact,
  allFacts: LessonFact[],
  index: number,
  mode: StudyToolMode,
  questionStyle: QuizQuestionStyle = 'direct'
) {
  if (mode === 'fill_blank') {
    return [
      `Question: ${buildFillBlankQuestion(fact)}`,
      `Answer: ${fact.term}`,
      `Explanation: ${shortText(fact.detail.replace(/_____+/g, fact.term), 170)}`,
    ].join('\n');
  }

  if (mode === 'essay') {
    return [
      `Question: Explain ${fact.term} in your own words.`,
      `Answer: ${shortText(fact.detail.replace(/_____+/g, fact.term), 210)}`,
      `Explanation: Include the main idea and one clear example.`,
    ].join('\n');
  }

  if (fact.kind === 'statement') {
    return buildStatementQuizQuestion(fact, allFacts, index);
  }

  const options = buildUniqueOptions(fact, allFacts, index);

  if (options.length < 4) {
    return buildDetailQuizQuestion(fact, allFacts, index);
  }

  const correctIndex = options.findIndex(
    (option) => normalizeOption(option) === normalizeOption(fact.term)
  );
  const answerLetter = String.fromCharCode(65 + Math.max(0, correctIndex));
  const correctOption = options[Math.max(0, correctIndex)] ?? fact.term;

  return [
    `Question: ${buildDefinitionQuestion(fact, questionStyle)}`,
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
    `D. ${options[3]}`,
    `Correct answer: ${answerLetter}. ${correctOption}`,
    `Explanation: ${shortText(fact.detail.replace(/_____+/g, fact.term), 170)}`,
  ].join('\n');
}

function buildStatementQuizQuestion(
  fact: LessonFact,
  allFacts: LessonFact[],
  index: number
) {
  const options = buildStatementOptions(fact, allFacts, index);

  if (options.length < 4) {
    return null;
  }

  const correctStatement = getFactStatement(fact);
  const correctIndex = options.findIndex(
    (option) => normalizeOption(option) === normalizeOption(correctStatement)
  );
  const answerLetter = String.fromCharCode(65 + Math.max(0, correctIndex));
  const correctOption = options[Math.max(0, correctIndex)] ?? correctStatement;

  return [
    'Question: Which statement is true?',
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
    `D. ${options[3]}`,
    `Correct answer: ${answerLetter}. ${correctOption}`,
    `Explanation: ${shortText(correctOption, 170)}`,
  ].join('\n');
}

function buildDetailQuizQuestion(
  fact: LessonFact,
  allFacts: LessonFact[],
  index: number
) {
  const correctStatement = getFactStatement(fact);
  const distractors = allFacts
    .filter((item) => normalizeOption(getFactStatement(item)) !== normalizeOption(correctStatement))
    .map(getFactStatement);
  const options = uniqueByNormalized([
    correctStatement,
    ...rotateItems(distractors, index).slice(0, 3),
  ]).slice(0, 4);

  if (options.length < 4) {
    return null;
  }

  const shuffledOptions = rotateItems(options, index).slice(0, 4);
  const correctIndex = shuffledOptions.findIndex(
    (option) => normalizeOption(option) === normalizeOption(correctStatement)
  );
  const answerLetter = String.fromCharCode(65 + Math.max(0, correctIndex));
  const correctOption = shuffledOptions[Math.max(0, correctIndex)] ?? correctStatement;
  const prompt = fact.kind === 'statement'
    ? 'Which statement is true?'
    : `Which statement best explains ${fact.term}?`;

  return [
    `Question: ${prompt}`,
    `A. ${shuffledOptions[0]}`,
    `B. ${shuffledOptions[1]}`,
    `C. ${shuffledOptions[2]}`,
    `D. ${shuffledOptions[3]}`,
    `Correct answer: ${answerLetter}. ${correctOption}`,
    `Explanation: ${shortText(correctOption, 170)}`,
  ].join('\n');
}

function buildDefinitionQuestion(
  fact: LessonFact,
  questionStyle: QuizQuestionStyle
) {
  const clue = cleanQuestionClue(fact.detail.replace(/_____+/g, fact.term));

  if (!clue) {
    return `What is ${fact.term}?`;
  }

  const calledQuestion = buildCalledTermQuestion(clue, fact.term);

  if (calledQuestion) {
    return calledQuestion;
  }

  if (/^(like|such as|for example)\b/i.test(clue)) {
    return `Which answer includes ${formatQuestionEnding(clue.replace(/^(like|such as|for example)\b[:,]?\s*/i, ''))}`;
  }

  if (/^(a|an|the)\b/i.test(clue)) {
    return `What is ${formatQuestionEnding(clue)}`;
  }

  if (questionStyle === 'meaning') {
    return `Which answer means ${formatQuestionEnding(clue)}`;
  }

  if (questionStyle === 'term') {
    return `Which term is described by ${formatQuestionEnding(clue)}`;
  }

  return `What matches ${formatQuestionEnding(clue)}`;
}

function buildFillBlankQuestion(fact: LessonFact) {
  if (fact.detail.includes('_____')) {
    return shortText(fact.detail, 150);
  }

  return `_____ means ${shortText(fact.detail, 135)}`;
}

function buildCalledTermQuestion(clue: string, term: string) {
  const match = clue.match(
    new RegExp(`^(.+?)\\s+(?:is|are)\\s+called\\s+${escapeRegExp(term)}$`, 'i')
  );

  if (!match) {
    return null;
  }

  return `What is ${formatQuestionSubject(match[1])} called?`;
}

function buildUniqueOptions(
  fact: LessonFact,
  allFacts: LessonFact[],
  index: number
) {
  const distractors = [
    ...allFacts
      .filter((item) => item.kind !== 'statement')
      .map((item) => item.term),
  ].filter((term) => normalizeOption(term) !== normalizeOption(fact.term));
  const uniqueDistractors = uniqueByNormalized(distractors).slice(0, 12);
  const selectedDistractors = rotateItems(uniqueDistractors, index).slice(0, 3);
  const paddedOptions = uniqueByNormalized([
    fact.term,
    ...selectedDistractors,
  ]).slice(0, 4);

  return rotateItems(paddedOptions, index).slice(0, 4);
}

function buildStatementOptions(
  fact: LessonFact,
  allFacts: LessonFact[],
  index: number
) {
  const distractors = allFacts
    .map(getFactStatement)
    .filter((statement) => normalizeOption(statement) !== normalizeOption(getFactStatement(fact)));
  const options = uniqueByNormalized([
    getFactStatement(fact),
    ...rotateItems(distractors, index).slice(0, 3),
  ]).slice(0, 4);

  return rotateItems(options, index).slice(0, 4);
}

function getFactStatement(fact: LessonFact) {
  if (fact.kind === 'statement') {
    return cleanAnswerOption(shortText(fact.term, 150));
  }

  return cleanAnswerOption(shortText(fact.detail.replace(/_____+/g, fact.term), 150));
}

function cleanQuestionClue(value: string) {
  return shortText(value, 120)
    .replace(/\s+/g, ' ')
    .replace(/^(is|are|means|refers to|describes)\s+/i, '')
    .replace(/\b(?:in|on|at|from)\s+(?:the\s+)?page\s*\d{1,4}\b/gi, '')
    .replace(/\bpage\s*\d{1,4}\b/gi, '')
    .replace(/\b(?:according to|based on)\s+(?:the\s+)?(?:lesson|pdf|source|book|text)\b[:,]?\s*/gi, '')
    .replace(/\b(?:this|the)\s+(?:lesson|pdf|source|book|text)\s+(?:says|states|explains|shows)\s+that\s+/gi, '')
    .replace(/\b(?:this|the)\s+(?:lesson|pdf|source|book|text)\b/gi, 'this topic')
    .replace(/[.?!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatQuestionEnding(value: string) {
  const cleanValue = value
    .replace(/\s+/g, ' ')
    .replace(/[.?!]+$/g, '')
    .trim();

  if (!cleanValue) {
    return 'this idea?';
  }

  return `${lowercaseFirst(cleanValue)}?`;
}

function formatQuestionSubject(value: string) {
  const cleanValue = value
    .replace(/\s+/g, ' ')
    .replace(/[.?!]+$/g, '')
    .trim();

  return cleanValue ? lowercaseFirst(cleanValue) : 'this idea';
}

function cleanAnswerOption(value: string) {
  const cleanValue = value
    .replace(/\s+/g, ' ')
    .replace(/[.?!]+$/g, '')
    .trim();
  const words = cleanValue.split(/\s+/).filter(Boolean);

  if (words.length > 3) {
    return sentenceCase(cleanValue);
  }

  return cleanStudyTerm(cleanValue);
}

function buildQuizQuestionStyles(totalQuestions: number, variant: number) {
  if (totalQuestions <= 0) {
    return [];
  }

  const meaningCount = Math.max(1, Math.round(totalQuestions * meaningQuestionRatio));
  const styles = Array.from<QuizQuestionStyle>({ length: totalQuestions }).fill('direct');
  const spacing = Math.max(1, Math.floor(totalQuestions / meaningCount));

  for (let count = 0; count < meaningCount; count += 1) {
    const position = (variant + count * spacing) % totalQuestions;
    styles[position] = 'meaning';
  }

  return styles.map((style, index) => {
    if (style === 'meaning') {
      return style;
    }

    return (index + variant) % 2 === 0 ? 'term' : 'direct';
  });
}

function sentenceCase(value: string) {
  const lower = value
    .split(/\s+/)
    .map((word) => word.length <= 3 && word === word.toUpperCase() ? word : word.toLowerCase())
    .join(' ');

  return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
}

function lowercaseFirst(value: string) {
  if (!value) {
    return value;
  }

  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rotateItems<T>(items: T[], offset: number) {
  if (items.length === 0) {
    return items;
  }

  const start = offset % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function uniqueByNormalized(items: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const item of items) {
    const cleanItem = cleanAnswerOption(item);
    const key = normalizeOption(cleanItem);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(cleanItem);
  }

  return unique;
}
