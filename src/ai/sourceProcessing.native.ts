import {
  extractTextFromPage,
  getPageCount,
  isAvailable,
} from 'expo-pdf-text-extract';
import type { SourceProcessingStatus } from '../data/database';
import {
  replaceSourceChunks,
  replaceSourcePages,
  upsertSourceProcessingJob,
} from '../data/database';
import { indexSourceChunks } from './rag/vector-store/store';
import {
  cleanStudentReadableText,
  splitReadableSentences,
} from './textCleanup';

const targetWordsPerChunk = 220;
const maxWordsPerChunk = 320;
const overlapWords = 45;
const minimumWordsPerChunk = 35;

type PageText = {
  pageNumber: number;
  text: string;
};

export type SourceProcessingProgress = {
  phase: 'starting' | 'extracting' | 'chunking' | 'embedding' | 'complete';
  message: string;
  percent: number;
  current?: number;
  total?: number;
};

type PdfFailureDetails = {
  code: string;
  message: string;
  userMessage: string;
};

function normalizePdfText(text: string) {
  return cleanStudentReadableText(text)
    .replace(/\r/g, '\n')
    .replace(/([A-Za-z])-\n(?=[A-Za-z])/g, '$1')
    .replace(/[ \t]*\n[ \t]*(?=[a-z,;:)])/g, ' ')
    .replace(/([^\n.!?:;])\n(?=[A-Za-z0-9(])/g, '$1 ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toReadablePageText(page: PageText) {
  const text = normalizePdfText(page.text);

  if (!text) {
    return '';
  }

  return `Page ${page.pageNumber}\n\n${text}`;
}

type TextBlock = {
  text: string;
  heading: string | null;
  isHeading: boolean;
};

function countWords(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

function estimateTokens(text: string) {
  return Math.ceil(countWords(text) * 1.35);
}

function cleanHeading(line: string) {
  return line
    .replace(/^\d+(?:\.\d+)*\s+/, '')
    .replace(/[:\-.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyHeading(line: string) {
  const cleanLine = cleanHeading(line);
  const words = cleanLine.split(/\s+/).filter(Boolean);

  if (words.length === 0 || words.length > 12 || cleanLine.length > 90) {
    return false;
  }

  if (/[.!?]$/.test(cleanLine)) {
    return false;
  }

  if (/[?,;]/.test(cleanLine) || isInstructionLikeLine(cleanLine)) {
    return false;
  }

  const alphaWords = words.filter((word) => /[A-Za-z]/.test(word));
  const capitalizedWords = alphaWords.filter((word) => /^[A-Z][a-z0-9]+/.test(word));
  const titleCaseRatio = alphaWords.length > 0
    ? capitalizedWords.length / alphaWords.length
    : 0;
  const looksLikeTitleCase =
    alphaWords.length >= 2 &&
    alphaWords.length <= 8 &&
    titleCaseRatio >= 0.65;

  return (
    /^(chapter|section|unit|module|lesson|topic|part|activity|example|summary|review)\b/i.test(cleanLine) ||
    /^[A-Z0-9\s:()/-]+$/.test(cleanLine) ||
    looksLikeTitleCase
  );
}

function isInstructionLikeLine(line: string) {
  return /^(answer|choose|circle|complete|consider|count|describe|draw|explain|fill|find|identify|list|look|make|read|select|solve|try|use|write)\b/i.test(line);
}

function splitPageIntoBlocks(pageText: string): TextBlock[] {
  const rawBlocks = pageText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const blocks: TextBlock[] = [];
  let activeHeading: string | null = null;

  for (const rawBlock of rawBlocks) {
    const lines = rawBlock
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      continue;
    }

    if (lines.length === 1 && isLikelyHeading(lines[0])) {
      activeHeading = cleanHeading(lines[0]);
      blocks.push({
        text: activeHeading,
        heading: activeHeading,
        isHeading: true,
      });
      continue;
    }

    const normalizedBlock = lines.join(' ').replace(/\s+/g, ' ').trim();

    if (!normalizedBlock) {
      continue;
    }

    blocks.push({
      text: normalizedBlock,
      heading: activeHeading,
      isHeading: false,
    });
  }

  return blocks;
}

function splitOversizedBlock(block: TextBlock): TextBlock[] {
  const wordCount = countWords(block.text);

  if (wordCount <= maxWordsPerChunk) {
    return [block];
  }

  const sentences = splitReadableSentences(block.text);
  const pieces: TextBlock[] = [];
  let current: string[] = [];

  for (const sentence of sentences) {
    const nextWords = countWords([...current, sentence].join(' '));

    if (current.length > 0 && nextWords > targetWordsPerChunk) {
      pieces.push({
        text: current.join(' '),
        heading: block.heading,
        isHeading: false,
      });
      current = [];
    }

    if (countWords(sentence) > maxWordsPerChunk) {
      const words = sentence.split(/\s+/).filter(Boolean);
      const step = Math.max(1, maxWordsPerChunk - overlapWords);

      for (let start = 0; start < words.length; start += step) {
        const chunkWords = words.slice(start, start + maxWordsPerChunk);

        if (chunkWords.length >= minimumWordsPerChunk) {
          pieces.push({
            text: chunkWords.join(' '),
            heading: block.heading,
            isHeading: false,
          });
        }
      }
      continue;
    }

    current.push(sentence);
  }

  if (current.length > 0) {
    pieces.push({
      text: current.join(' '),
      heading: block.heading,
      isHeading: false,
    });
  }

  return pieces;
}

function buildChunkText(pageNumber: number, heading: string | null, text: string) {
  const section = heading ? `Section: ${heading}\n\n` : '';

  return `Page ${pageNumber}\n\n${section}${text}`.trim();
}

function chunkPage(page: PageText) {
  const pageText = normalizePdfText(page.text);
  const blocks = splitPageIntoBlocks(pageText)
    .flatMap(splitOversizedBlock)
    .filter((block) => !block.isHeading);

  if (blocks.length === 0) {
    return [];
  }

  if (countWords(pageText) <= maxWordsPerChunk) {
    return [
      {
        pageNumber: page.pageNumber,
        text: toReadablePageText(page),
        tokenEstimate: estimateTokens(pageText),
      },
    ];
  }

  const chunks: {
    pageNumber: number;
    text: string;
    tokenEstimate: number;
  }[] = [];
  let activeHeading: string | null = null;
  let currentBlocks: string[] = [];
  let currentWords = 0;

  const flushChunk = () => {
    const text = currentBlocks.join('\n\n').trim();

    if (!text || countWords(text) < minimumWordsPerChunk) {
      currentBlocks = [];
      currentWords = 0;
      return;
    }

    chunks.push({
      pageNumber: page.pageNumber,
      text: buildChunkText(page.pageNumber, activeHeading, text),
      tokenEstimate: estimateTokens(text),
    });
    currentBlocks = [];
    currentWords = 0;
  };

  for (const block of blocks) {
    const blockWords = countWords(block.text);

    if (
      currentBlocks.length > 0 &&
      block.heading &&
      activeHeading &&
      block.heading !== activeHeading
    ) {
      flushChunk();
    }

    if (currentBlocks.length > 0 && currentWords + blockWords > maxWordsPerChunk) {
      flushChunk();
    }

    activeHeading = block.heading ?? activeHeading;
    currentBlocks.push(block.text);
    currentWords += blockWords;

    if (currentWords >= targetWordsPerChunk) {
      flushChunk();
    }
  }

  flushChunk();

  if (chunks.length === 0) {
    const fallbackWords = pageText.split(/\s+/).filter(Boolean);

    for (let start = 0; start < fallbackWords.length; start += maxWordsPerChunk - overlapWords) {
      const chunkWords = fallbackWords.slice(start, start + maxWordsPerChunk);

      if (chunkWords.length >= minimumWordsPerChunk) {
        chunks.push({
          pageNumber: page.pageNumber,
          text: `Page ${page.pageNumber}\n\n${chunkWords.join(' ')}`,
          tokenEstimate: Math.ceil(chunkWords.length * 1.35),
        });
      }
    }
  }

  return chunks;
}

function normalizeRepeatedLine(line: string) {
  return line
    .replace(/\bpage\s+\d+\b/gi, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function removeRepeatedPageNoise(pages: PageText[]) {
  if (pages.length < 4) {
    return pages;
  }

  const lineCounts = new Map<string, number>();

  for (const page of pages) {
    const seenOnPage = new Set<string>();

    for (const line of page.text.split('\n')) {
      const normalizedLine = normalizeRepeatedLine(line);

      if (
        normalizedLine.length < 4 ||
        normalizedLine.length > 90 ||
        /^[#\s-]+$/.test(normalizedLine)
      ) {
        continue;
      }

      seenOnPage.add(normalizedLine);
    }

    for (const line of seenOnPage) {
      lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
    }
  }

  const repeatedLines = new Set(
    Array.from(lineCounts)
      .filter(([, count]) => count >= Math.max(3, Math.ceil(pages.length * 0.45)))
      .map(([line]) => line)
  );

  if (repeatedLines.size === 0) {
    return pages;
  }

  return pages.map((page) => ({
    ...page,
    text: page.text
      .split('\n')
      .filter((line) => !repeatedLines.has(normalizeRepeatedLine(line)))
      .join('\n')
      .trim(),
  }));
}

function detailsForPdfFailure(error: unknown): PdfFailureDetails {
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'PASSWORD_REQUIRED') {
    return {
      code,
      message,
      userMessage: 'This PDF needs a password before ALAB can read it.',
    };
  }

  if (code === 'INCORRECT_PASSWORD') {
    return {
      code,
      message,
      userMessage: 'The PDF password did not work.',
    };
  }

  if (code === 'CORRUPT_PDF') {
    return {
      code,
      message,
      userMessage: 'ALAB could not read this PDF file.',
    };
  }

  if (code === 'PDF_ERROR' || code === 'PDF_LOAD_ERROR') {
    return {
      code,
      message,
      userMessage: 'ALAB could not open this PDF file.',
    };
  }

  if (code === 'PDF_EXTRACTION_ERROR' || code === 'PDF_PAGE_ERROR') {
    return {
      code,
      message,
      userMessage: 'ALAB opened this PDF but could not extract readable text from it.',
    };
  }

  return {
    code,
    message,
    userMessage: 'ALAB could not read this PDF yet.',
  };
}

function errorMessageForPdfFailure(error: unknown) {
  const details = detailsForPdfFailure(error);

  return withDiagnostic(details.userMessage, details);
}

function withDiagnostic(message: string, details: PdfFailureDetails) {
  const diagnosticParts = [details.code, details.message]
    .map((part) => part.trim())
    .filter(Boolean);

  if (diagnosticParts.length === 0) {
    return message;
  }

  return `${message} (${diagnosticParts.join(': ')})`;
}

export async function processSourcePdfPlaceholder(
  sourceId: string,
  fileUri?: string,
  options?: {
    embedText: (text: string) => Promise<ArrayLike<number> | null>;
    modelName: string;
    onStatusChange?: (status: SourceProcessingStatus) => void;
    onProgress?: (progress: SourceProcessingProgress) => void;
  }
) {
  const setStatus = async (status: SourceProcessingStatus, error?: string) => {
    options?.onStatusChange?.(status);
    await upsertSourceProcessingJob(sourceId, status, error);
  };

  const setProgress = (progress: SourceProcessingProgress) => {
    options?.onProgress?.(progress);
  };

  if (!fileUri || !isAvailable()) {
    await setStatus(
      'failed',
      'Saved. ALAB needs the Android app build to read this PDF.'
    );
    return;
  }

  try {
    setProgress({
      phase: 'starting',
      message: 'Opening the PDF...',
      percent: 2,
    });
    await setStatus('extracting');

    let pageCount = 0;

    try {
      setProgress({
        phase: 'extracting',
        message: 'Counting PDF pages...',
        percent: 5,
      });
      pageCount = await getPageCount(fileUri);
    } catch (error) {
      await setStatus(
        'failed',
        errorMessageForPdfFailure(error)
      );
      return;
    }

    let pages: PageText[] = [];
    const pageFailures: PdfFailureDetails[] = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      setProgress({
        phase: 'extracting',
        message: `Reading page ${pageNumber} of ${pageCount}...`,
        percent: Math.min(55, Math.round(5 + (pageNumber / pageCount) * 50)),
        current: pageNumber,
        total: pageCount,
      });

      try {
        const text = normalizePdfText(
          await extractTextFromPage(fileUri, pageNumber)
        );

        if (text) {
          pages.push({ pageNumber, text });
        }
      } catch (error) {
        const details = detailsForPdfFailure(error);
        pageFailures.push(details);
        console.warn(
          `ALAB PDF page extraction failed on page ${pageNumber}: ${details.code} - ${details.message}`
        );
      }
    }

    if (pages.length === 0) {
      const firstPageFailure = pageFailures[0];

      await setStatus(
        'failed',
        firstPageFailure
          ? withDiagnostic(
            'ALAB opened this PDF, but every page failed during text extraction.',
            firstPageFailure
          )
          : 'ALAB could not find readable text in this PDF. It may be a scanned image-only file.'
      );
      return;
    }

    pages = removeRepeatedPageNoise(pages)
      .filter((page) => page.text.trim().length > 0);

    if (pages.length === 0) {
      await setStatus(
        'failed',
        'ALAB could not find readable lesson text after cleaning this PDF.'
      );
      return;
    }

    setProgress({
      phase: 'chunking',
      message: 'Saving readable pages...',
      percent: 58,
      current: pages.length,
      total: pageCount,
    });
    await replaceSourcePages(sourceId, pages);
    await setStatus('chunking');

    setProgress({
      phase: 'chunking',
      message: 'Breaking the PDF into study chunks...',
      percent: 62,
    });
    const chunks = pages.flatMap(chunkPage).map((chunk, index) => ({
      chunkIndex: index,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      tokenEstimate: chunk.tokenEstimate,
    }));

    if (chunks.length === 0) {
      await setStatus(
        'failed',
        'ALAB could not prepare readable study text from this PDF.'
      );
      return;
    }

    const savedChunks = await replaceSourceChunks(sourceId, chunks);
    let indexingWasSkipped = false;
    let savedEmbeddingCount = 0;

    if (options) {
      await setStatus('embedding');

      const indexStatus = await indexSourceChunks(sourceId, savedChunks, {
        embedText: options.embedText,
        modelName: options.modelName,
        onIndexedChunk: (current, total) => {
          setProgress({
            phase: 'embedding',
            message: `Preparing lesson search ${current} of ${total}...`,
            percent: Math.min(
              96,
              Math.round(65 + (current / total) * 30)
            ),
            current,
            total,
          });
        },
      });

      savedEmbeddingCount = indexStatus.embeddingCount;
      indexingWasSkipped = !indexStatus.isFullyEmbedded;
    }

    if (indexingWasSkipped || savedEmbeddingCount !== savedChunks.length) {
      console.info(
        `ALAB saved readable text for source ${sourceId}. Lesson search will use text fallback until embeddings are available.`
      );
    }

    setProgress({
      phase: 'complete',
      message: 'Ready to study',
      percent: 100,
      current: savedEmbeddingCount,
      total: savedChunks.length,
    });
    await setStatus('ready');
  } catch (error) {
    await setStatus(
      'failed',
      errorMessageForPdfFailure(error)
    );
  }
}
