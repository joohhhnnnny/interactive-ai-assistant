import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { processSourcePdfPlaceholder } from '../../../../ai/sourceProcessing';
import type { SourceProcessingProgress } from '../../../../ai/sourceProcessing';
import { IconDots, IconPDF, IconPlus } from '../../../../components/icons/icons';
import { BottomSheet } from '../../../../components/ui/BottomSheet';
import { SheetTextInput } from '../../../../components/ui/SheetTextInput';
import { addSource, deleteSource, listSourcesWithProcessingByBook, renameSource, SourceWithProcessing } from '../../../../data/database';
import { Book } from '../../../../types/Book';
import { OfflineAi } from '../types';
import { styles } from './styles';

type Source = Pick<
  SourceWithProcessing,
  | 'id'
  | 'name'
  | 'fileUri'
  | 'fileSize'
  | 'processingStatus'
  | 'processingError'
>;

const maxSourcesPerBook = 5;

type UploadProgress = SourceProcessingProgress & {
  sourceName?: string;
};

export function Sources({
  book,
  offlineAi,
  onSourcesChanged,
}: {
  book: Book;
  offlineAi: OfflineAi;
  onSourcesChanged: () => void;
}) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 700;
  const [sources, setSources] = useState<Source[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [sourceProgressById, setSourceProgressById] = useState<
    Record<string, SourceProcessingProgress>
  >({});
  const [menuSourceId, setMenuSourceId] = useState<string | null>(null);
  const [sourceToRename, setSourceToRename] = useState<Source | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenamingSource, setIsRenamingSource] = useState(false);
  const [sourceToRemove, setSourceToRemove] = useState<Source | null>(null);
  const [isRemovingSource, setIsRemovingSource] = useState(false);
  const hasReachedSourceLimit = sources.length >= maxSourcesPerBook;
  const visibleSources = sources.filter(
    (source) => !sourceProgressById[source.id]
  );

  useEffect(() => {
    let isActive = true;

    listSourcesWithProcessingByBook(book.id)
      .then((rows) => {
        if (!isActive) {
          return;
        }

        setSources(
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            fileUri: row.fileUri,
            fileSize: row.fileSize,
            processingStatus: row.processingStatus,
            processingError: row.processingError,
          }))
        );
        onSourcesChanged();
      })
      .catch(() => {
        if (isActive) {
          setSources([]);
        }
      });

    return () => {
      isActive = false;
    };
  }, [book.id, onSourcesChanged]);

  const sanitizeFilename = (name: string) => {
    const trimmed = name.trim();
    const normalized = trimmed.replace(/[^a-zA-Z0-9._ -]/g, '');
    return normalized.length > 0 ? normalized : `lesson-${Date.now()}.pdf`;
  };

  const ensurePdfName = (name: string) => {
    return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
  };

  const getUploadErrorMessage = (error: unknown) => {
    const code =
      typeof error === 'object' && error && 'code' in error
        ? String((error as { code?: unknown }).code)
        : 'UPLOAD_ERROR';
    const message =
      typeof error === 'object' && error && 'message' in error
        ? String((error as { message?: unknown }).message).trim()
        : '';

    return message
      ? `Please try choosing the PDF again. (${code}: ${message})`
      : `Please try choosing the PDF again. (${code})`;
  };

  const handleUpload = async () => {
    if (isUploading) {
      return;
    }

    if (hasReachedSourceLimit) {
      Alert.alert(
        'PDF limit reached',
        `Each book can have up to ${maxSourcesPerBook} PDFs. Remove one source before uploading another.`
      );
      return;
    }

    Alert.alert(
      'Allow PDF access?',
      'Project Alab will open your file picker so you can choose one lesson PDF for this book.',
      [
        {
          text: 'Not now',
          style: 'cancel',
        },
        {
          text: 'Choose PDF',
          onPress: () => {
            void pickAndSavePdf();
          },
        },
      ]
    );
  };

  const pickAndSavePdf = async () => {
    setIsUploading(true);
    setUploadProgress({
      phase: 'starting',
      message: 'Waiting for PDF selection...',
      percent: 0,
    });

    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: 'application/pdf',
      });

      if (result.canceled) {
        return;
      }

      const selectedPdf = result.assets[0];
      const safeName = ensurePdfName(
        sanitizeFilename(selectedPdf.name || `lesson-${Date.now()}`)
      );
      let storedUri = selectedPdf.uri;

      if (Platform.OS !== 'web') {
        setUploadProgress({
          phase: 'starting',
          message: 'Saving PDF to this book...',
          percent: 1,
          sourceName: safeName,
        });
        const destinationDirectory = new Directory(
          Paths.document,
          'alab',
          'sources',
          book.id
        );
        destinationDirectory.create({ intermediates: true, idempotent: true });
        const destinationFile = new File(
          destinationDirectory,
          `${Date.now()}-${safeName}`
        );
        const sourceFile = new File(selectedPdf.uri);
        await sourceFile.copy(destinationFile);
        storedUri = destinationFile.uri;

        try {
          sourceFile.delete();
        } catch {
          // The picker cache is temporary; keep the saved source if cleanup fails.
        }
      }

      const savedSource = await addSource(book.id, {
        filename: safeName,
        fileUri: storedUri,
        fileSize: selectedPdf.size ?? null,
      });

      if (!savedSource) {
        throw new Error('Source save failed');
      }

      setUploadProgress({
        phase: 'starting',
        message: 'Queued for analysis...',
        percent: 2,
        sourceName: savedSource.name,
      });

      setSources((previous) => [
        {
          id: savedSource.id,
          name: savedSource.name,
          fileUri: savedSource.fileUri,
          fileSize: savedSource.fileSize,
          processingStatus: 'pending',
          processingError: null,
        },
        ...previous,
      ]);

      setSourceProgressById((previous) => ({
        ...previous,
        [savedSource.id]: {
          phase: 'starting',
          message: 'Queued for analysis...',
          percent: 2,
        },
      }));

      await processSourcePdfPlaceholder(savedSource.id, savedSource.fileUri, {
        embedText: offlineAi.embedLessonText,
        modelName: offlineAi.embeddingModelName,
        onStatusChange: (status) => {
          setSources((previous) =>
            previous.map((source) =>
              source.id === savedSource.id
                ? {
                  ...source,
                  processingStatus: status,
                }
                : source
            )
          );
        },
        onProgress: (progress) => {
          setUploadProgress({
            ...progress,
            sourceName: savedSource.name,
          });
          setSourceProgressById((previous) => ({
            ...previous,
            [savedSource.id]: progress,
          }));
        },
      });

      const refreshedSources = await listSourcesWithProcessingByBook(book.id);
      setSources(
        refreshedSources.map((row) => ({
          id: row.id,
          name: row.name,
          fileUri: row.fileUri,
          fileSize: row.fileSize,
          processingStatus: row.processingStatus,
          processingError: row.processingError,
        }))
      );
      onSourcesChanged();
      setSourceProgressById((previous) => {
        const next = { ...previous };
        delete next[savedSource.id];
        return next;
      });
    } catch (error) {
      console.warn('ALAB PDF upload failed:', error);
      Alert.alert('Upload failed', getUploadErrorMessage(error));
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  };

  const handleRemoveSource = async () => {
    if (!sourceToRemove || isRemovingSource) {
      return;
    }

    setIsRemovingSource(true);

    try {
      await deleteSource(sourceToRemove.id);

      if (Platform.OS !== 'web') {
        try {
          const file = new File(sourceToRemove.fileUri);
          file.delete();
        } catch {
          // The database cleanup is the important part for removing AI knowledge.
        }
      }

      setSources((previous) =>
        previous.filter((source) => source.id !== sourceToRemove.id)
      );
      setSourceProgressById((previous) => {
        const next = { ...previous };
        delete next[sourceToRemove.id];
        return next;
      });
      onSourcesChanged();
      setSourceToRemove(null);
      setMenuSourceId(null);
    } catch {
      Alert.alert('Remove failed', 'Please try removing the source again.');
    } finally {
      setIsRemovingSource(false);
    }
  };

  const handleDownloadSource = async (source: Source) => {
    setMenuSourceId(null);

    try {
      if (Platform.OS === 'web') {
        if (typeof document === 'undefined') {
          throw new Error('Downloads are unavailable');
        }

        const anchor = document.createElement('a');
        anchor.href = source.fileUri;
        anchor.download = source.name;
        anchor.rel = 'noopener noreferrer';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        return;
      }

      const canShare = await Sharing.isAvailableAsync();

      if (!canShare) {
        throw new Error('Sharing is unavailable');
      }

      await Sharing.shareAsync(source.fileUri, {
        dialogTitle: 'Download PDF',
        mimeType: 'application/pdf',
        UTI: 'com.adobe.pdf',
      });
    } catch {
      Alert.alert(
        'Download unavailable',
        'ALAB could not open this PDF from this device.'
      );
    }
  };

  const openRenameSource = (source: Source) => {
    setSourceToRename(source);
    setRenameValue(source.name);
    setMenuSourceId(null);
  };

  const handleRenameSource = async () => {
    const nextName = ensurePdfName(sanitizeFilename(renameValue));

    if (!sourceToRename || isRenamingSource || !nextName.trim()) {
      return;
    }

    setIsRenamingSource(true);

    try {
      const renamedSource = await renameSource(sourceToRename.id, nextName);

      if (!renamedSource) {
        throw new Error('Source rename failed');
      }

      setSources((previous) =>
        previous.map((source) =>
          source.id === sourceToRename.id
            ? {
              ...source,
              name: renamedSource.name,
            }
            : source
        )
      );
      setSourceToRename(null);
      setRenameValue('');
    } catch {
      Alert.alert('Rename failed', 'Please try renaming the source again.');
    } finally {
      setIsRenamingSource(false);
    }
  };

  if (sources.length === 0) {
    return (
      <View style={styles.emptySources}>
        <View style={styles.emptySourcesInner}>
          <Text style={styles.centerTitle}>Add your resources</Text>

          <Text style={styles.centerText}>
            Manage your study materials here. Upload PDFs to provide
            ALAB with the knowledge it needs to help you study.
          </Text>
          <Text style={styles.sourceLimitText}>
            Up to {maxSourcesPerBook} PDFs per book.
          </Text>

          <Pressable
            onPress={handleUpload}
            style={({ pressed }) => [
              styles.uploadButton,
              hasReachedSourceLimit && styles.disabledUploadButton,
              pressed && !hasReachedSourceLimit && styles.pressedScale,
            ]}
            disabled={isUploading || hasReachedSourceLimit}
          >
            <IconPlus color="#002576" size={12} />
            <Text style={styles.uploadButtonText}>
              {isUploading ? 'Analyzing PDF...' : 'Upload PDF'}
            </Text>
          </Pressable>

          {uploadProgress ? renderUploadProgress(uploadProgress) : null}
        </View>
      </View>
    );
  }

  return (
    <>
      <ScrollView
        style={styles.tabScroll}
        contentContainerStyle={[
          styles.sourcesContent,
          isTablet && styles.tabletTabContent,
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.centerTitle}>Resources</Text>
        <Text style={styles.sourceLimitText}>
          {sources.length}/{maxSourcesPerBook} PDFs used for this book.
        </Text>

        <Pressable
          onPress={handleUpload}
          style={({ pressed }) => [
            styles.uploadButton,
            hasReachedSourceLimit && styles.disabledUploadButton,
            pressed && !hasReachedSourceLimit && styles.pressedScale,
          ]}
          disabled={isUploading || hasReachedSourceLimit}
        >
          <IconPlus color="#002576" size={12} />
          <Text style={styles.uploadButtonText}>
            {isUploading
              ? 'ANALYZING PDF...'
              : hasReachedSourceLimit
                ? 'PDF LIMIT REACHED'
                : 'UPLOAD PDF'}
          </Text>
        </Pressable>

        {uploadProgress ? renderUploadProgress(uploadProgress) : null}

        <View style={styles.sourceList}>
          {visibleSources.map((source) => {
            return (
              <View
                key={source.id}
                style={[
                  styles.sourceCard,
                  menuSourceId === source.id && styles.activeSourceCard,
                ]}
              >
                <Pressable
                  onPress={() =>
                    setMenuSourceId((current) =>
                      current === source.id ? null : source.id
                    )
                  }
                  style={({ pressed }) => [
                    styles.sourceMenuButton,
                    pressed && styles.pressedScale,
                  ]}
                  hitSlop={10}
                >
                  <IconDots color="#1A1C1C" />
                </Pressable>

                {menuSourceId === source.id ? (
                  <View style={styles.sourceMenu}>
                    <Pressable
                      onPress={() => openRenameSource(source)}
                      style={({ pressed }) => [
                        styles.sourceMenuItem,
                        pressed && styles.menuItemPressed,
                      ]}
                    >
                      <Text style={styles.sourceMenuText}>Rename Source</Text>
                    </Pressable>

                    <Pressable
                      onPress={() => handleDownloadSource(source)}
                      style={({ pressed }) => [
                        styles.sourceMenuItem,
                        pressed && styles.menuItemPressed,
                      ]}
                    >
                      <Text style={styles.sourceMenuText}>Download</Text>
                    </Pressable>

                    <Pressable
                      onPress={() => {
                        setSourceToRemove(source);
                        setMenuSourceId(null);
                      }}
                      style={({ pressed }) => [
                        styles.sourceMenuItem,
                        pressed && styles.menuItemPressed,
                      ]}
                    >
                      <Text style={styles.sourceMenuDangerText}>Remove Resource</Text>
                    </Pressable>
                  </View>
                ) : null}

                <View style={styles.pdfIconCircle}>
                  <IconPDF color="#93000A" size={20} />
                </View>

                <Text style={styles.sourceName} numberOfLines={1}>
                  {source.name}
                </Text>

                <Text
                  style={[
                    styles.sourceStatus,
                    source.processingStatus === 'ready' && styles.readyStatus,
                    source.processingStatus === 'failed' && styles.failedStatus,
                  ]}
                  numberOfLines={source.processingStatus === 'failed' ? 5 : 3}
                >
                  {formatProcessingStatus(source)}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>

      <BottomSheet
        visible={Boolean(sourceToRename)}
        onClose={() => {
          setSourceToRename(null);
          setRenameValue('');
        }}
        title="Rename source"
        snapPoints={['38%']}
      >
        <View style={styles.confirmContent}>
          <Text style={styles.confirmText}>
            Choose a simple name your class will recognize.
          </Text>

          <SheetTextInput
            value={renameValue}
            onChangeText={setRenameValue}
            placeholder="Source name"
            placeholderTextColor="#747685"
            style={styles.renameInput}
            autoCapitalize="sentences"
            returnKeyType="done"
            onSubmitEditing={handleRenameSource}
          />

          <Pressable
            onPress={handleRenameSource}
            disabled={isRenamingSource || !renameValue.trim()}
            style={({ pressed }) => [
              styles.saveButton,
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={styles.saveButtonText}>
              {isRenamingSource ? 'Saving...' : 'Save Name'}
            </Text>
          </Pressable>
        </View>
      </BottomSheet>

      <BottomSheet
        visible={Boolean(sourceToRemove)}
        onClose={() => setSourceToRemove(null)}
        title="Remove source?"
        snapPoints={['34%']}
      >
        <View style={styles.confirmContent}>
          <Text style={styles.confirmText}>
            This removes the PDF from this book and clears its saved study
            knowledge from ALAB.
          </Text>

          <Pressable
            onPress={handleRemoveSource}
            disabled={isRemovingSource}
            style={({ pressed }) => [
              styles.removeButton,
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={styles.removeButtonText}>
              {isRemovingSource ? 'Removing...' : 'Remove Source'}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setSourceToRemove(null)}
            style={({ pressed }) => [
              styles.keepButton,
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={styles.keepButtonText}>Keep Source</Text>
          </Pressable>
        </View>
      </BottomSheet>
    </>
  );
}

function renderUploadProgress(progress: UploadProgress) {
  const title = progress.sourceName ?? 'PDF analysis';
  const details = [
    progress.current && progress.total
      ? `${progress.current}/${progress.total}`
      : null,
    `${progress.percent}%`,
  ].filter(Boolean);

  return (
    <View style={styles.uploadProgressCard}>
      <Text style={styles.uploadProgressTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.uploadProgressDetail}>
        {progress.message}
      </Text>
      <View style={styles.uploadProgressTrack}>
        <View
          style={[
            styles.uploadProgressFill,
            { width: `${Math.max(4, progress.percent)}%` },
          ]}
        />
      </View>
      <Text style={styles.uploadProgressMeta}>
        {details.join(' - ')}
      </Text>
    </View>
  );
}

function formatProcessingStatus(
  source: Source,
  progress?: SourceProcessingProgress
) {
  if (progress) {
    return progress.message;
  }

  switch (source.processingStatus) {
    case 'pending':
      return 'Queued for analysis...';
    case 'extracting':
      return 'Reading PDF pages...';
    case 'chunking':
      return 'Preparing study text...';
    case 'embedding':
      return 'Indexing study chunks...';
    case 'ready':
      return 'Ready to study';
    case 'failed':
      return source.processingError ?? 'Processing failed';
    default:
      return 'Saved source';
  }
}
