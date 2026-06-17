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
import { cleanStudentReadableText } from './textCleanup';

const maxWordsPerChunk = 100;
const overlapWords = 25;
const minimumWordsPerChunk = 18;

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

function chunkPage(page: PageText) {
  const pageText = normalizePdfText(page.text);
  const words = pageText.split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return [];
  }

  if (words.length <= maxWordsPerChunk) {
    return [
      {
        pageNumber: page.pageNumber,
        text: toReadablePageText(page),
        tokenEstimate: Math.ceil(words.length * 1.35),
      },
    ];
  }

  const chunks: {
    pageNumber: number;
    text: string;
    tokenEstimate: number;
  }[] = [];
  const step = Math.max(1, maxWordsPerChunk - overlapWords);

  for (let start = 0; start < words.length; start += step) {
    const chunkWords = words.slice(start, start + maxWordsPerChunk);

    if (chunkWords.length < minimumWordsPerChunk) {
      continue;
    }

    const boundedChunkWords = chunkWords.slice(0, maxWordsPerChunk);

    chunks.push({
      pageNumber: page.pageNumber,
      text: `Page ${page.pageNumber}\n\n${boundedChunkWords.join(' ')}`,
      tokenEstimate: Math.ceil(boundedChunkWords.length * 1.35),
    });
  }

  return chunks;
}

function getErrorCode(error: unknown) {
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';

  return code || 'UNKNOWN_PDF_ERROR';
}

function getErrorMessage(error: unknown) {
  if (typeof error === 'object' && error && 'message' in error) {
    const message = String((error as { message?: unknown }).message).trim();

    if (message) {
      return message;
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return 'No native error message was provided.';
}

function withDiagnostic(message: string, details: PdfFailureDetails) {
  return `${message} (${details.code}: ${details.message})`;
}

function detailsForPdfFailure(error: unknown): PdfFailureDetails {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);

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

    const pages: PageText[] = [];
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

    if (options) {
      await setStatus('embedding');
      setProgress({
        phase: 'embedding',
        message: `Indexing 0 of ${savedChunks.length} study chunks...`,
        percent: 72,
        current: 0,
        total: savedChunks.length,
      });

      try {
        let embeddedChunkCount = 0;
        let skippedEmbeddingIndexing = false;

        for (const [index, chunk] of savedChunks.entries()) {
          const current = index + 1;

          setProgress({
            phase: 'embedding',
            message: `Indexing ${current} of ${savedChunks.length} study chunks...`,
            percent: Math.min(
              98,
              Math.round(72 + (current / savedChunks.length) * 26)
            ),
            current,
            total: savedChunks.length,
          });

          const embedding = await options.embedText(chunk.text);

          if (!embedding) {
            skippedEmbeddingIndexing = true;
            indexingWasSkipped = true;
            break;
          }

          await saveChunkEmbedding(
            chunk.id,
            options.modelName,
            embedding
          );
          embeddedChunkCount += 1;
        }

        if (skippedEmbeddingIndexing && embeddedChunkCount === 0) {
          setProgress({
            phase: 'complete',
            message: 'Readable text saved. Study Helper indexing can run after the helper is ready.',
            percent: 100,
          });
        } else if (skippedEmbeddingIndexing) {
          setProgress({
            phase: 'complete',
            message: 'Readable text saved. Some search indexing can finish after the helper is ready.',
            percent: 100,
          });
        }
      } catch (error) {
        indexingWasSkipped = true;
        console.warn(
          'ALAB saved PDF text but could not finish optional embedding indexing:',
          error
        );
        setProgress({
          phase: 'complete',
          message: 'Readable text saved. Search indexing can be retried after Study Helper is ready.',
          percent: 100,
        });
      }
    }

    setProgress({
      phase: 'complete',
      message: indexingWasSkipped
        ? 'Readable text saved. Ready to study with text search.'
        : 'Ready to study.',
      percent: 100,
    });
    await setStatus('ready');
  } catch (error) {
    await setStatus(
      'failed',
      errorMessageForPdfFailure(error)
    );
  }
}
