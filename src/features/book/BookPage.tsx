import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  KeyboardAwareScrollView,
  KeyboardAwareScrollViewRef,
} from 'react-native-keyboard-controller';
import {
  IconChevronRight,
  IconDots,
  IconFlashcard,
  IconPDF,
  IconPlus,
  IconQuiz,
  IconSend,
} from '../../components/icons/icons';
import { AppHeader } from '../../components/layout/AppHeader';
import { Screen } from '../../components/layout/Screen';
import { BookBottomNav, BookTab } from '../../components/navigation/BookBottomNav';
import { BottomSheet } from '../../components/ui/BottomSheet';
import { processSourcePdfPlaceholder } from '../../ai/sourceProcessing';
import { useOfflineAi } from '../../ai/useOfflineAi';
import {
  addSource,
  appendChatMessage,
  deleteSource,
  hasProcessingSources,
  listRecentChatMessagesByBook,
  listSourcesWithProcessingByBook,
  renameSource,
  SourceWithProcessing,
  StoredChatMessage,
} from '../../data/database';
import { Book } from '../../types/Book';

type Source = Pick<
  SourceWithProcessing,
  | 'id'
  | 'name'
  | 'fileUri'
  | 'fileSize'
  | 'processingStatus'
  | 'processingError'
>;

type ChatMessage = {
  id: string;
  role: 'user' | 'ai';
  text: string;
  sources?: string[];
  kind?: 'answer' | 'quiz' | 'flashcards' | 'status';
};

type QuizQuestion = {
  question: string;
  options: string[];
  answer: string;
  explanation?: string;
};

type MarkdownSegment = {
  text: string;
  bold: boolean;
};

type PendingChatPrompt = {
  id: number;
  text: string;
};

function SourcesTab({ book }: { book: Book }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 700;
  const [sources, setSources] = useState<Source[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [menuSourceId, setMenuSourceId] = useState<string | null>(null);
  const [sourceToRename, setSourceToRename] = useState<Source | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenamingSource, setIsRenamingSource] = useState(false);
  const [sourceToRemove, setSourceToRemove] = useState<Source | null>(null);
  const [isRemovingSource, setIsRemovingSource] = useState(false);
  const offlineAi = useOfflineAi(book.id, book.title);

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
      })
      .catch(() => {
        if (isActive) {
          setSources([]);
        }
      });

    return () => {
      isActive = false;
    };
  }, [book.id]);

  const sanitizeFilename = (name: string) => {
    const trimmed = name.trim();
    const normalized = trimmed.replace(/[^a-zA-Z0-9._ -]/g, '');
    return normalized.length > 0 ? normalized : `lesson-${Date.now()}.pdf`;
  };

  const ensurePdfName = (name: string) => {
    return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
  };

  const handleUpload = async () => {
    if (isUploading) {
      return;
    }

    setIsUploading(true);

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
    } catch {
      Alert.alert('Upload failed', 'Please try choosing the PDF again.');
    } finally {
      setIsUploading(false);
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
            Manage your study materials here. Upload PDFs or images to provide
            ALAB with the knowledge it needs to help you study.
          </Text>

          <Pressable
            onPress={handleUpload}
            style={({ pressed }) => [
              styles.uploadButton,
              pressed && styles.pressedScale,
            ]}
            disabled={isUploading}
          >
            <IconPlus color="#002576" size={12} />
      <Text style={styles.uploadButtonText}>
              {isUploading ? 'Analyzing...' : 'Upload PDF'}
            </Text>
          </Pressable>
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

        <Pressable
          onPress={handleUpload}
          style={({ pressed }) => [
            styles.uploadButton,
            pressed && styles.pressedScale,
          ]}
          disabled={isUploading}
        >
          <IconPlus color="#002576" size={12} />
          <Text style={styles.uploadButtonText}>
            {isUploading ? 'ANALYZING...' : 'UPLOAD PDF'}
          </Text>
        </Pressable>

        <View style={styles.sourceList}>
          {sources.map((source) => (
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
              numberOfLines={2}
            >
              {formatProcessingStatus(source)}
            </Text>
            </View>
          ))}
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

          <TextInput
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

function formatProcessingStatus(source: Source) {
  switch (source.processingStatus) {
    case 'pending':
      return 'Analyzing...';
    case 'extracting':
      return 'Reading PDF...';
    case 'chunking':
      return 'Preparing lesson...';
    case 'embedding':
      return 'Preparing study helper...';
    case 'ready':
      return 'Ready to study';
    case 'failed':
      return source.processingError ?? 'Processing failed';
    default:
      return 'Saved source';
  }
}

function ChatTab({
  book,
  pendingPrompt,
  onPromptHandled,
}: {
  book: Book;
  pendingPrompt: PendingChatPrompt | null;
  onPromptHandled: () => void;
}) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 700;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [activeStudyMessage, setActiveStudyMessage] = useState<ChatMessage | null>(
    null
  );
  const offlineAi = useOfflineAi(book.id, book.title);

  const scrollRef = useRef<KeyboardAwareScrollViewRef>(null);

  const refreshMessages = useCallback(async () => {
    const savedMessages = await listRecentChatMessagesByBook(book.id);
    setMessages(savedMessages.map(mapStoredChatMessage));
  }, [book.id]);

  useEffect(() => {
    let isActive = true;

    listRecentChatMessagesByBook(book.id)
      .then((savedMessages) => {
        if (isActive) {
          setMessages(savedMessages.map(mapStoredChatMessage));
        }
      })
      .catch(() => {
        if (isActive) {
          setMessages([]);
        }
      });

    return () => {
      isActive = false;
    };
  }, [book.id]);

  const handleSend = useCallback(async (promptText?: string) => {
    const question = (promptText ?? input).trim();

    if (!question) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: question,
    };

    setMessages((previous) => [...previous, userMessage]);
    await appendChatMessage(book.id, {
      role: 'user',
      text: question,
      kind: 'answer',
    });
    setInput('');
    setIsTyping(true);

    try {
      const isReadingSources = await hasProcessingSources(book.id);

      if (isReadingSources) {
        const statusMessage: ChatMessage = {
          id: String(Date.now() + 1),
          role: 'ai',
          text: 'ALAB is reading the PDF. Please wait...',
          kind: 'status',
        };

        setMessages((previous) => [...previous, statusMessage]);
        await appendChatMessage(book.id, {
          role: 'ai',
          text: statusMessage.text,
          kind: 'status',
        });
        await refreshMessages();
        return;
      }

      const intent = getStudyToolIntent(question);
      const waitingMessage = intent
        ? intent === 'quiz'
          ? 'ALAB is preparing this quiz from your lesson. Please wait...'
          : 'ALAB is preparing these flashcards from your lesson. Please wait...'
        : null;

      if (waitingMessage) {
        setMessages((previous) => [
          ...previous,
          {
            id: `waiting-${Date.now()}`,
            role: 'ai',
            text: waitingMessage,
            kind: 'status',
          },
        ]);
      }

      const answer = intent
        ? await offlineAi.generateStudyTool(intent)
        : await offlineAi.answerQuestion(question);
      const aiMessage: ChatMessage = {
        id: String(Date.now() + 1),
        role: 'ai',
        text: answer.text,
        sources: answer.sources,
        kind: intent ?? 'answer',
      };

      await appendChatMessage(book.id, {
        role: 'ai',
        text: aiMessage.text,
        sources: aiMessage.sources,
        kind: aiMessage.kind,
      });
      await refreshMessages();
    } catch {
      const aiMessage: ChatMessage = {
        id: String(Date.now() + 1),
        role: 'ai',
        text: 'Something went wrong while ALAB was preparing the offline answer. Please try again.',
        kind: 'status',
      };

      setMessages((previous) => [...previous, aiMessage]);
      await appendChatMessage(book.id, {
        role: 'ai',
        text: aiMessage.text,
        kind: 'status',
      });
      await refreshMessages();
    } finally {
      setIsTyping(false);
    }
  }, [book.id, input, offlineAi, refreshMessages]);

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 80);

    return () => clearTimeout(timer);
  }, [messages, isTyping]);

  useEffect(() => {
    if (!pendingPrompt) {
      return;
    }

    handleSend(pendingPrompt.text);
    onPromptHandled();
  }, [handleSend, onPromptHandled, pendingPrompt]);

  if (activeStudyMessage) {
    return (
      <StudyToolPanel
        message={activeStudyMessage}
        onClose={() => setActiveStudyMessage(null)}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.chatRoot}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
    >
      <KeyboardAwareScrollView
        ref={scrollRef}
        style={styles.chatScroll}
        bottomOffset={86}
        extraKeyboardSpace={28}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.chatContent,
          isTablet && styles.tabletTabContent,
        ]}
        showsVerticalScrollIndicator={false}
      >
        {messages.length === 0 && !isTyping ? (
          <View style={styles.chatIntro}>
            <Text style={styles.chatIntroTitle}>{"Let's study together..."}</Text>

            <Text style={styles.chatIntroText}>
              I only use the lessons your teacher uploaded. Ask me anything,
              request a quiz, or ask for a simpler explanation.
            </Text>

            <Text style={styles.aiStatusText}>
              {formatAiStatus(offlineAi)}
            </Text>
          </View>
        ) : (
          <View style={styles.messageList}>
            {messages.map((message) => {
              const isUser = message.role === 'user';

              return (
                <View
                  key={message.id}
                  style={[
                    styles.messageRow,
                    isUser ? styles.messageRowUser : styles.messageRowAI,
                  ]}
                >
                  <View
                    style={[
                      styles.messageBubble,
                      isUser ? styles.userBubble : styles.aiBubble,
                    ]}
                  >
                    {isUser ? (
                      <Text style={[styles.messageText, styles.userMessageText]}>
                        {message.text}
                      </Text>
                    ) : (
                      <RenderedMarkdown text={message.text} />
                    )}

                    {!isUser && message.sources && message.sources.length > 0 ? (
                      <View style={styles.sourcesUsed}>
                        <Text style={styles.sourcesUsedTitle}>Sources used</Text>
                        {message.sources.map((source) => (
                          <Text key={source} style={styles.sourcesUsedText}>
                            {source}
                          </Text>
                        ))}
                      </View>
                    ) : null}

                    {!isUser &&
                    (message.kind === 'quiz' || message.kind === 'flashcards') ? (
                      <Pressable
                        onPress={() => setActiveStudyMessage(message)}
                        style={({ pressed }) => [
                          styles.studyResultButton,
                          pressed && styles.pressedScale,
                        ]}
                      >
                        <Text style={styles.studyResultButtonText}>
                          {message.kind === 'quiz'
                            ? 'Quiz is ready. Tap to open.'
                            : 'Flashcards are ready. Tap to open.'}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })}

            {isTyping ? (
              <View style={[styles.messageRow, styles.messageRowAI]}>
                <View style={styles.typingBubble}>
                  <TypingDots />
                </View>
              </View>
            ) : null}
          </View>
        )}
      </KeyboardAwareScrollView>

      <View style={styles.chatInputArea}>
        <View style={styles.chatInputBar}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ask a Question or Create Something..."
            placeholderTextColor="#747685"
            style={styles.chatInput}
            returnKeyType="send"
            onSubmitEditing={() => handleSend()}
            onFocus={() => {
              setTimeout(() => {
                scrollRef.current?.scrollToEnd({ animated: true });
              }, 120);
            }}
          />

          <Pressable onPress={() => handleSend()} style={styles.sendButton}>
            <IconSend color="#ffffff" size={13.3} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function mapStoredChatMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    sources: message.sources,
    kind: message.kind,
  };
}

function parseBoldSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const pattern = /\*\*(.*?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), bold: false });
    }

    segments.push({ text: match[1], bold: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), bold: false });
  }

  return segments.length > 0 ? segments : [{ text, bold: false }];
}

function renderInlineText(text: string, colorStyle = styles.aiMessageText) {
  return parseBoldSegments(text).map((segment, index) => (
    <Text
      key={`${segment.text}-${index}`}
      style={[colorStyle, segment.bold && styles.markdownBold]}
    >
      {segment.text}
    </Text>
  ));
}

function RenderedMarkdown({ text }: { text: string }) {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return (
    <View style={styles.markdownBlock}>
      {lines.map((line, index) => {
        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        const bullet = line.match(/^[-*]\s+(.+)$/);
        const numbered = line.match(/^(\d+)[.)]\s+(.+)$/);
        const cleanLine = line.replace(/\*\*/g, '').trim();

        if (heading) {
          return (
            <Text
              key={`${line}-${index}`}
              style={[
                styles.markdownHeading,
                heading[1].length > 1 && styles.markdownSubheading,
              ]}
            >
              {renderInlineText(heading[2])}
            </Text>
          );
        }

        if (bullet || numbered) {
          const marker = numbered ? `${numbered[1]}.` : '-';
          const body = bullet?.[1] ?? numbered?.[2] ?? cleanLine;

          return (
            <View key={`${line}-${index}`} style={styles.markdownListRow}>
              <Text style={styles.markdownListMarker}>{marker}</Text>
              <Text style={styles.markdownParagraph}>
                {renderInlineText(body)}
              </Text>
            </View>
          );
        }

        return (
          <Text key={`${line}-${index}`} style={styles.markdownParagraph}>
            {renderInlineText(cleanLine)}
          </Text>
        );
      })}
    </View>
  );
}

function parseQuizQuestions(text: string): QuizQuestion[] {
  const blocks = text
    .split(/\n\s*\n|(?=Question\s*\d*[:.])/i)
    .map((block) => block.trim())
    .filter(Boolean);

  const questions = blocks
    .map<QuizQuestion | null>((block) => {
      const lines = block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const questionLine = lines.find((line) => /^question/i.test(line)) ?? lines[0];
      const question = questionLine
        .replace(/^question\s*\d*\s*[:.)-]?\s*/i, '')
        .trim();
      const options = lines
        .filter((line) => /^[A-D][.)]\s+/i.test(line))
        .map((line) => line.replace(/^[A-D][.)]\s+/i, '').trim());
      const answerLine = lines.find((line) => /^correct answer|^answer/i.test(line));
      const explanationLine = lines.find((line) => /^explanation/i.test(line));

      if (!question) {
        return null;
      }

      const parsedQuestion: QuizQuestion = {
        question,
        options,
        answer: answerLine
          ? answerLine.replace(/^correct answer\s*[:.)-]?|^answer\s*[:.)-]?/i, '').trim()
          : '',
      };

      if (explanationLine) {
        parsedQuestion.explanation = explanationLine
          .replace(/^explanation\s*[:.)-]?/i, '')
          .trim();
      }

      return parsedQuestion;
    })
    .filter((question): question is QuizQuestion => Boolean(question));

  return questions.length > 0
    ? questions
    : [{ question: text.trim(), options: [], answer: '', explanation: undefined }];
}

function parseFlashcards(text: string) {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cards: { front: string; back: string }[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const frontLine = lines[index];
    const backLine = lines[index + 1];

    if (/^front\s*:/i.test(frontLine) && /^back\s*:/i.test(backLine ?? '')) {
      cards.push({
        front: frontLine.replace(/^front\s*:/i, '').trim(),
        back: backLine.replace(/^back\s*:/i, '').trim(),
      });
      index += 1;
    }
  }

  if (cards.length > 0) {
    return cards;
  }

  return lines.map((line, index) => ({
    front: `Card ${index + 1}`,
    back: line.replace(/^[-*]\s+/, ''),
  }));
}

function StudyToolPanel({
  message,
  onClose,
}: {
  message: ChatMessage;
  onClose: () => void;
}) {
  const isQuiz = message.kind === 'quiz';

  return (
    <View style={styles.studyPanel}>
      <View style={styles.studyPanelHeader}>
        <View>
          <Text style={styles.quizCounter}>{isQuiz ? 'QUIZ' : 'FLASHCARDS'}</Text>
          <Text style={styles.studyPanelTitle}>
            {isQuiz ? 'Practice quiz' : 'Review cards'}
          </Text>
        </View>

        <Pressable
          onPress={onClose}
          style={({ pressed }) => [
            styles.studyPanelClose,
            pressed && styles.pressedScale,
          ]}
        >
          <Text style={styles.studyPanelCloseText}>X</Text>
        </Pressable>
      </View>

      {isQuiz ? (
        <QuizPanelContent text={message.text} />
      ) : (
        <FlashcardPanelContent text={message.text} />
      )}
    </View>
  );
}

function QuizPanelContent({ text }: { text: string }) {
  const questions = parseQuizQuestions(text);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, string>>({});

  return (
    <ScrollView
      style={styles.tabScroll}
      contentContainerStyle={styles.quizContent}
      showsVerticalScrollIndicator={false}
    >
      {questions.map((question, questionIndex) => {
        const selectedAnswer = selectedAnswers[questionIndex];

        return (
          <View key={`${question.question}-${questionIndex}`} style={styles.quizCard}>
            <Text style={styles.quizQuestion}>{question.question}</Text>

            {question.options.length > 0 ? (
              <View style={styles.optionList}>
                {question.options.map((option, optionIndex) => {
                  const optionLetter = String.fromCharCode(65 + optionIndex);
                  const isSelected = selectedAnswer === option;
                  const isCorrect =
                    Boolean(selectedAnswer) &&
                    (question.answer.toLowerCase().startsWith(optionLetter.toLowerCase()) ||
                      question.answer.toLowerCase() === option.toLowerCase());

                  return (
                    <Pressable
                      key={option}
                      onPress={() =>
                        setSelectedAnswers((current) => ({
                          ...current,
                          [questionIndex]: option,
                        }))
                      }
                      style={({ pressed }) => [
                        styles.optionButton,
                        isSelected && !isCorrect && styles.wrongOption,
                        isCorrect && styles.correctOption,
                        pressed && styles.pressedScale,
                      ]}
                    >
                      <Text style={styles.optionText}>
                        {optionLetter}. {option}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <Text style={styles.quizOpenAnswer}>
                Write your answer in your notebook, then compare it with the ALAB
                guide below.
              </Text>
            )}

            {selectedAnswer || question.options.length === 0 ? (
              <View style={styles.answerCard}>
                {question.answer ? (
                  <Text style={styles.answerText}>Answer: {question.answer}</Text>
                ) : null}
                {question.explanation ? (
                  <Text style={styles.answerExplanation}>
                    {question.explanation}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

function FlashcardPanelContent({ text }: { text: string }) {
  const cards = parseFlashcards(text);
  const [flippedCards, setFlippedCards] = useState<Record<number, boolean>>({});

  return (
    <ScrollView
      style={styles.tabScroll}
      contentContainerStyle={styles.quizContent}
      showsVerticalScrollIndicator={false}
    >
      {cards.map((card, index) => {
        const isFlipped = flippedCards[index];

        return (
          <Pressable
            key={`${card.front}-${index}`}
            onPress={() =>
              setFlippedCards((current) => ({
                ...current,
                [index]: !current[index],
              }))
            }
            style={({ pressed }) => [
              styles.flashcardReviewCard,
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={styles.quizCounter}>CARD {index + 1}</Text>
            <Text style={styles.flashcardReviewText}>
              {isFlipped ? card.back : card.front}
            </Text>
            <Text style={styles.flashcardHint}>
              {isFlipped ? 'Tap to see the front' : 'Tap to reveal the answer'}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function getStudyToolIntent(question: string): 'quiz' | 'flashcards' | null {
  const normalized = question.toLowerCase();

  if (normalized.includes('quiz')) {
    return 'quiz';
  }

  if (
    normalized.includes('flashcard') ||
    normalized.includes('flash card') ||
    normalized.includes('review card')
  ) {
    return 'flashcards';
  }

  return null;
}

function TypingDots() {
  const dotOne = useRef(new Animated.Value(0)).current;
  const dotTwo = useRef(new Animated.Value(0)).current;
  const dotThree = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const makeWave = (value: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(value, {
            toValue: -4,
            duration: 220,
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 0,
            duration: 220,
            useNativeDriver: true,
          }),
          Animated.delay(260),
        ])
      );

    const animation = Animated.parallel([
      makeWave(dotOne, 0),
      makeWave(dotTwo, 120),
      makeWave(dotThree, 240),
    ]);

    animation.start();

    return () => animation.stop();
  }, [dotOne, dotThree, dotTwo]);

  return (
    <View style={styles.typingDots}>
      {[dotOne, dotTwo, dotThree].map((dot, index) => (
        <Animated.View
          key={index}
          style={[
            styles.typingDot,
            {
              transform: [{ translateY: dot }],
            },
          ]}
        />
      ))}
    </View>
  );
}

function formatAiStatus(offlineAi: ReturnType<typeof useOfflineAi>) {
  if (!offlineAi.isAvailable) {
    return 'The study helper is not available in this preview yet.';
  }

  if (offlineAi.error) {
    return 'The study helper could not start on this device.';
  }

  if (!offlineAi.isModelReady) {
    const progress = Math.round(offlineAi.llmDownloadProgress * 100);
    return `The study helper is getting ready${progress > 0 ? ` (${progress}%)` : ''}.`;
  }

  if (!offlineAi.isEmbeddingReady) {
    const progress = Math.round(offlineAi.embeddingDownloadProgress * 100);
    return `Lesson search is getting ready${progress > 0 ? ` (${progress}%)` : ''}.`;
  }

  return 'Ready to study from your sources.';
}

function ToolsTab({
  onPrompt,
}: {
  onPrompt: (prompt: string) => void;
}) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 700;

  return (
    <ScrollView
      style={styles.tabScroll}
      contentContainerStyle={[
        styles.toolsContent,
        isTablet && styles.tabletTabContent,
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View>
        <Text style={styles.toolsTitle}>Study Tools</Text>

        <Text style={styles.toolsDescription}>
          Master your subjects with interactive tools. Generate quizzes or
          flashcards directly from your uploaded sources.
        </Text>
      </View>

      <View style={[styles.toolCards, isTablet && styles.tabletToolCards]}>
        <Pressable
          onPress={() => onPrompt('May I kindly ask for a Quiz please')}
          style={({ pressed }) => [
            styles.toolCard,
            isTablet && styles.tabletToolCard,
            pressed && styles.pressedScale,
          ]}
        >
          <View style={styles.redAccent} />

          <View style={styles.quizIconCircle}>
            <IconQuiz color="#E12531" size={23.3} />
          </View>

          <Text style={styles.toolTitle}>Quiz</Text>
          <Text style={styles.toolDescription}>
            Test your knowledge on uploaded lessons.
          </Text>

          <View style={styles.chevronRow}>
            <View style={styles.chevronCircle}>
              <IconChevronRight color="#1A1C1C" size={10} />
            </View>
          </View>
        </Pressable>

        <Pressable
          onPress={() => onPrompt('May I kindly ask for a Flashcard please')}
          style={({ pressed }) => [
            styles.toolCard,
            isTablet && styles.tabletToolCard,
            pressed && styles.pressedScale,
          ]}
        >
          <View style={styles.yellowAccent} />

          <View style={styles.flashcardIconCircle}>
            <IconFlashcard color="#D1A600" size={23.4} />
          </View>

          <Text style={styles.toolTitle}>Flashcards</Text>
          <Text style={styles.toolDescription}>
            Quick review for key terms and concepts.
          </Text>

          <View style={styles.chevronRow}>
            <View style={styles.chevronCircle}>
              <IconChevronRight color="#1A1C1C" size={10} />
            </View>
          </View>
        </Pressable>
      </View>

      <View style={styles.generatedToolCard}>
        <Text style={styles.generatedToolTitle}>Opened in ALAB Chat</Text>

        <Text style={styles.generatedToolText}>
          Choose a tool and ALAB Chat will ask politely, then make it from your
          lesson sources.
        </Text>
      </View>
    </ScrollView>
  );
}

type BookPageProps = {
  book: Book;
  onBack: () => void;
};

export function BookPage({ book, onBack }: BookPageProps) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 700;
  const [activeTab, setActiveTab] = useState<BookTab>('sources');
  const [pendingPrompt, setPendingPrompt] = useState<PendingChatPrompt | null>(
    null
  );

  const sendToolPrompt = (text: string) => {
    setActiveTab('chat');
    setPendingPrompt({ id: Date.now(), text });
  };

  return (
    <Screen style={styles.screen}>
      <AppHeader />

      <View style={[styles.bookHeader, isTablet && styles.tabletBookHeader]}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backText}>My Books</Text>
        </Pressable>

       
      </View>

      <View style={styles.tabContent}>
        {activeTab === 'sources' && <SourcesTab book={book} />}
        {activeTab === 'chat' && (
          <ChatTab
            book={book}
            pendingPrompt={pendingPrompt}
            onPromptHandled={() => setPendingPrompt(null)}
          />
        )}
        {activeTab === 'tools' && <ToolsTab onPrompt={sendToolPrompt} />}
      </View>

      <BookBottomNav activeTab={activeTab} onTabChange={setActiveTab} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: '#f8f8f8',
  },
  bookHeader: {
    width: '100%',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  tabletBookHeader: {
    maxWidth: 980,
    paddingHorizontal: 32,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  backArrow: {
    color: '#0038a8',
    fontSize: 18,
    lineHeight: 20,
    fontWeight: '700',
  },
  backText: {
    color: '#0038a8',
    fontSize: 14,
    fontWeight: '500',
  },
  bookPageTitle: {
    color: '#1a1c1c',
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '700',
  },
  tabContent: {
    flex: 1,
    overflow: 'visible',
  },
  tabScroll: {
    flex: 1,
  },
  emptySources: {
    flex: 1,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptySourcesInner: {
    width: '100%',
    maxWidth: 345,
    alignItems: 'center',
    gap: 16,
  },
  centerTitle: {
    color: '#002576',
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '600',
    textAlign: 'center',
  },
  centerText: {
    color: '#444653',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400',
    textAlign: 'center',
  },
  uploadButton: {
    width: '100%',
    marginTop: 16,
    backgroundColor: '#fecb00',
    borderWidth: 1,
    borderColor: 'rgba(196,197,213,0.3)',
    borderRadius: 12,
    paddingVertical: 25,
    paddingHorizontal: 33,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  uploadButtonText: {
    color: '#1a1c1c',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '600',
  },
  pressedScale: {
    transform: [{ scale: 0.97 }],
  },
  sourcesContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 40,
    gap: 20,
  },
  tabletTabContent: {
    width: '100%',
    maxWidth: 980,
    alignSelf: 'center',
    paddingHorizontal: 32,
  },
  sourceList: {
    gap: 10,
    overflow: 'visible',
    zIndex: 1,
  },
  sourceCard: {
    position: 'relative',
    alignItems: 'center',
    gap: 4,
    padding: 9,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: 'rgba(196,197,213,0.2)',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
    zIndex: 1,
  },
  activeSourceCard: {
    zIndex: 1000,
    elevation: 1000,
  },
  sourceMenuButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 1002,
    elevation: 1002,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
  },
  sourceMenu: {
    position: 'absolute',
    top: 34,
    right: 8,
    zIndex: 1001,
    width: 168,
    padding: 8,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: 'rgba(196,197,213,0.4)',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 1001,
  },
  sourceMenuItem: {
    minHeight: 40,
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  menuItemPressed: {
    backgroundColor: '#f4f5f7',
  },
  sourceMenuText: {
    color: '#1a1c1c',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  sourceMenuDangerText: {
    color: '#93000A',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  pdfIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#ffdad6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceName: {
    maxWidth: '100%',
    color: '#444653',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    letterSpacing: 0.6,
  },
  sourceStatus: {
    maxWidth: '100%',
    color: '#747685',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '500',
    textAlign: 'center',
  },
  readyStatus: {
    color: '#166534',
  },
  failedStatus: {
    color: '#93000A',
  },
  chatRoot: {
    flex: 1,
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 8,
  },
  chatIntro: {
    gap: 8,
  },
  chatIntroTitle: {
    color: '#002576',
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '600',
  },
  chatIntroText: {
    color: '#444653',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
  },
  aiStatusText: {
    color: '#747685',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
    marginTop: 4,
  },
  messageList: {
    gap: 12,
  },
  messageRow: {
    flexDirection: 'row',
  },
  messageRowUser: {
    justifyContent: 'flex-end',
  },
  messageRowAI: {
    justifyContent: 'flex-start',
  },
  messageBubble: {
    maxWidth: '80%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  userBubble: {
    backgroundColor: '#0038a8',
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    backgroundColor: '#ffffff',
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
  },
  userMessageText: {
    color: '#ffffff',
  },
  aiMessageText: {
    color: '#444653',
  },
  markdownBlock: {
    gap: 6,
  },
  markdownHeading: {
    color: '#002576',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700',
  },
  markdownSubheading: {
    fontSize: 16,
    lineHeight: 22,
  },
  markdownParagraph: {
    color: '#444653',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
  },
  markdownBold: {
    fontWeight: '700',
  },
  markdownListRow: {
    flexDirection: 'row',
    gap: 8,
  },
  markdownListMarker: {
    width: 24,
    color: '#0038a8',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  sourcesUsed: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(196,197,213,0.5)',
    gap: 4,
  },
  sourcesUsedTitle: {
    color: '#002576',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  sourcesUsedText: {
    color: '#747685',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
  },
  studyResultButton: {
    marginTop: 12,
    minHeight: 42,
    borderRadius: 12,
    backgroundColor: '#eef2ff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  studyResultButtonText: {
    color: '#002576',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  typingBubble: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    borderBottomLeftRadius: 4,
  },
  typingDots: {
    width: 42,
    minHeight: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#747685',
  },
  chatInputArea: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: '#f9f9f9',
  },
  studyPanel: {
    flex: 1,
    backgroundColor: '#f8f8f8',
  },
  studyPanelHeader: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(196,197,213,0.25)',
  },
  studyPanelTitle: {
    color: '#002576',
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '700',
  },
  studyPanelClose: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#c4c5d5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  studyPanelCloseText: {
    color: '#1a1c1c',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
  },
  chatInputBar: {
    backgroundColor: '#e8e8e8',
    borderWidth: 1,
    borderColor: '#c4c5d5',
    borderRadius: 999,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chatInput: {
    flex: 1,
    color: '#1a1c1c',
    fontSize: 14,
    fontWeight: '400',
    paddingVertical: 0,
  },
  sendButton: {
    marginLeft: 4,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#002576',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolsContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 40,
    gap: 32,
  },
  toolsTitle: {
    color: '#002576',
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '700',
    letterSpacing: -0.6,
    marginBottom: 8,
  },
  toolsDescription: {
    color: '#444653',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400',
  },
  toolCards: {
    gap: 16,
  },
  tabletToolCards: {
    flexDirection: 'row',
  },
  toolCard: {
    position: 'relative',
    overflow: 'hidden',
    padding: 25,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: 'rgba(196,197,213,0.3)',
    shadowColor: '#000',
    shadowOpacity: 0.02,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  tabletToolCard: {
    flex: 1,
  },
  redAccent: {
    position: 'absolute',
    width: 96,
    height: 96,
    borderBottomLeftRadius: 96,
    backgroundColor: 'rgba(225,37,49,0.05)',
    top: -35,
    right: -31,
  },
  yellowAccent: {
    position: 'absolute',
    width: 96,
    height: 96,
    borderBottomLeftRadius: 96,
    backgroundColor: 'rgba(209,166,0,0.05)',
    top: -31,
    right: -31,
  },
  quizIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(225,37,49,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  flashcardIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(209,166,0,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  toolTitle: {
    color: '#1a1c1c',
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '600',
    marginBottom: 4,
  },
  toolDescription: {
    color: '#444653',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
    marginBottom: 16,
  },
  chevronRow: {
    alignItems: 'flex-end',
  },
  chevronCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#eeeeee',
    alignItems: 'center',
    justifyContent: 'center',
  },
  generatedToolCard: {
    padding: 18,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: 'rgba(196,197,213,0.3)',
    gap: 8,
  },
  generatedToolTitle: {
    color: '#002576',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
  },
  generatedToolText: {
    color: '#444653',
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '400',
  },
  confirmContent: {
    gap: 12,
  },
  confirmText: {
    color: '#444653',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400',
  },
  renameInput: {
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#c4c5d5',
    backgroundColor: '#ffffff',
    color: '#1a1c1c',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '500',
    paddingHorizontal: 14,
  },
  saveButton: {
    minHeight: 50,
    borderRadius: 12,
    backgroundColor: '#002576',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    color: '#ffffff',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
  },
  removeButton: {
    minHeight: 50,
    borderRadius: 12,
    backgroundColor: '#E12531',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeButtonText: {
    color: '#ffffff',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
  },
  keepButton: {
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: '#eeeeee',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keepButtonText: {
    color: '#1a1c1c',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  quizContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 40,
    gap: 20,
  },
  quizTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quizCounter: {
    color: '#747685',
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.6,
  },
  exitQuiz: {
    color: '#0038a8',
    fontSize: 14,
    fontWeight: '500',
  },
  quizCard: {
    padding: 24,
    borderRadius: 16,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: 'rgba(196,197,213,0.3)',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  answerCard: {
    marginTop: 14,
    borderRadius: 12,
    backgroundColor: '#eef2ff',
    padding: 14,
    gap: 4,
  },
  answerText: {
    color: '#002576',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  answerExplanation: {
    color: '#444653',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
  },
  quizOpenAnswer: {
    color: '#444653',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400',
  },
  quizQuestion: {
    color: '#1a1c1c',
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '600',
    marginBottom: 24,
  },
  optionList: {
    gap: 10,
  },
  optionButton: {
    width: '100%',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#f8f8f8',
    borderWidth: 1,
    borderColor: '#c4c5d5',
  },
  correctOption: {
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderColor: 'rgba(34,197,94,0.5)',
  },
  wrongOption: {
    backgroundColor: 'rgba(225,37,49,0.1)',
    borderColor: 'rgba(225,37,49,0.5)',
  },
  optionText: {
    color: '#1a1c1c',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400',
  },
  flashcardReviewCard: {
    minHeight: 168,
    borderRadius: 16,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: 'rgba(196,197,213,0.3)',
    padding: 22,
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  flashcardReviewText: {
    color: '#1a1c1c',
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
  },
  flashcardHint: {
    color: '#747685',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
  },
});
