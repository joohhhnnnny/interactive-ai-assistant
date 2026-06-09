import * as SQLite from 'expo-sqlite';
import { Book } from '../types/Book';
import { StudentProfile } from '../types/StudentProfile';

type BookRow = {
  id: number;
  title: string;
  description: string | null;
  color: string;
  source_count: number;
  created_at: string;
  archived_at: string | null;
};

type StudentProfileRow = {
  id: number;
  first_name: string;
  last_name: string;
};

type AppSettingRow = {
  key: string;
  value: string;
};

type SourceRow = {
  id: number;
  book_id: number;
  filename: string;
  file_uri: string;
  file_size: number | null;
  created_at: string;
};

type SourceWithProcessingRow = SourceRow & {
  processing_status: SourceProcessingStatus | null;
  processing_error: string | null;
  processed_at: string | null;
};

type ChunkRow = {
  id: number;
  source_id: number;
  book_id: number;
  chunk_index: number;
  page_number: number | null;
  text: string;
  token_estimate: number | null;
  created_at: string;
  source_name: string;
};

type ChunkEmbeddingRow = {
  chunk_id: number;
  embedding_json: string;
};

type ChatMessageRow = {
  id: number;
  role: string;
  text: string;
  source_chunk_ids: string | null;
  created_at: string;
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

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

const bookColors = ['#002576', '#E12531', '#D1A600', '#0038a8'];

function getDatabase() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync('alab.db');
  }

  return databasePromise;
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

function mapBookRow(row: BookRow): Book {
  return {
    id: String(row.id),
    title: row.title,
    description: row.description ?? undefined,
    date: formatBookDate(row.created_at),
    sources: row.source_count,
    color: row.color,
  };
}

export async function initializeDatabase() {
  const database = await getDatabase();

  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS student_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL,
      source_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      file_uri TEXT NOT NULL,
      file_size INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sources_book_id ON sources(book_id);

    CREATE TABLE IF NOT EXISTS source_processing_jobs (
      source_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processed_at TEXT,
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      book_id INTEGER NOT NULL,
      page_number INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      book_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      page_number INTEGER,
      text TEXT NOT NULL,
      token_estimate INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      model_name TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES source_chunks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      book_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      source_chunk_ids TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generated_quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      source_chunk_ids TEXT NOT NULL,
      quiz_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generated_flashcards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      source_chunk_ids TEXT NOT NULL,
      flashcards_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_source_pages_source_id ON source_pages(source_id);
    CREATE INDEX IF NOT EXISTS idx_source_pages_book_id ON source_pages(book_id);
    CREATE INDEX IF NOT EXISTS idx_source_chunks_source_id ON source_chunks(source_id);
    CREATE INDEX IF NOT EXISTS idx_source_chunks_book_id ON source_chunks(book_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_book_id ON chat_messages(book_id);
  `);

  const columns = await database.getAllAsync<{ name: string }>(
    'PRAGMA table_info(books)'
  );

  if (!columns.some((column) => column.name === 'archived_at')) {
    await database.execAsync('ALTER TABLE books ADD COLUMN archived_at TEXT;');
  }
}

function mapSourceRow(row: SourceRow): Source {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    name: row.filename,
    fileUri: row.file_uri,
    fileSize: row.file_size ?? null,
    createdAt: row.created_at,
  };
}

function mapSourceWithProcessingRow(row: SourceWithProcessingRow): SourceWithProcessing {
  return {
    ...mapSourceRow(row),
    processingStatus: row.processing_status,
    processingError: row.processing_error,
    processedAt: row.processed_at,
  };
}

function mapChunkRow(row: ChunkRow): SourceChunk {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    bookId: String(row.book_id),
    sourceName: row.source_name,
    chunkIndex: row.chunk_index,
    pageNumber: row.page_number ?? null,
    text: row.text,
    tokenEstimate: row.token_estimate ?? null,
    createdAt: row.created_at,
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

function mapChatMessageRow(row: ChatMessageRow): StoredChatMessage | null {
  if (row.role !== 'user' && row.role !== 'ai') {
    return null;
  }

  const metadata = parseChatMetadata(row.source_chunk_ids);

  return {
    id: String(row.id),
    role: row.role,
    text: row.text,
    sources: metadata.sources,
    kind: row.role === 'user' ? 'answer' : metadata.kind,
    createdAt: row.created_at,
  };
}

async function getOrCreateChatSessionId(bookId: string) {
  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return null;
  }

  const database = await getDatabase();
  const existing = await database.getFirstAsync<{ id: number }>(
    `SELECT id
     FROM chat_sessions
     WHERE book_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
    numericId
  );

  if (existing) {
    return existing.id;
  }

  const now = new Date().toISOString();
  const result = await database.runAsync(
    `INSERT INTO chat_sessions (book_id, title, created_at, updated_at)
     VALUES (?, NULL, ?, ?)`,
    numericId,
    now,
    now
  );

  return result.lastInsertRowId;
}

export async function getStudentProfile(): Promise<StudentProfile | null> {
  await initializeDatabase();

  const database = await getDatabase();
  const row = await database.getFirstAsync<StudentProfileRow>(
    'SELECT id, first_name, last_name FROM student_profile WHERE id = 1'
  );

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
  };
}

export async function saveStudentProfile(
  firstName: string,
  lastName: string
) {
  await initializeDatabase();

  const database = await getDatabase();
  const now = new Date().toISOString();

  await database.runAsync(
    `INSERT INTO student_profile (id, first_name, last_name, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       updated_at = excluded.updated_at`,
    firstName,
    lastName,
    now
  );
}

export async function getAppSetting(key: string): Promise<string | null> {
  await initializeDatabase();

  const database = await getDatabase();
  const row = await database.getFirstAsync<AppSettingRow>(
    'SELECT key, value FROM app_settings WHERE key = ?',
    key
  );

  return row?.value ?? null;
}

export async function saveAppSetting(key: string, value: string) {
  await initializeDatabase();

  const database = await getDatabase();
  const now = new Date().toISOString();

  await database.runAsync(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    key,
    value,
    now
  );
}

export async function listBooks(): Promise<Book[]> {
  await initializeDatabase();

  const database = await getDatabase();
  const rows = await database.getAllAsync<BookRow>(
    `SELECT id, title, description, color, source_count, created_at, archived_at
     FROM books
     WHERE archived_at IS NULL
     ORDER BY created_at DESC`
  );

  return rows.map(mapBookRow);
}

export async function getBookById(id: string): Promise<Book | null> {
  await initializeDatabase();

  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return null;
  }

  const database = await getDatabase();
  const row = await database.getFirstAsync<BookRow>(
    `SELECT id, title, description, color, source_count, created_at, archived_at
     FROM books
     WHERE id = ? AND archived_at IS NULL`,
    numericId
  );

  return row ? mapBookRow(row) : null;
}

export async function createBook(title: string, description: string) {
  await initializeDatabase();

  const database = await getDatabase();
  const now = new Date().toISOString();
  const countRow = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM books'
  );
  const color = bookColors[(countRow?.count ?? 0) % bookColors.length];
  const result = await database.runAsync(
    `INSERT INTO books (title, description, color, source_count, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
    title,
    description.trim() || null,
    color,
    now,
    now
  );

  return getBookById(String(result.lastInsertRowId));
}

export async function listArchivedBooks(): Promise<Book[]> {
  await initializeDatabase();

  const database = await getDatabase();
  const rows = await database.getAllAsync<BookRow>(
    `SELECT id, title, description, color, source_count, created_at, archived_at
     FROM books
     WHERE archived_at IS NOT NULL
     ORDER BY archived_at DESC`
  );

  return rows.map(mapBookRow);
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

  const database = await getDatabase();
  const now = new Date().toISOString();

  await database.runAsync(
    `UPDATE books
     SET title = ?, description = ?, updated_at = ?
     WHERE id = ? AND archived_at IS NULL`,
    title,
    description.trim() || null,
    now,
    numericId
  );

  return getBookById(id);
}

export async function archiveBook(id: string) {
  await initializeDatabase();

  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const database = await getDatabase();
  const now = new Date().toISOString();

  await database.runAsync(
    `UPDATE books
     SET archived_at = ?, updated_at = ?
     WHERE id = ? AND archived_at IS NULL`,
    now,
    now,
    numericId
  );
}

export async function restoreBook(id: string) {
  await initializeDatabase();

  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const database = await getDatabase();
  const now = new Date().toISOString();

  await database.runAsync(
    `UPDATE books
     SET archived_at = NULL, updated_at = ?
     WHERE id = ?`,
    now,
    numericId
  );
}

export async function deleteArchivedBookPermanently(id: string) {
  await initializeDatabase();

  const numericId = Number(id);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const database = await getDatabase();
  await database.runAsync(
    'DELETE FROM books WHERE id = ? AND archived_at IS NOT NULL',
    numericId
  );
}

export async function listSourcesByBook(bookId: string): Promise<Source[]> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return [];
  }

  const database = await getDatabase();
  const rows = await database.getAllAsync<SourceRow>(
    `SELECT id, book_id, filename, file_uri, file_size, created_at
     FROM sources
     WHERE book_id = ?
     ORDER BY created_at DESC`,
    numericId
  );

  return rows.map(mapSourceRow);
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

  const database = await getDatabase();
  const now = new Date().toISOString();
  const result = await database.runAsync(
    `INSERT INTO sources (book_id, filename, file_uri, file_size, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    numericId,
    source.filename,
    source.fileUri,
    source.fileSize ?? null,
    now
  );

  await database.runAsync(
    `UPDATE books
     SET source_count = (
       SELECT COUNT(*) FROM sources WHERE book_id = ?
     ),
     updated_at = ?
     WHERE id = ?`,
    numericId,
    now,
    numericId
  );

  const row = await database.getFirstAsync<SourceRow>(
    `SELECT id, book_id, filename, file_uri, file_size, created_at
     FROM sources
     WHERE id = ?`,
    result.lastInsertRowId
  );

  if (row) {
    await upsertSourceProcessingJob(String(row.id), 'pending');
  }

  return row ? mapSourceRow(row) : null;
}

export async function deleteSource(sourceId: string) {
  await initializeDatabase();

  const numericSourceId = Number(sourceId);

  if (!Number.isFinite(numericSourceId)) {
    return;
  }

  const database = await getDatabase();
  const source = await database.getFirstAsync<SourceRow>(
    `SELECT id, book_id, filename, file_uri, file_size, created_at
     FROM sources
     WHERE id = ?`,
    numericSourceId
  );

  if (!source) {
    return;
  }

  const now = new Date().toISOString();

  await database.runAsync('DELETE FROM sources WHERE id = ?', numericSourceId);
  await database.runAsync(
    `UPDATE books
     SET source_count = (
       SELECT COUNT(*) FROM sources WHERE book_id = ?
     ),
     updated_at = ?
     WHERE id = ?`,
    source.book_id,
    now,
    source.book_id
  );
}

export async function renameSource(sourceId: string, name: string) {
  await initializeDatabase();

  const numericSourceId = Number(sourceId);
  const nextName = name.trim();

  if (!Number.isFinite(numericSourceId) || !nextName) {
    return null;
  }

  const database = await getDatabase();
  await database.runAsync(
    `UPDATE sources
     SET filename = ?
     WHERE id = ?`,
    nextName,
    numericSourceId
  );

  const row = await database.getFirstAsync<SourceRow>(
    `SELECT id, book_id, filename, file_uri, file_size, created_at
     FROM sources
     WHERE id = ?`,
    numericSourceId
  );

  return row ? mapSourceRow(row) : null;
}

export async function listSourcesWithProcessingByBook(
  bookId: string
): Promise<SourceWithProcessing[]> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return [];
  }

  const database = await getDatabase();
  const rows = await database.getAllAsync<SourceWithProcessingRow>(
    `SELECT sources.id,
            sources.book_id,
            sources.filename,
            sources.file_uri,
            sources.file_size,
            sources.created_at,
            source_processing_jobs.status AS processing_status,
            source_processing_jobs.error_message AS processing_error,
            source_processing_jobs.processed_at
     FROM sources
     LEFT JOIN source_processing_jobs
       ON source_processing_jobs.source_id = sources.id
     WHERE sources.book_id = ?
     ORDER BY sources.created_at DESC`,
    numericId
  );

  return rows.map(mapSourceWithProcessingRow);
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

  const database = await getDatabase();
  const now = new Date().toISOString();
  const processedAt = status === 'ready' || status === 'failed' ? now : null;

  await database.runAsync(
    `INSERT INTO source_processing_jobs (
       source_id, status, error_message, created_at, updated_at, processed_at
     )
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       status = excluded.status,
       error_message = excluded.error_message,
       updated_at = excluded.updated_at,
       processed_at = excluded.processed_at`,
    numericId,
    status,
    errorMessage ?? null,
    now,
    now,
    processedAt
  );
}

export async function hasReadySources(bookId: string): Promise<boolean> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return false;
  }

  const database = await getDatabase();
  const row = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM sources
     INNER JOIN source_processing_jobs
       ON source_processing_jobs.source_id = sources.id
     WHERE sources.book_id = ? AND source_processing_jobs.status = 'ready'`,
    numericId
  );

  return (row?.count ?? 0) > 0;
}

export async function hasReadyStudyChunks(bookId: string): Promise<boolean> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return false;
  }

  const database = await getDatabase();
  const row = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM source_chunks
     INNER JOIN source_processing_jobs
       ON source_processing_jobs.source_id = source_chunks.source_id
     WHERE source_chunks.book_id = ? AND source_processing_jobs.status = 'ready'`,
    numericId
  );

  return (row?.count ?? 0) > 0;
}

export async function hasProcessingSources(bookId: string): Promise<boolean> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return false;
  }

  const database = await getDatabase();
  const row = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM sources
     INNER JOIN source_processing_jobs
       ON source_processing_jobs.source_id = sources.id
     WHERE sources.book_id = ?
       AND source_processing_jobs.status IN ('pending', 'extracting', 'chunking', 'embedding')`,
    numericId
  );

  return (row?.count ?? 0) > 0;
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

  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO generated_quizzes (book_id, source_chunk_ids, quiz_json, created_at)
     VALUES (?, ?, ?, ?)`,
    numericId,
    JSON.stringify(sourceChunkIds),
    JSON.stringify({ text: quizText }),
    new Date().toISOString()
  );
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

  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO generated_flashcards (
       book_id, source_chunk_ids, flashcards_json, created_at
     )
     VALUES (?, ?, ?, ?)`,
    numericId,
    JSON.stringify(sourceChunkIds),
    JSON.stringify({ text: flashcardsText }),
    new Date().toISOString()
  );
}

export async function listRecentChatMessagesByBook(
  bookId: string
): Promise<StoredChatMessage[]> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return [];
  }

  const database = await getDatabase();
  const rows = await database.getAllAsync<ChatMessageRow>(
    `SELECT id, role, text, source_chunk_ids, created_at
     FROM chat_messages
     WHERE book_id = ?
     ORDER BY created_at ASC, id ASC`,
    numericId
  );

  return rows.map(mapChatMessageRow).filter((message): message is StoredChatMessage => Boolean(message));
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
  const sessionId = await getOrCreateChatSessionId(bookId);

  if (!Number.isFinite(numericId) || !sessionId) {
    return null;
  }

  const database = await getDatabase();
  const now = new Date().toISOString();
  const metadata = JSON.stringify({
    sources: message.sources ?? [],
    kind: message.kind ?? 'answer',
  });
  const result = await database.runAsync(
    `INSERT INTO chat_messages (
       session_id, book_id, role, text, source_chunk_ids, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId,
    numericId,
    message.role,
    message.text,
    metadata,
    now
  );

  await database.runAsync(
    'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
    now,
    sessionId
  );
  await pruneChatMessagesByBook(bookId);

  return {
    id: String(result.lastInsertRowId),
    role: message.role,
    text: message.text,
    sources: message.sources ?? [],
    kind: message.role === 'user' ? 'answer' : message.kind ?? 'answer',
    createdAt: now,
  } satisfies StoredChatMessage;
}

export async function pruneChatMessagesByBook(bookId: string, maxStudentTurns = 20) {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return;
  }

  const database = await getDatabase();
  const keptBoundary = await database.getFirstAsync<{ created_at: string }>(
    `SELECT created_at
     FROM (
       SELECT created_at
       FROM chat_messages
       WHERE book_id = ? AND role = 'user'
       ORDER BY created_at DESC, id DESC
       LIMIT ?
     )
     ORDER BY created_at ASC
     LIMIT 1`,
    numericId,
    maxStudentTurns
  );

  if (!keptBoundary) {
    return;
  }

  const countRow = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM chat_messages
     WHERE book_id = ? AND role = 'user'`,
    numericId
  );

  if ((countRow?.count ?? 0) <= maxStudentTurns) {
    return;
  }

  await database.runAsync(
    'DELETE FROM chat_messages WHERE book_id = ? AND created_at < ?',
    numericId,
    keptBoundary.created_at
  );
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

  const database = await getDatabase();
  const source = await database.getFirstAsync<SourceRow>(
    `SELECT id, book_id, filename, file_uri, file_size, created_at
     FROM sources
     WHERE id = ?`,
    numericSourceId
  );

  if (!source) {
    return;
  }

  const now = new Date().toISOString();
  await database.runAsync('DELETE FROM source_pages WHERE source_id = ?', numericSourceId);

  for (const page of pages) {
    await database.runAsync(
      `INSERT INTO source_pages (source_id, book_id, page_number, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      numericSourceId,
      source.book_id,
      page.pageNumber,
      page.text,
      now
    );
  }
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

  const database = await getDatabase();
  const source = await database.getFirstAsync<SourceRow>(
    `SELECT id, book_id, filename, file_uri, file_size, created_at
     FROM sources
     WHERE id = ?`,
    numericSourceId
  );

  if (!source) {
    return [];
  }

  const now = new Date().toISOString();
  await database.runAsync('DELETE FROM source_chunks WHERE source_id = ?', numericSourceId);

  const insertedChunks: SourceChunk[] = [];

  for (const chunk of chunks) {
    const result = await database.runAsync(
      `INSERT INTO source_chunks (
         source_id, book_id, chunk_index, page_number, text, token_estimate, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      numericSourceId,
      source.book_id,
      chunk.chunkIndex,
      chunk.pageNumber ?? null,
      chunk.text,
      chunk.tokenEstimate ?? null,
      now
    );

    insertedChunks.push({
      id: String(result.lastInsertRowId),
      sourceId: String(source.id),
      bookId: String(source.book_id),
      sourceName: source.filename,
      chunkIndex: chunk.chunkIndex,
      pageNumber: chunk.pageNumber ?? null,
      text: chunk.text,
      tokenEstimate: chunk.tokenEstimate ?? null,
      createdAt: now,
    });
  }

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

  const database = await getDatabase();
  const now = new Date().toISOString();
  const embeddingJson = JSON.stringify(Array.from(embedding));

  await database.runAsync(
    `INSERT INTO chunk_embeddings (chunk_id, model_name, embedding_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chunk_id) DO UPDATE SET
       model_name = excluded.model_name,
       embedding_json = excluded.embedding_json,
       created_at = excluded.created_at`,
    numericChunkId,
    modelName,
    embeddingJson,
    now
  );
}

export async function listEmbeddedChunksByBook(
  bookId: string
): Promise<EmbeddedSourceChunk[]> {
  await initializeDatabase();

  const numericId = Number(bookId);

  if (!Number.isFinite(numericId)) {
    return [];
  }

  const database = await getDatabase();
  const rows = await database.getAllAsync<ChunkRow & Partial<ChunkEmbeddingRow>>(
    `SELECT source_chunks.id,
            source_chunks.source_id,
            source_chunks.book_id,
            source_chunks.chunk_index,
            source_chunks.page_number,
            source_chunks.text,
            source_chunks.token_estimate,
            source_chunks.created_at,
            sources.filename AS source_name,
            chunk_embeddings.embedding_json
     FROM source_chunks
     INNER JOIN sources ON sources.id = source_chunks.source_id
     LEFT JOIN chunk_embeddings ON chunk_embeddings.chunk_id = source_chunks.id
     WHERE source_chunks.book_id = ?
     ORDER BY source_chunks.source_id ASC, source_chunks.chunk_index ASC`,
    numericId
  );

  return rows.map((row) => ({
    ...mapChunkRow(row),
    embedding: row.embedding_json ? JSON.parse(row.embedding_json) : null,
  }));
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

  const database = await getDatabase();
  const rows = await database.getAllAsync<ChunkRow>(
    `SELECT source_chunks.id,
            source_chunks.source_id,
            source_chunks.book_id,
            source_chunks.chunk_index,
            source_chunks.page_number,
            source_chunks.text,
            source_chunks.token_estimate,
            source_chunks.created_at,
            sources.filename AS source_name
     FROM source_chunks
     INNER JOIN sources ON sources.id = source_chunks.source_id
     WHERE source_chunks.book_id = ?
     ORDER BY source_chunks.source_id ASC, source_chunks.chunk_index ASC
     LIMIT ?`,
    numericId,
    limit
  );

  return rows.map(mapChunkRow);
}

export async function searchChunksByText(
  bookId: string,
  query: string,
  limit = 5
): Promise<SourceChunk[]> {
  await initializeDatabase();

  const numericId = Number(bookId);
  const cleanQuery = query.trim();

  if (!Number.isFinite(numericId) || !cleanQuery) {
    return [];
  }

  const database = await getDatabase();
  const terms = cleanQuery
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 8);

  if (terms.length === 0) {
    return [];
  }

  const whereClause = terms.map(() => 'LOWER(source_chunks.text) LIKE ?').join(' OR ');
  const parameters = [
    numericId,
    ...terms.map((term) => `%${term.toLowerCase()}%`),
    limit,
  ];
  const rows = await database.getAllAsync<ChunkRow>(
    `SELECT source_chunks.id,
            source_chunks.source_id,
            source_chunks.book_id,
            source_chunks.chunk_index,
            source_chunks.page_number,
            source_chunks.text,
            source_chunks.token_estimate,
            source_chunks.created_at,
            sources.filename AS source_name
     FROM source_chunks
     INNER JOIN sources ON sources.id = source_chunks.source_id
     WHERE source_chunks.book_id = ? AND (${whereClause})
     ORDER BY source_chunks.chunk_index ASC
     LIMIT ?`,
    ...parameters
  );

  return rows.map(mapChunkRow);
}
