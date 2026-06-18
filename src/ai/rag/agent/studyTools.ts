import { shortText } from '../chunks/text';
import {
  buildQuizFacts,
  buildStudyFacts,
  cleanStudyTerm,
  LessonFact,
  normalizeOption,
} from '../knowledge/facts';

export type StudyToolMode = 'mcq' | 'fill_blank' | 'essay';

const quizItemCount = 10;
const flashcardItemCount = 20;

export function buildSimpleStudyToolFallback(
  tool: 'quiz' | 'flashcards',
  chunks: { text: string }[],
  mode: StudyToolMode = 'mcq',
  itemCount = tool === 'quiz' ? quizItemCount : flashcardItemCount,
  variant = 0
) {
  const { baseSnippets, facts } = buildStudyFacts(chunks);
  const targetCount = getStudyToolItemCount(tool, itemCount);
  const selectedFacts = tool === 'quiz'
    ? buildQuizFacts(facts, baseSnippets, targetCount)
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

  const quizQuestions = variedFacts
    .map((fact, index) =>
      buildFallbackQuizQuestion(fact, variedFacts, index + variant, mode)
    )
    .filter((question): question is string => Boolean(question));

  if (quizQuestions.length === 0) {
    return 'ALAB needs clearer lesson definitions before making a quiz.';
  }

  return quizQuestions.join('\n\n');
}

export function getStudyToolItemCount(
  tool: 'quiz' | 'flashcards',
  _requestedCount?: number
) {
  return tool === 'quiz' ? quizItemCount : flashcardItemCount;
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
  mode: StudyToolMode
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
      `Explanation: Include the lesson idea and one clear example.`,
    ].join('\n');
  }

  if (fact.kind === 'statement') {
    return buildStatementQuizQuestion(fact, allFacts, index);
  }

  const options = buildUniqueOptions(fact, allFacts, index);

  if (options.length < 4) {
    return null;
  }

  const correctIndex = options.findIndex(
    (option) => normalizeOption(option) === normalizeOption(fact.term)
  );
  const answerLetter = String.fromCharCode(65 + Math.max(0, correctIndex));
  const correctOption = options[Math.max(0, correctIndex)] ?? fact.term;

  return [
    `Question: ${buildDefinitionQuestion(fact)}`,
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

  const correctIndex = options.findIndex(
    (option) => normalizeOption(option) === normalizeOption(fact.term)
  );
  const answerLetter = String.fromCharCode(65 + Math.max(0, correctIndex));
  const correctOption = options[Math.max(0, correctIndex)] ?? fact.term;

  return [
    'Question: Which statement is true based on the lesson?',
    `A. ${options[0]}`,
    `B. ${options[1]}`,
    `C. ${options[2]}`,
    `D. ${options[3]}`,
    `Correct answer: ${answerLetter}. ${correctOption}`,
    `Explanation: ${shortText(correctOption, 170)}`,
  ].join('\n');
}

function buildDefinitionQuestion(fact: LessonFact) {
  const detail = fact.detail.replace(/_____+/g, 'this idea');
  const prompt = detail.charAt(0).toUpperCase() + detail.slice(1);

  return `Which word matches this meaning: ${shortText(prompt, 130)}?`;
}

function buildFillBlankQuestion(fact: LessonFact) {
  if (fact.detail.includes('_____')) {
    return shortText(fact.detail, 150);
  }

  return `_____ means ${shortText(fact.detail, 135)}`;
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
    .filter((item) => item.kind === 'statement')
    .map((item) => item.term)
    .filter((term) => normalizeOption(term) !== normalizeOption(fact.term));
  const options = uniqueByNormalized([
    fact.term,
    ...rotateItems(distractors, index).slice(0, 3),
  ]).slice(0, 4);

  return rotateItems(options, index).slice(0, 4);
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
    const cleanItem = cleanStudyTerm(item);
    const key = normalizeOption(cleanItem);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(cleanItem);
  }

  return unique;
}
