import {
  extractTextFromPage,
  getPageCount,
  isAvailable,
} from 'expo-pdf-text-extract';
import {
  replaceSourceChunks,
  replaceSourcePages,
  saveChunkEmbedding,
  upsertSourceProcessingJob,
} from '../data/database';
import type { SourceProcessingStatus } from '../data/database';

const maxWordsPerChunk = 220;
const overlapWords = 40;

type PageText = {
  pageNumber: number;
  text: string;
};

function normalizePdfText(text: string) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toMarkdownLikePage(page: PageText) {
  const text = normalizePdfText(page.text);

  if (!text) {
    return '';
  }

  return `## Page ${page.pageNumber}\n\n${text}`;
}

function chunkPage(page: PageText) {
  const markdownText = toMarkdownLikePage(page);
  const words = markdownText.split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return [];
  }

  if (words.length <= maxWordsPerChunk) {
    return [
      {
        pageNumber: page.pageNumber,
        text: markdownText,
        tokenEstimate: Math.ceil(words.length * 1.35),
      },
    ];
  }

  const chunks: {
    pageNumber: number;
    text: string;
    tokenEstimate: number;
  }[] = [];
  const step = maxWordsPerChunk - overlapWords;

  for (let start = 0; start < words.length; start += step) {
    const chunkWords = words.slice(start, start + maxWordsPerChunk);

    if (chunkWords.length < 24) {
      continue;
    }

    chunks.push({
      pageNumber: page.pageNumber,
      text: chunkWords.join(' '),
      tokenEstimate: Math.ceil(chunkWords.length * 1.35),
    });
  }

  return chunks;
}

function errorMessageForPdfFailure(error: unknown) {
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';

  if (code === 'PASSWORD_REQUIRED') {
    return 'This PDF needs a password before ALAB can read it.';
  }

  if (code === 'INCORRECT_PASSWORD') {
    return 'The PDF password did not work.';
  }

  if (code === 'CORRUPT_PDF') {
    return 'ALAB could not read this PDF file.';
  }

  return 'ALAB could not read this PDF yet.';
}

export async function processSourcePdfPlaceholder(
  sourceId: string,
  fileUri?: string,
  options?: {
    embedText: (text: string) => Promise<ArrayLike<number> | null>;
    modelName: string;
    onStatusChange?: (status: SourceProcessingStatus) => void;
  }
) {
  const setStatus = async (status: SourceProcessingStatus, error?: string) => {
    options?.onStatusChange?.(status);
    await upsertSourceProcessingJob(sourceId, status, error);
  };

  if (!fileUri || !isAvailable()) {
    await setStatus(
      'failed',
      'Saved. ALAB needs the Android app build to read this PDF.'
    );
    return;
  }

  try {
    await setStatus('extracting');

    const pageCount = await getPageCount(fileUri);
    const pages: PageText[] = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const text = normalizePdfText(
        await extractTextFromPage(fileUri, pageNumber)
      );

      if (text) {
        pages.push({ pageNumber, text });
      }
    }

    if (pages.length === 0) {
      await setStatus(
        'failed',
        'ALAB could not find readable text in this PDF.'
      );
      return;
    }

    await replaceSourcePages(sourceId, pages);
    await setStatus('chunking');

    const chunks = pages.flatMap(chunkPage).map((chunk, index) => ({
      chunkIndex: index,
      pageNumber: chunk.pageNumber,
      text: chunk.text,
      tokenEstimate: chunk.tokenEstimate,
    }));

    const savedChunks = await replaceSourceChunks(sourceId, chunks);

    if (options) {
      await setStatus('embedding');

      for (const chunk of savedChunks) {
        const embedding = await options.embedText(chunk.text);

        if (embedding) {
          await saveChunkEmbedding(
            chunk.id,
            options.modelName,
            embedding
          );
        }
      }
    }

    await setStatus('ready');
  } catch (error) {
    await setStatus(
      'failed',
      errorMessageForPdfFailure(error)
    );
  }
}
