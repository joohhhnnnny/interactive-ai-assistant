import { cleanStudentReadableText } from '../../../../ai/textCleanup';

export type QuizQuestion = {
  question: string;
  options: string[];
  answer: string;
  explanation?: string;
};

export type Flashcard = {
  front: string;
  back: string;
};

export function parseQuizQuestions(text: string): QuizQuestion[] {
  const normalizedText = text
    .replace(/\s+(?=Question\s*\d*\s*[:.)-])/gi, '\n\n')
    .replace(/\s+(?=Question\s*:)/gi, '\n\n')
    .replace(/\s+(?=[A-Z][.)]\s+)/g, '\n')
    .replace(/\s+(?=Correct answer\s*:)/gi, '\n')
    .replace(/\s+(?=Explanation\s*:)/gi, '\n');
  const blocks = normalizedText
    .split(/(?=Question\s*\d*\s*[:.)-])|(?=Question\s*:)/i)
    .map((block) => block.trim())
    .filter((block) => /^question/i.test(block));

  const questions = blocks
    .map<QuizQuestion | null>((block) => {
      const lines = mergeQuizLines(block
        .split('\n')
        .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''))
        .filter(Boolean));
      const questionLine = lines.find((line) => /^question/i.test(line)) ?? lines[0];
      const question = cleanQuizQuestionText(
        questionLine.replace(/^question\s*\d*\s*[:.)-]?\s*/i, '')
      );
      const options = normalizeQuizOptions(
        lines
          .filter((line) => /^[A-Z][.)]\s+/i.test(line))
          .map((line) => cleanMarkdownText(line.replace(/^[A-Z][.)]\s+/i, '')))
      );
      const answerLine = lines.find((line) => /^correct answer|^answer/i.test(line));
      const explanationLine = lines.find((line) => /^explanation/i.test(line));

      if (!question) {
        return null;
      }

      const parsedQuestion: QuizQuestion = {
        question,
        options,
        answer: answerLine
          ? cleanMarkdownText(answerLine.replace(/^correct answer\s*[:.)-]?|^answer\s*[:.)-]?/i, ''))
          : '',
      };

      if (explanationLine) {
        parsedQuestion.explanation = cleanMarkdownText(
          explanationLine.replace(/^explanation\s*[:.)-]?/i, '')
        );
      }

      return parsedQuestion;
    })
    .filter((question): question is QuizQuestion => Boolean(question))
    .filter((question) =>
      question.options.length === 4 &&
      Boolean(getCorrectOptionText(question)) &&
      hasMeaningfullyDistinctOptions(question.options)
    );

  if (questions.length > 0) {
    return questions;
  }

  return parseLooseQuizQuestions(text);
}

export function parseFlashcards(text: string): Flashcard[] {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cards: Flashcard[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const frontLine = lines[index];
    const backLine = lines[index + 1];

    if (/^front\s*:/i.test(frontLine) && /^back\s*:/i.test(backLine ?? '')) {
      const front = cleanFlashcardFrontText(frontLine.replace(/^front\s*:/i, ''));
      const back = cleanFlashcardBackText(backLine.replace(/^back\s*:/i, ''));

      if (isUsefulFlashcard(front, back)) {
        cards.push({ front, back });
      }
      index += 1;
    }
  }

  return cards;
}

export function shuffleItems<T>(items: T[]) {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

export function normalizeSourceLabels(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const labels: string[] = [];

  for (const source of value) {
    const label = getSourceLabel(source);
    const key = normalizeQuizOptionKey(label);

    if (!label || !key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    labels.push(label);
  }

  return labels;
}

export function getCorrectOptionText(question: QuizQuestion) {
  const normalizedAnswer = normalizeQuizOptionKey(question.answer);
  const letterMatch = normalizedAnswer.match(/^[a-d]\b|^[a-d][.)]/i);

  if (letterMatch) {
    const optionIndex = letterMatch[0].toLowerCase().charCodeAt(0) - 97;
    return question.options[optionIndex] ?? '';
  }

  return question.options.find((option) => {
    const normalizedOption = normalizeQuizOptionKey(option);
    return (
      normalizedOption === normalizedAnswer ||
      normalizedAnswer.includes(normalizedOption)
    );
  }) ?? '';
}

export function isCorrectQuizAnswer(question: QuizQuestion, selectedAnswer?: string) {
  if (!selectedAnswer || question.options.length === 0) {
    return false;
  }

  const correctOption = getCorrectOptionText(question).trim().toLowerCase();

  return (
    correctOption.length > 0 &&
    normalizeQuizOptionKey(selectedAnswer) === normalizeQuizOptionKey(correctOption)
  );
}

export function normalizeQuizOptionKey(option: string) {
  return option.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanQuizQuestionText(text: string) {
  const cleanText = cleanMarkdownText(text)
    .replace(/\bWhat is this about\??$/i, '')
    .replace(/\babout the chapter\b/gi, 'about this lesson')
    .replace(/\s+/g, ' ')
    .trim();
  const chapterMentions = cleanText.match(/\bchapter\s+\d+\b/gi)?.length ?? 0;

  if (!cleanText || chapterMentions >= 2) {
    return 'Which answer best matches this lesson idea?';
  }

  return cleanText;
}

function normalizeQuizOptions(options: string[]) {
  const seen = new Set<string>();
  const uniqueOptions: string[] = [];

  for (const option of options) {
    const cleanOption = cleanMarkdownText(option).replace(/\s+/g, ' ').trim();
    const key = normalizeQuizOptionKey(cleanOption);

    if (
      !key ||
      seen.has(key) ||
      uniqueOptions.some((existingOption) =>
        areQuizOptionsTooSimilar(existingOption, cleanOption)
      )
    ) {
      continue;
    }

    seen.add(key);
    uniqueOptions.push(cleanOption);

    if (uniqueOptions.length === 4) {
      break;
    }
  }

  return uniqueOptions;
}

function cleanMarkdownText(text: string) {
  return cleanStudentReadableText(text);
}

function parseLooseQuizQuestions(text: string): QuizQuestion[] {
  const blocks = text
    .replace(/\r/g, '\n')
    .replace(/\s+(?=Question\s*\d*\s*[:.)-])/gi, '\n\n')
    .split(/(?=Question\s*\d*\s*[:.)-])/i)
    .map((block) => block.trim())
    .filter((block) => /^question\s*\d*\s*[:.)-]/i.test(block));
  const questions: QuizQuestion[] = [];

  for (const block of blocks) {
    const question = parseLooseQuizBlock(block);

    if (
      question &&
      question.options.length === 4 &&
      Boolean(getCorrectOptionText(question))
    ) {
      questions.push(question);
    }
  }

  return questions;
}

function parseLooseQuizBlock(block: string): QuizQuestion | null {
  const normalizedBlock = cleanMarkdownText(block)
    .replace(/\s+/g, ' ')
    .trim();
  const questionMatch = normalizedBlock.match(
    /^Question\s*\d*\s*[:.)-]?\s*([\s\S]*?)(?=\s+A[.)]\s+)/i
  );

  if (!questionMatch) {
    return null;
  }

  const question = cleanQuizQuestionText(questionMatch[1]);
  const optionStart = questionMatch[0].length;
  const answerStart = findFirstIndex(
    normalizedBlock,
    /\s+(?:Correct\s+answer|Answer)\s*:/i,
    optionStart
  );
  const explanationStart = findFirstIndex(
    normalizedBlock,
    /\s+Explanation\s*:/i,
    optionStart
  );
  const optionEnd = Math.min(
    ...[answerStart, explanationStart, normalizedBlock.length]
      .filter((index) => index >= 0)
  );
  const optionArea = normalizedBlock.slice(optionStart, optionEnd).trim();
  const options = parseLooseOptions(optionArea);
  const answerMatch = normalizedBlock.match(
    /\b(?:Correct\s+answer|Answer)\s*:\s*([A-D])(?:[.)]?\s*([\s\S]*?))?(?=\s+Explanation\s*:|$)/i
  );
  const answerLetter = answerMatch?.[1]?.toUpperCase() ?? '';
  const answerIndex = answerLetter ? answerLetter.charCodeAt(0) - 65 : -1;
  const answerText = cleanMarkdownText(answerMatch?.[2] ?? '').trim();
  const explanationMatch = normalizedBlock.match(/\bExplanation\s*:\s*([\s\S]*)$/i);
  const parsedQuestion: QuizQuestion = {
    question,
    options,
    answer: answerLetter
      ? `${answerLetter}. ${answerText || options[answerIndex] || ''}`.trim()
      : '',
  };

  if (explanationMatch?.[1]) {
    parsedQuestion.explanation = cleanMarkdownText(explanationMatch[1]);
  }

  return parsedQuestion;
}

function parseLooseOptions(optionArea: string) {
  const optionMatches = Array.from(optionArea.matchAll(
    /(?:^|\s)([A-D])[.)]\s+([\s\S]*?)(?=\s+[A-D][.)]\s+|$)/gi
  ));
  const optionsByLetter = new Map<string, string>();

  for (const match of optionMatches) {
    const letter = match[1].toUpperCase();
    const option = cleanMarkdownText(match[2]).replace(/\s+/g, ' ').trim();

    if (option) {
      optionsByLetter.set(letter, option);
    }
  }

  return ['A', 'B', 'C', 'D']
    .map((letter) => optionsByLetter.get(letter) ?? '')
    .filter(Boolean);
}

function findFirstIndex(text: string, pattern: RegExp, startIndex: number) {
  const match = pattern.exec(text.slice(startIndex));

  return match ? startIndex + match.index : -1;
}

function cleanFlashcardFrontText(text: string) {
  return cleanMarkdownText(text)
    .replace(/^[-*\d.)\s]+/, '')
    .replace(/^\W+|\W+$/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanFlashcardBackText(text: string) {
  return cleanMarkdownText(text)
    .replace(/^[-*\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMeaningfullyDistinctOptions(options: string[]) {
  if (options.length !== 4) {
    return false;
  }

  for (let leftIndex = 0; leftIndex < options.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < options.length; rightIndex += 1) {
      if (areQuizOptionsTooSimilar(options[leftIndex], options[rightIndex])) {
        return false;
      }
    }
  }

  return true;
}

function areQuizOptionsTooSimilar(left: string, right: string) {
  const normalizedLeft = normalizeQuizOptionKey(left);
  const normalizedRight = normalizeQuizOptionKey(right);

  if (!normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight) {
    return true;
  }

  const shorter = normalizedLeft.length < normalizedRight.length
    ? normalizedLeft
    : normalizedRight;
  const longer = normalizedLeft.length < normalizedRight.length
    ? normalizedRight
    : normalizedLeft;

  if (shorter.length >= 16 && longer.includes(shorter)) {
    return true;
  }

  const leftTokens = getMeaningfulOptionTokens(normalizedLeft);
  const rightTokens = getMeaningfulOptionTokens(normalizedRight);

  if (leftTokens.length < 3 || rightTokens.length < 3) {
    return false;
  }

  const rightSet = new Set(rightTokens);
  const intersection = leftTokens.filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const overlap = intersection / Math.max(1, union);
  const coverage = intersection / Math.max(1, Math.min(leftTokens.length, rightTokens.length));

  return overlap >= 0.72 || coverage >= 0.86;
}

function getMeaningfulOptionTokens(value: string) {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/s$/, ''))
    .filter((token) => token.length > 2 && !quizOptionStopWords.has(token));
}

function isUsefulFlashcard(front: string, back: string) {
  const normalizedFront = normalizeQuizOptionKey(front);
  const frontWords = normalizedFront.split(/\s+/).filter(Boolean);

  return (
    front.length >= 3 &&
    front.length <= 45 &&
    frontWords.length >= 1 &&
    frontWords.length <= 7 &&
    hasMeaningfulFlashcardFrontWord(normalizedFront) &&
    !isFunctionWordOnlyFlashcardFront(normalizedFront) &&
    !isInstructionLikeFlashcardFront(normalizedFront) &&
    !isQuestionLikeText(front) &&
    !questionTermStarts.has(frontWords[0] ?? '') &&
    !front.includes(',') &&
    !/[.!?]$/.test(front) &&
    (
      !flashcardFragmentStarts.has(frontWords[0] ?? '') ||
      isAcceptedLeadingFunctionWordTerm(normalizedFront)
    ) &&
    (
      !weakFlashcardFrontStarts.has(frontWords[0] ?? '') ||
      isAcceptedLeadingFunctionWordTerm(normalizedFront)
    ) &&
    !/\b(is|are|was|were|has|have|had|can|could|should|would|will)\b/i.test(front) &&
    isUsefulFlashcardBack(front, back)
  );
}

function hasMeaningfulFlashcardFrontWord(normalizedFront: string) {
  return normalizedFront
    .split(/\s+/)
    .filter(Boolean)
    .some((word) =>
      word.length > 2 &&
      !flashcardFrontStopWords.has(word)
    );
}

function isFunctionWordOnlyFlashcardFront(normalizedFront: string) {
  const words = normalizedFront.split(/\s+/).filter(Boolean);

  return (
    words.length === 0 ||
    words.every((word) => flashcardFrontStopWords.has(word))
  );
}

function isInstructionLikeFlashcardFront(normalizedFront: string) {
  return (
    !isAcceptedLeadingFunctionWordTerm(normalizedFront) &&
    (
      /^(answer|choose|circle|complete|consider|draw|explain|fill|find|identify|list|look|make|read|select|solve|try|write)\b/.test(normalizedFront) ||
      /\b(answer the|choose the|circle the|complete the|fill in|keep (?:the|your)|look at|make up|select the|test your|try making|try to|write down)\b/.test(normalizedFront)
    )
  );
}

function isUsefulFlashcardBack(front: string, back: string) {
  const cleanBack = back.trim();

  return (
    cleanBack.length >= 24 &&
    cleanBack.length <= 260 &&
    cleanBack.split(/\s+/).filter(Boolean).length >= 4 &&
    /^[A-Z0-9]/.test(cleanBack) &&
    !isQuestionLikeText(cleanBack) &&
    !/^(is|are|was|were|has|have|had|can|could|should|would|will)\b/i.test(cleanBack) &&
    !looksLikeSentenceContinuation(front, cleanBack) &&
    !normalizeQuizOptionKey(cleanBack).startsWith('this statement is true')
  );
}

function isQuestionLikeText(text: string) {
  const normalized = normalizeQuizOptionKey(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  const firstWord = words[0] ?? '';
  const secondWord = words[1] ?? '';

  if (!normalized) {
    return true;
  }

  if (/[?？]\s*$/.test(text.trim())) {
    return true;
  }

  if (!questionTermStarts.has(firstWord)) {
    return false;
  }

  if (questionAuxiliaryStarts.has(firstWord)) {
    return true;
  }

  return words.length <= 4 || questionAuxiliaryStarts.has(secondWord);
}

function looksLikeSentenceContinuation(front: string, back: string) {
  const normalizedFront = normalizeQuizOptionKey(front);
  const firstFrontWord = normalizedFront.split(/\s+/)[0] ?? '';

  return (
    (
      flashcardFragmentStarts.has(firstFrontWord) &&
      !isAcceptedLeadingFunctionWordTerm(normalizedFront)
    ) ||
    back.length === 0 ||
    /^[a-z]/.test(back.trim())
  );
}

function isAcceptedLeadingFunctionWordTerm(normalizedFront: string) {
  return /^(if statement|if clause|for loop|for statement|while loop|while statement|with statement|in operator)$/.test(normalizedFront);
}

function getSourceLabel(source: unknown): string {
  if (typeof source === 'string') {
    return source.replace(/\s+/g, ' ').trim();
  }

  if (typeof source !== 'object' || source === null) {
    return '';
  }

  const sourceRecord = source as Record<string, unknown>;
  const sourceName = getStringField(
    sourceRecord,
    'sourceName',
    'source_name',
    'name',
    'filename',
    'title',
    'label'
  );
  const pageNumber = getNumberField(
    sourceRecord,
    'pageNumber',
    'page_number',
    'page'
  );

  if (!sourceName) {
    return '';
  }

  return pageNumber ? `${sourceName}, page ${pageNumber}` : sourceName;
}

function getStringField(
  record: Record<string, unknown>,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.trim()) {
      return value.replace(/\s+/g, ' ').trim();
    }
  }

  return '';
}

function getNumberField(
  record: Record<string, unknown>,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsedValue = Number(value);

      if (Number.isFinite(parsedValue)) {
        return parsedValue;
      }
    }
  }

  return null;
}

const quizOptionStopWords = new Set([
  'about',
  'according',
  'answer',
  'because',
  'chapter',
  'choice',
  'detail',
  'does',
  'from',
  'idea',
  'lesson',
  'main',
  'meaning',
  'option',
  'point',
  'question',
  'says',
  'statement',
  'that',
  'the',
  'this',
  'topic',
  'what',
  'which',
  'with',
]);

const flashcardFrontStopWords = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'all',
  'also',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'during',
  'each',
  'few',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'many',
  'may',
  'more',
  'most',
  'much',
  'must',
  'my',
  'next',
  'no',
  'not',
  'now',
  'of',
  'on',
  'only',
  'or',
  'other',
  'our',
  'over',
  'own',
  'same',
  'several',
  'she',
  'should',
  'so',
  'some',
  'something',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'us',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

const weakFlashcardFrontStarts = new Set([
  ...flashcardFrontStopWords,
  'activity',
  'answer',
  'example',
  'exercise',
  'information',
  'lesson',
  'page',
  'question',
  'sentence',
  'statement',
  'text',
  'worksheet',
]);

const questionTermStarts = new Set([
  'am',
  'are',
  'can',
  'could',
  'did',
  'do',
  'does',
  'had',
  'has',
  'have',
  'how',
  'is',
  'should',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'would',
]);

const questionAuxiliaryStarts = new Set([
  'am',
  'are',
  'can',
  'could',
  'did',
  'do',
  'does',
  'had',
  'has',
  'have',
  'is',
  'should',
  'was',
  'were',
  'will',
  'would',
]);

const flashcardFragmentStarts = new Set([
  'also',
  'although',
  'and',
  'as',
  'after',
  'at',
  'before',
  'because',
  'but',
  'by',
  'during',
  'for',
  'from',
  'in',
  'if',
  'it',
  'its',
  'of',
  'on',
  'or',
  'over',
  'since',
  'so',
  'that',
  'then',
  'there',
  'these',
  'they',
  'this',
  'though',
  'through',
  'to',
  'under',
  'using',
  'when',
  'where',
  'while',
  'with',
]);

function mergeQuizLines(lines: string[]) {
  const mergedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1];
    const followingLine = lines[index + 2];

    if (/^[A-D][.)]$/i.test(line) && nextLine) {
      mergedLines.push(`${line} ${nextLine}`);
      index += 1;
      continue;
    }

    if (/^correct$/i.test(line) && /^answer\s*[:.)-]?/i.test(nextLine ?? '')) {
      const answerLine = nextLine && /^[A-D][.)]?$/i.test(nextLine.replace(/^answer\s*[:.)-]?\s*/i, '')) && followingLine
        ? `${nextLine} ${followingLine}`
        : nextLine ?? '';
      mergedLines.push(`Correct ${answerLine}`);
      index += answerLine === nextLine ? 1 : 2;
      continue;
    }

    if (/^correct answer\s*[:.)-]?\s*$/i.test(line) && /^[A-D][.)]\s+/i.test(nextLine ?? '')) {
      mergedLines.push(`${line} ${nextLine}`);
      index += 1;
      continue;
    }

    if (/^correct answer\s*[:.)-]?\s*[A-D][.)]?$/i.test(line) && nextLine) {
      mergedLines.push(`${line} ${nextLine}`);
      index += 1;
      continue;
    }

    if (/^answer\s*[:.)-]?\s*$/i.test(line) && /^[A-D][.)]\s+/i.test(nextLine ?? '')) {
      mergedLines.push(`${line} ${nextLine}`);
      index += 1;
      continue;
    }

    if (/^answer\s*[:.)-]?\s*[A-D][.)]?$/i.test(line) && nextLine) {
      mergedLines.push(`${line} ${nextLine}`);
      index += 1;
      continue;
    }

    mergedLines.push(line);
  }

  return mergedLines;
}
