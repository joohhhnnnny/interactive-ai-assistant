import { Book } from '../types/Book';
import { StudentProfile } from '../types/StudentProfile';

type WebDatabaseState = {
  books: StoredBook[];
  appSettings: Record<string, string>;
  sources: StoredSource[];
  processingJobs: StoredProcessingJob[];
  pages: StoredSourcePage[];
  chunks: StoredSourceChunk[];
  embeddings: StoredChunkEmbedding[];
  chatSessions: StoredChatSession[];
  chatMessages: StoredChatMessageRow[];
  aiPerformanceMetrics: StoredAiPerformanceMetric[];
  generatedQuizzes: StoredGeneratedItem[];
  generatedFlashcards: StoredGeneratedItem[];
  nextSourceId: number;
  nextBookId: number;
  nextPageId: number;
  nextChunkId: number;
  nextChatSessionId: number;
  nextChatMessageId: number;
  nextAiPerformanceMetricId: number;
  nextGeneratedQuizId: number;
  nextGeneratedFlashcardId: number;
  profile: StudentProfile | null;
};

type StoredBook = {
  id: number;
  title: string;
  description: string | null;
  color: string;
  sourceCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type StoredSource = {
  id: number;
  bookId: number;
  filename: string;
  fileUri: string;
  fileSize: number | null;
  createdAt: string;
};

type StoredProcessingJob = {
  sourceId: number;
  status: SourceProcessingStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
};

type StoredSourcePage = {
  id: number;
  sourceId: number;
  bookId: number;
  pageNumber: number;
  text: string;
  createdAt: string;
};

type StoredSourceChunk = {
  id: number;
  sourceId: number;
  bookId: number;
  chunkIndex: number;
  pageNumber: number | null;
  text: string;
  tokenEstimate: number | null;
  createdAt: string;
};

type StoredChunkEmbedding = {
  chunkId: number;
  modelName: string;
  embedding: number[];
  createdAt: string;
};

type StoredChatSession = {
  id: number;
  bookId: number;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

type StoredChatMessageRow = {
  id: number;
  sessionId: number | null;
  bookId: number;
  role: string;
  text: string;
  sourceChunkIds: string | null;
  createdAt: string;
};

type StoredGeneratedItem = {
  id: number;
  bookId: number;
  sourceChunkIds: string;
  payloadJson: string;
  createdAt: string;
};

type StoredAiPerformanceMetric = {
  id: number;
  bookId: number;
  answerMode: AiAnswerMode;
  confidence: AiAnswerConfidence | null;
  retrievalMs: number | null;
  generationMs: number | null;
  totalMs: number | null;
  sourceCount: number;
  topScore: number | null;
  fallbackReason: string | null;
  outputLength: number;
  showedSources: boolean;
  createdAt: string;
};

export type AiAnswerMode = 'general' | 'grounded' | 'summary' | 'study_tool' | 'status';

export type AiAnswerConfidence = 'none' | 'low' | 'medium' | 'high';

export type AiPerformanceMetric = {
  bookId: string;
  answerMode: AiAnswerMode;
  confidence?: AiAnswerConfidence;
  retrievalMs?: number;
  generationMs?: number;
  totalMs?: number;
  sourceCount?: number;
  topScore?: number | null;
  fallbackReason?: string | null;
  outputLength?: number;
  showedSources?: boolean;
};

export type Source = {
  id: string;
  bookId: string;
  name: string;
  fileUri: string;
  fileSize: number | null;
  createdAt: string;
};

export type SourceProcessingStatus =
  | 'pending'
  | 'extracting'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed';

export type SourceWithProcessing = Source & {
  processingStatus: SourceProcessingStatus | null;
  processingError: string | null;
  processedAt: string | null;
};

export type SourceChunk = {
  id: string;
  sourceId: string;
  bookId: string;
  sourceName: string;
  chunkIndex: number;
  pageNumber: number | null;
  text: string;
  tokenEstimate: number | null;
  createdAt: string;
};

export type EmbeddedSourceChunk = SourceChunk & {
  embeddingModelName: string | null;
  embedding: number[] | null;
};

export type StoredChatMessage = {
  id: string;
  role: 'user' | 'ai';
  text: string;
  sources: string[];
  kind: 'answer' | 'quiz' | 'flashcards' | 'status';
  createdAt: string;
};

const storageKey = 'alab.web.database';
const bookColors = ['#002576', '#E12531', '#D1A600', '#0038a8'];

function createInitialState(): WebDatabaseState {
  return {
    books: [],
    appSettings: {},
    sources: [],
    processingJobs: [],
    pages: [],
    chunks: [],
    embeddings: [],
    chatSessions: [],
    chatMessages: [],
    aiPerformanceMetrics: [],
    generatedQuizzes: [],
    generatedFlashcards: [],
    nextSourceId: 1,
    nextBookId: 1,
    nextPageId: 1,
    nextChunkId: 1,
    nextChatSessionId: 1,
    nextChatMessageId: 1,
    nextAiPerformanceMetricId: 1,
    nextGeneratedQuizId: 1,
    nextGeneratedFlashcardId: 1,
    profile: null,
  };
}

function getStorage() {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
    return null;
  }

  return globalThis.localStorage;
}

function readState(): WebDatabaseState {
  const storage = getStorage();

  if (!storage) {
    return createInitialState();
  }

  const rawState = storage.getItem(storageKey);

  if (!rawState) {
    return createInitialState();
  }

  try {
    return {
      ...createInitialState(),
      ...JSON.parse(rawState),
    };
  } catch {
    return createInitialState();
  }
}

function writeState(state: WebDatabaseState) {
  const storage = getStorage();

  if (!storage) {
    return;
  }

  storage.setItem(storageKey, JSON.stringify(state));
}

function formatBookDate(createdAt: string) {
  const createdDate = new Date(createdAt);

  if (Number.isNaN(createdDate.getTime())) {
    return 'Today';
  }

  return createdDate.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function mapBook(book: StoredBook): Book {
  return {
    id: String(book.id),
    title: book.title,
    description: book.description ?? undefined,
    date: formatBookDate(book.createdAt),
    sources: book.sourceCount,
    color: book.color,
  };
}

function mapSource(source: StoredSource): Source {
  return {
    id: String(source.id),
    bookId: String(source.bookId),
    name: source.filename,
    fileUri: source.fileUri,
    fileSize: source.fileSize,
    createdAt: source.createdAt,
  };
}

function mapChunk(state: WebDatabaseState, chunk: StoredSourceChunk): SourceChunk {
  const source = state.sources.find((item) => item.id === chunk.sourceId);

  return {
    id: String(chunk.id),
    sourceId: String(chunk.sourceId),
    bookId: String(chunk.bookId),
    sourceName: source?.filename ?? 'Unknown source',
    chunkIndex: chunk.chunkIndex,
    pageNumber: chunk.pageNumber,
    text: chunk.text,
    tokenEstimate: chunk.tokenEstimate,
    createdAt: chunk.createdAt,
  };
}

function parseChatMetadata(value: string | null): {
  sources: string[];
  kind: StoredChatMessage['kind'];
} {
  if (!value) {
    return { sources: [], kind: 'answer' };
  }

  try {
    const parsed = JSON.parse(value) as {
      sources?: unknown;
      kind?: unknown;
    };
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter((source): source is string => typeof source === 'string')
      : [];
    const kind =
      parsed.kind === 'quiz' ||
      parsed.kind === 'flashcards' ||
      parsed.kind === 'status' ||
      parsed.kind === 'answer'
        ? parsed.kind
        : 'answer';

    return { sources, kind };
  } catch {
    return { sources: [], kind: 'answer' };
  }
}

function mapChatMessage(message: StoredChatMessageRow): StoredChatMessage | null {
  if (message.role !== 'user' && message.role !== 'ai') {
    return null;
  }

  const metadata = parseChatMetadata(message.sourceChunkIds);

  return {
    id: String(message.id),
    role: message.role,
    text: message.text,
    sources: metadata.sources,
    kind: message.role === 'user' ? 'answer' : metadata.kind,
    createdAt: message.createdAt,
  };
}

function getOrCreateChatSessionId(state: WebDatabaseState, bookId: number) {
  const existing = state.chatSessions
    .filter((session) => session.bookId === bookId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  if (existing) {
    return existing.id;
  }

  const now = new Date().toISOString();
  const session: StoredChatSession = {
    id: state.nextChatSessionId,
    bookId,
    title: null,
    createdAt: now,
    updatedAt: now,
  };

  state.chatSessions.push(session);
  state.nextChatSessionId += 1;

  return session.id;
}

export async function initializeDatabase() {
  const storage = getStorage();

  if (storage && !storage.getItem(storageKey)) {
    writeState(createInitialState());
  }
}

export async function getStudentProfile(): Promise<StudentProfile | null> {
  await initializeDatabase();

  return readState().profile;
}

export async function saveStudentProfile(
  firstName: string,
  lastName: string
) {
  await initializeDatabase();

  const state = readState();

  state.profile = {
    id: 1,
    firstName,
    lastName,
  };

  writeState(state);
}

export async function getAppSetting(key: string): Promise<string | null> {
  await initializeDatabase();

  return readState().appSettings[key] ?? null;
}

export async function saveAppSetting(key: string, value: string) {
  await initializeDatabase();

  const state = readState();
  state.appSettings = {
    ...state.appSettings,
    [key]: value,
  };

  writeState(state);
}

export async function listBooks(): Promise<Book[]> {
  await initializeDatabase();

  return readState().books.filter((book) => !book.archivedAt).map(mapBook);
}

export async function getBookById(id: string): Promise<Book | null> {
  await initializeDatabase();

  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return null;
  }

  const book = readState().books.find(
    (item) => item.id === numericId && !item.archivedAt
  );

  return book ? mapBook(book) : null;
}

export async function createBook(title: string, description: string) {
  await initializeDatabase();

  const state = readState();
  const now = new Date().toISOString();
  const nextBook: StoredBook = {
    id: state.nextBookId,
    title,
    description: description.trim() || null,
    color: bookColors[state.books.length % bookColors.length],
    sourceCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  state.books = [nextBook, ...state.books];
  state.nextBookId += 1;

  writeState(state);

  return mapBook(nextBook);
}

export async function listArchivedBooks(): Promise<Book[]> {
  await initializeDatabase();

  return readState().books.filter((book) => book.archivedAt).map(mapBook);
}

export async function updateBook(
  id: string,
  title: string,
  description: string
) {
  await initializeDatabase();

  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return null;
  }

  const state = readState();
  const book = state.books.find(
    (item) => item.id === numericId && !item.archivedAt
  );

  if (!book) {
    return null;
  }

  book.title = title;
  book.description = description.trim() || null;
  book.updatedAt = new Date().toISOString();

  writeState(state);

  return mapBook(book);
}

export async function archiveBook(id: string) {
  await initializeDatabase();

  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const state = readState();
  const book = state.books.find((item) => item.id === numericId);

  if (!book || book.archivedAt) {
    return;
  }

  const now = new Date().toISOString();

  book.archivedAt = now;
  book.updatedAt = now;

  writeState(state);
}

export async function restoreBook(id: string) {
  await initializeDatabase();

  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const state = readState();
  const book = state.books.find((item) => item.id === numericId);

  if (!book) {
    return;
  }

  book.archivedAt = null;
  book.updatedAt = new Date().toISOString();

  writeState(state);
}

export async function deleteArchivedBookPermanently(id: string) {
  await initializeDatabase();

  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const state = readState();
  const book = state.books.find((item) => item.id === numericId);

  if (!book?.archivedAt) {
    return;
  }

  const sourceIds = state.sources
    .filter((source) => source.bookId === numericId)
    .map((source) => source.id);
  const chunkIds = state.chunks
    .filter((chunk) => chunk.bookId === numericId)
    .map((chunk) => chunk.id);
  const sessionIds = state.chatSessions
    .filter((session) => session.bookId === numericId)
    .map((session) => session.id);

  state.books = state.books.filter((item) => item.id !== numericId);
  state.sources = state.sources.filter((source) => source.bookId !== numericId);
  state.processingJobs = state.processingJobs.filter(
    (job) => !sourceIds.includes(job.sourceId)
  );
  state.pages = state.pages.filter((page) => page.bookId !== numericId);
  state.chunks = state.chunks.filter((chunk) => chunk.bookId !== numericId);
  state.embeddings = state.embeddings.filter(
    (embedding) => !chunkIds.includes(embedding.chunkId)
  );
  state.chatSessions = state.chatSessions.filter(
    (session) => session.bookId !== numericId
  );
  state.chatMessages = state.chatMessages.filter(
    (message) =>
      message.bookId !== numericId &&
      (message.sessionId === null || !sessionIds.includes(message.sessionId))
  );
  state.generatedQuizzes = state.generatedQuizzes.filter(
    (item) => item.bookId !== numericId
  );
  state.generatedFlashcards = state.generatedFlashcards.filter(
    (item) => item.bookId !== numericId
  );

  writeState(state);
}

export async function listSourcesByBook(bookId: string): Promise<Source[]> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return [];
  }

  return readState()
    .sources.filter((source) => source.bookId === numericId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(mapSource);
}

export async function addSource(
  bookId: string,
  source: {
    filename: string;
    fileUri: string;
    fileSize?: number | null;
  }
): Promise<Source | null> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return null;
  }

  const state = readState();
  const now = new Date().toISOString();
  const storedSource: StoredSource = {
    id: state.nextSourceId,
    bookId: numericId,
    filename: source.filename,
    fileUri: source.fileUri,
    fileSize: source.fileSize ?? null,
    createdAt: now,
  };

  state.sources = [storedSource, ...state.sources];
  state.nextSourceId += 1;

  const book = state.books.find((item) => item.id === numericId);
  if (book) {
    book.sourceCount = state.sources.filter(
      (item) => item.bookId === numericId
    ).length;
    book.updatedAt = now;
  }

  state.processingJobs.push({
    sourceId: storedSource.id,
    status: 'pending',
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    processedAt: null,
  });

  writeState(state);

  return mapSource(storedSource);
}

export async function deleteSource(sourceId: string) {
  await initializeDatabase();

  const numericSourceId = Number(sourceId);

  if (!Number.isFinite(numericSourceId)) {
    return;
  }

  const state = readState();
  const source = state.sources.find((item) => item.id === numericSourceId);

  if (!source) {
    return;
  }

  state.sources = state.sources.filter((item) => item.id !== numericSourceId);
  state.processingJobs = state.processingJobs.filter(
    (item) => item.sourceId !== numericSourceId
  );
  state.pages = state.pages.filter((page) => page.sourceId !== numericSourceId);
  const removedChunkIds = state.chunks
    .filter((chunk) => chunk.sourceId === numericSourceId)
    .map((chunk) => chunk.id);
  state.chunks = state.chunks.filter(
    (chunk) => chunk.sourceId !== numericSourceId
  );
  state.embeddings = state.embeddings.filter(
    (embedding) => !removedChunkIds.includes(embedding.chunkId)
  );

  const book = state.books.find((item) => item.id === source.bookId);
  if (book) {
    book.sourceCount = state.sources.filter(
      (item) => item.bookId === source.bookId
    ).length;
    book.updatedAt = new Date().toISOString();
  }

  writeState(state);
}

export async function renameSource(sourceId: string, name: string) {
  await initializeDatabase();

  const numericSourceId = Number(sourceId);
  const nextName = name.trim();

  if (!Number.isFinite(numericSourceId) || !nextName) {
    return null;
  }

  const state = readState();
  const source = state.sources.find((item) => item.id === numericSourceId);

  if (!source) {
    return null;
  }

  source.filename = nextName;
  writeState(state);

  return mapSource(source);
}

export async function listSourcesWithProcessingByBook(
  bookId: string
): Promise<SourceWithProcessing[]> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return [];
  }

  const state = readState();

  return state.sources
    .filter((source) => source.bookId === numericId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((source) => {
      const job = state.processingJobs.find((item) => item.sourceId === source.id);
      const hasEmbeddedChunk = state.chunks.some((chunk) =>
        chunk.sourceId === source.id &&
        state.embeddings.some((embedding) => embedding.chunkId === chunk.id)
      );
      const processingStatus =
        job?.status === 'ready' && !hasEmbeddedChunk ? 'failed' : job?.status ?? null;
      const processingError =
        job?.status === 'ready' && !hasEmbeddedChunk
          ? 'ALAB needs to analyze this book again before it is ready.'
          : job?.errorMessage ?? null;

      return {
        ...mapSource(source),
        processingStatus,
        processingError,
        processedAt: job?.processedAt ?? null,
      };
    });
}

export async function upsertSourceProcessingJob(
  sourceId: string,
  status: SourceProcessingStatus,
  errorMessage?: string | null
) {
  await initializeDatabase();

  const numericId = Number(sourceId);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const state = readState();
  const now = new Date().toISOString();
  const processedAt = status === 'ready' || status === 'failed' ? now : null;
  const job = state.processingJobs.find((item) => item.sourceId === numericId);

  if (job) {
    job.status = status;
    job.errorMessage = errorMessage ?? null;
    job.updatedAt = now;
    job.processedAt = processedAt;
  } else {
    state.processingJobs.push({
      sourceId: numericId,
      status,
      errorMessage: errorMessage ?? null,
      createdAt: now,
      updatedAt: now,
      processedAt,
    });
  }

  writeState(state);
}

export async function hasReadySources(bookId: string): Promise<boolean> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return false;
  }

  const state = readState();

  return state.chunks.some((chunk) => {
    const job = state.processingJobs.find((item) => item.sourceId === chunk.sourceId);
    return chunk.bookId === numericId && isStudyUsableProcessingJob(job);
  });
}

export async function hasReadyStudyChunks(bookId: string): Promise<boolean> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return false;
  }

  const state = readState();
  const readySourceIds = new Set(
    state.processingJobs
      .filter(isStudyUsableProcessingJob)
      .map((job) => job.sourceId)
  );

  return state.chunks.some((chunk) => {
    return chunk.bookId === numericId && readySourceIds.has(chunk.sourceId);
  });
}

function isStudyUsableProcessingJob(job?: {
  status: SourceProcessingStatus;
  errorMessage?: string | null;
}) {
  return (
    job?.status === 'ready' ||
    (
      job?.status === 'failed' &&
      Boolean(job.errorMessage?.startsWith('ALAB saved readable text'))
    )
  );
}

export async function hasProcessingSources(bookId: string): Promise<boolean> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return false;
  }

  const processingStatuses: SourceProcessingStatus[] = [
    'pending',
    'extracting',
    'chunking',
    'embedding',
  ];
  const state = readState();

  return state.sources.some((source) => {
    const job = state.processingJobs.find((item) => item.sourceId === source.id);
    return (
      source.bookId === numericId &&
      Boolean(job && processingStatuses.includes(job.status))
    );
  });
}

export async function saveGeneratedQuiz(
  bookId: string,
  sourceChunkIds: string[],
  quizText: string
) {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const state = readState();
  state.generatedQuizzes.push({
    id: state.nextGeneratedQuizId,
    bookId: numericId,
    sourceChunkIds: JSON.stringify(sourceChunkIds),
    payloadJson: JSON.stringify({ text: quizText }),
    createdAt: new Date().toISOString(),
  });
  state.nextGeneratedQuizId += 1;
  writeState(state);
}

export async function saveGeneratedFlashcards(
  bookId: string,
  sourceChunkIds: string[],
  flashcardsText: string
) {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const state = readState();
  state.generatedFlashcards.push({
    id: state.nextGeneratedFlashcardId,
    bookId: numericId,
    sourceChunkIds: JSON.stringify(sourceChunkIds),
    payloadJson: JSON.stringify({ text: flashcardsText }),
    createdAt: new Date().toISOString(),
  });
  state.nextGeneratedFlashcardId += 1;
  writeState(state);
}

export async function listRecentChatMessagesByBook(
  bookId: string
): Promise<StoredChatMessage[]> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return [];
  }

  return readState()
    .chatMessages.filter((message) => message.bookId === numericId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
    .map(mapChatMessage)
    .filter((message): message is StoredChatMessage => Boolean(message));
}

export async function appendChatMessage(
  bookId: string,
  message: {
    role: 'user' | 'ai';
    text: string;
    sources?: string[];
    kind?: StoredChatMessage['kind'];
  }
) {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return null;
  }

  const state = readState();
  const now = new Date().toISOString();
  const sessionId = getOrCreateChatSessionId(state, numericId);
  const storedMessage: StoredChatMessageRow = {
    id: state.nextChatMessageId,
    sessionId,
    bookId: numericId,
    role: message.role,
    text: message.text,
    sourceChunkIds: JSON.stringify({
      sources: message.sources ?? [],
      kind: message.kind ?? 'answer',
    }),
    createdAt: now,
  };

  state.chatMessages.push(storedMessage);
  state.nextChatMessageId += 1;

  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (session) {
    session.updatedAt = now;
  }

  writeState(state);
  await pruneChatMessagesByBook(bookId);

  return mapChatMessage(storedMessage);
}

export async function saveAiPerformanceMetric(metric: AiPerformanceMetric) {
  await initializeDatabase();

  const numericId = Number(metric.bookId);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const state = readState();
  const storedMetric: StoredAiPerformanceMetric = {
    id: state.nextAiPerformanceMetricId,
    bookId: numericId,
    answerMode: metric.answerMode,
    confidence: metric.confidence ?? null,
    retrievalMs: metric.retrievalMs ?? null,
    generationMs: metric.generationMs ?? null,
    totalMs: metric.totalMs ?? null,
    sourceCount: metric.sourceCount ?? 0,
    topScore: metric.topScore ?? null,
    fallbackReason: metric.fallbackReason ?? null,
    outputLength: metric.outputLength ?? 0,
    showedSources: Boolean(metric.showedSources),
    createdAt: new Date().toISOString(),
  };

  state.aiPerformanceMetrics.push(storedMetric);
  state.nextAiPerformanceMetricId += 1;
  writeState(state);
}

export async function pruneChatMessagesByBook(bookId: string, maxStudentTurns = 20) {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const state = readState();
  const studentTurns = state.chatMessages
    .filter((message) => message.bookId === numericId && message.role === 'user')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);

  if (studentTurns.length <= maxStudentTurns) {
    return;
  }

  const keptBoundary = studentTurns
    .slice(0, maxStudentTurns)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)[0];

  if (!keptBoundary) {
    return;
  }

  state.chatMessages = state.chatMessages.filter(
    (message) =>
      message.bookId !== numericId ||
      message.createdAt > keptBoundary.createdAt ||
      message.id >= keptBoundary.id
  );

  writeState(state);
}

export async function replaceSourcePages(
  sourceId: string,
  pages: { pageNumber: number; text: string }[]
) {
  await initializeDatabase();

  const numericSourceId = Number(sourceId);

  if (!Number.isFinite(numericSourceId)) {
    return;
  }

  const state = readState();
  const source = state.sources.find((item) => item.id === numericSourceId);

  if (!source) {
    return;
  }

  const now = new Date().toISOString();
  state.pages = state.pages.filter((page) => page.sourceId !== numericSourceId);

  for (const page of pages) {
    state.pages.push({
      id: state.nextPageId,
      sourceId: numericSourceId,
      bookId: source.bookId,
      pageNumber: page.pageNumber,
      text: page.text,
      createdAt: now,
    });
    state.nextPageId += 1;
  }

  writeState(state);
}

export async function replaceSourceChunks(
  sourceId: string,
  chunks: {
    chunkIndex: number;
    pageNumber?: number | null;
    text: string;
    tokenEstimate?: number | null;
  }[]
) {
  await initializeDatabase();

  const numericSourceId = Number(sourceId);

  if (!Number.isFinite(numericSourceId)) {
    return [];
  }

  const state = readState();
  const source = state.sources.find((item) => item.id === numericSourceId);

  if (!source) {
    return [];
  }

  const now = new Date().toISOString();
  state.chunks = state.chunks.filter((chunk) => chunk.sourceId !== numericSourceId);
  state.embeddings = state.embeddings.filter((embedding) =>
    state.chunks.some((chunk) => chunk.id === embedding.chunkId)
  );

  const insertedChunks: SourceChunk[] = [];

  for (const chunk of chunks) {
    const storedChunk: StoredSourceChunk = {
      id: state.nextChunkId,
      sourceId: numericSourceId,
      bookId: source.bookId,
      chunkIndex: chunk.chunkIndex,
      pageNumber: chunk.pageNumber ?? null,
      text: chunk.text,
      tokenEstimate: chunk.tokenEstimate ?? null,
      createdAt: now,
    };

    state.chunks.push(storedChunk);
    state.nextChunkId += 1;
    insertedChunks.push(mapChunk(state, storedChunk));
  }

  writeState(state);

  return insertedChunks;
}

export async function saveChunkEmbedding(
  chunkId: string,
  modelName: string,
  embedding: ArrayLike<number>
) {
  await initializeDatabase();

  const numericChunkId = Number(chunkId);

  if (!Number.isFinite(numericChunkId)) {
    return;
  }

  const state = readState();
  const now = new Date().toISOString();
  const existing = state.embeddings.find((item) => item.chunkId === numericChunkId);

  if (existing) {
    existing.modelName = modelName;
    existing.embedding = Array.from(embedding);
    existing.createdAt = now;
  } else {
    state.embeddings.push({
      chunkId: numericChunkId,
      modelName,
      embedding: Array.from(embedding),
      createdAt: now,
    });
  }

  writeState(state);
}

export async function listEmbeddedChunksByBook(
  bookId: string,
  modelName?: string
): Promise<EmbeddedSourceChunk[]> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return [];
  }

  const state = readState();

  return state.chunks
    .filter((chunk) => chunk.bookId === numericId)
    .sort((a, b) => a.sourceId - b.sourceId || a.chunkIndex - b.chunkIndex)
    .map((chunk) => {
      const storedEmbedding = state.embeddings.find(
        (embedding) => embedding.chunkId === chunk.id
      );

      return {
        ...mapChunk(state, chunk),
        embeddingModelName: storedEmbedding?.modelName ?? null,
        embedding: storedEmbedding?.embedding ?? null,
      };
    })
    .filter(
      (chunk) => !modelName || chunk.embeddingModelName === modelName
    );
}

export async function listSourceChunksByBook(
  bookId: string,
  limit = 8
): Promise<SourceChunk[]> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return [];
  }

  const state = readState();

  return state.chunks
    .filter((chunk) => chunk.bookId === numericId)
    .sort((a, b) => a.sourceId - b.sourceId || a.chunkIndex - b.chunkIndex)
    .slice(0, limit)
    .map((chunk) => mapChunk(state, chunk));
}

export async function searchChunksByText(
  bookId: string,
  query: string,
  limit = 5
): Promise<SourceChunk[]> {
  await initializeDatabase();

  const numericId = Number(bookId);
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 8);

  if (!Number.isFinite(numericId) || terms.length === 0) {
    return [];
  }

  const state = readState();

  return state.chunks
    .filter(
      (chunk) =>
        chunk.bookId === numericId &&
        terms.some((term) => chunk.text.toLowerCase().includes(term))
    )
    .sort((a, b) => a.sourceId - b.sourceId || a.chunkIndex - b.chunkIndex)
    .slice(0, limit)
    .map((chunk) => mapChunk(state, chunk));
}
