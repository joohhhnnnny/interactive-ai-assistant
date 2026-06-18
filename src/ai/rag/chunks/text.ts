import {
  cleanLessonText,
  splitReadableSentences,
} from '../../textCleanup';

export function cleanChunkText(text: string) {
  return cleanLessonText(text).replace(/\s+/g, ' ').trim();
}

export function splitSentences(chunks: { text: string }[]) {
  return chunks
    .flatMap((chunk) =>
      splitReadableSentences(cleanChunkText(chunk.text))
        .map((sentence) => sentence.trim())
    )
    .filter(isUsefulSentence);
}

export function shortText(text: string, maxLength: number) {
  const cleanText = cleanChunkText(text);

  if (cleanText.length <= maxLength) {
    return cleanText;
  }

  return `${cleanText.slice(0, maxLength).replace(/\s+\S*$/, '')}...`;
}

export function uniqueTexts(items: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const item of items) {
    const key = item.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  return unique;
}

export function isUsefulSentence(sentence: string) {
  const cleanSentence = cleanLessonText(sentence);
  const words = cleanSentence.split(/\s+/).filter(Boolean);

  return (
    cleanSentence.length >= 24 &&
    cleanSentence.length <= 260 &&
    words.length >= 4 &&
    !isNoisyLessonText(cleanSentence)
  );
}

export function isNoisyLessonText(text: string) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const chapterMentions = normalized.match(/\bchapter\s+\d+\b/g)?.length ?? 0;

  return (
    !normalized ||
    /^page \d+$/.test(normalized) ||
    /^chapter \d*/.test(normalized) ||
    /^module \d*/.test(normalized) ||
    chapterMentions >= 2 ||
    /\bchapter\s+\d+\s+.+\bchapter\s+\d+\b/i.test(text) ||
    /^[-|_\s]+$/.test(text) ||
    normalized.includes('table of contents') ||
    normalized.includes('first edition') ||
    normalized.includes('level beginner') ||
    normalized.includes('no prior knowledge') ||
    normalized.includes('designed for absolute beginners') ||
    normalized.includes('computers are everywhere today') ||
    normalized.includes('according to the pdf') ||
    normalized.includes('uploaded pdf')
  );
}
