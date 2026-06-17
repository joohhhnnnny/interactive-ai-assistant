import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { KeyboardAwareScrollView, KeyboardAwareScrollViewRef, KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOfflineSpeech } from '../../../../ai/useOfflineSpeech';
import { IconMic, IconSend } from '../../../../components/icons/icons';
import { appendChatMessage, hasProcessingSources, listRecentChatMessagesByBook } from '../../../../data/database';
import { Book } from '../../../../types/Book';
import { ChatMessage, OfflineAi, PendingChatPrompt } from '../types';
import { formatAiStatus, formatAnalysisDuration, getComposerPlaceholder, getStudyToolIntent, getVisibleSources, mapStoredChatMessage } from './chatHelpers';
import { RenderedMarkdown, TypingDots } from './MessageContent';
import { styles } from './styles';
import { StudyToolPanel } from './StudyToolPanel';
import { parseFlashcards, parseQuizQuestions } from './studyToolUtils';

function getReadyStudyToolKind(
  tool: 'quiz' | 'flashcards',
  answer: {
    text: string;
    sources: string[];
    answerMode: string;
  }
): ChatMessage['kind'] | null {
  if (answer.answerMode !== 'study_tool' || answer.sources.length === 0) {
    return null;
  }

  if (tool === 'quiz') {
    return parseQuizQuestions(answer.text).length > 0 ? 'quiz' : null;
  }

  return parseFlashcards(answer.text).length > 0 ? 'flashcards' : null;
}

function isOpenableStudyMessage(message: ChatMessage) {
  if (message.role !== 'ai') {
    return false;
  }

  if (message.kind === 'quiz') {
    return parseQuizQuestions(message.text).length > 0;
  }

  if (message.kind === 'flashcards') {
    return parseFlashcards(message.text).length > 0;
  }

  return false;
}

function getStudyToolNotReadyMessage(tool: 'quiz' | 'flashcards') {
  return tool === 'quiz'
    ? 'ALAB tried to make a quiz, but it was not clean enough to open yet. Please ask again after the lesson finishes preparing.'
    : 'ALAB tried to make flashcards, but they were not clean enough to open yet. Please ask again after the lesson finishes preparing.';
}

export function ALABChat({
  book,
  offlineAi,
  onComposerFocusChange,
  pendingPrompt,
  onPromptHandled,
}: {
  book: Book;
  offlineAi: OfflineAi;
  onComposerFocusChange?: (isFocused: boolean) => void;
  pendingPrompt: PendingChatPrompt | null;
  onPromptHandled: () => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isTablet = width >= 700;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [activeStudyMessage, setActiveStudyMessage] = useState<ChatMessage | null>(
    null
  );
  const offlineSpeech = useOfflineSpeech();

  const scrollRef = useRef<KeyboardAwareScrollViewRef>(null);
  const isMountedRef = useRef(true);
  const activeRequestIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      activeRequestIdRef.current += 1;
      setIsComposerFocused(false);
      onComposerFocusChange?.(false);
    };
  }, [onComposerFocusChange]);

  useEffect(() => {
    const keyboardDidHide = Keyboard.addListener('keyboardDidHide', () => {
      setIsComposerFocused(false);
      onComposerFocusChange?.(false);
    });

    return () => keyboardDidHide.remove();
  }, [onComposerFocusChange]);

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
    if (isTyping) {
      return;
    }

    const question = (promptText ?? input).trim();

    if (!question) return;

    const requestId = activeRequestIdRef.current + 1;
    const startedAt = Date.now();
    activeRequestIdRef.current = requestId;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: question,
    };

    if (isMountedRef.current) {
      setMessages((previous) => [...previous, userMessage]);
    }
    await appendChatMessage(book.id, {
      role: 'user',
      text: question,
      kind: 'answer',
    });
    if (isMountedRef.current && activeRequestIdRef.current === requestId) {
      setInput('');
      setIsTyping(true);
    }

    try {
      const isReadingSources = await hasProcessingSources(book.id);

      if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
        return;
      }

      if (isReadingSources) {
        const statusMessage: ChatMessage = {
          id: String(Date.now() + 1),
          role: 'ai',
          text: 'Analyzing the book. Please wait...',
          kind: 'status',
        };

        setMessages((previous) => [...previous, statusMessage]);
        await appendChatMessage(book.id, {
          role: 'ai',
          text: statusMessage.text,
          kind: 'status',
        });
        return;
      }

      const intent = getStudyToolIntent(question);
      const waitingMessageId = `waiting-${Date.now()}`;
      const waitingMessage = intent
        ? intent.tool === 'quiz'
          ? 'ALAB is preparing this quiz from your lesson. Please wait...'
          : 'ALAB is preparing these flashcards from your lesson. Please wait...'
        : null;

      if (waitingMessage) {
        setMessages((previous) => [
          ...previous,
          {
            id: waitingMessageId,
            role: 'ai',
            text: waitingMessage,
            kind: 'status',
          },
        ]);
      }

      const answer = intent
        ? await offlineAi.generateStudyTool(intent.tool, intent.mode, intent.count)
        : await offlineAi.answerQuestion(question);

      if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
        return;
      }

      const studyToolKind = intent
        ? getReadyStudyToolKind(intent.tool, answer)
        : null;
      const aiKind: ChatMessage['kind'] = intent
        ? studyToolKind ?? 'status'
        : answer.answerMode === 'status'
          ? 'status'
          : 'answer';
      const aiText = intent && !studyToolKind
        ? getStudyToolNotReadyMessage(intent.tool)
        : answer.text;
      const aiMessage: ChatMessage = {
        id: String(Date.now() + 1),
        role: 'ai',
        text: aiText,
        sources: studyToolKind ? answer.sources : undefined,
        analysisText: `Analyzed ${formatAnalysisDuration(Date.now() - startedAt)}`,
        kind: aiKind,
      };

      await appendChatMessage(book.id, {
        role: 'ai',
        text: aiMessage.text,
        sources: aiMessage.sources,
        kind: aiMessage.kind,
      });
      setMessages((previous) => [
        ...previous.filter((message) => message.id !== waitingMessageId),
        aiMessage,
      ]);
    } catch {
      if (!isMountedRef.current || activeRequestIdRef.current !== requestId) {
        return;
      }

      const aiMessage: ChatMessage = {
        id: String(Date.now() + 1),
        role: 'ai',
        text: 'Something went wrong while ALAB was preparing the offline answer. Please try again.',
        analysisText: `Analyzed ${formatAnalysisDuration(Date.now() - startedAt)}`,
        kind: 'status',
      };

      setMessages((previous) => [
        ...previous.filter((message) => !message.id.startsWith('waiting-')),
        aiMessage,
      ]);
      await appendChatMessage(book.id, {
        role: 'ai',
        text: aiMessage.text,
        kind: 'status',
      });
    } finally {
      if (isMountedRef.current && activeRequestIdRef.current === requestId) {
        setIsTyping(false);
      }
    }
  }, [book.id, input, isTyping, offlineAi]);

  const addLocalStatusMessage = useCallback((text: string) => {
    const statusMessage: ChatMessage = {
      id: `voice-status-${Date.now()}`,
      role: 'ai',
      text,
      kind: 'status',
    };

    setMessages((previous) => [...previous, statusMessage]);
  }, []);

  const handleVoicePress = useCallback(async () => {
    if (isTyping || offlineSpeech.isTranscribing) {
      return;
    }

    if (offlineSpeech.isListening) {
      try {
        const transcript = await offlineSpeech.stopAndTranscribe();

        if (!transcript) {
          addLocalStatusMessage('I did not hear a question. Please try again.');
          return;
        }

        setInput(transcript);
        await handleSend(transcript);
      } catch {
        addLocalStatusMessage('Voice input could not prepare your question. Please try again.');
      }

      return;
    }

    if (!offlineSpeech.isVoiceAvailable) {
      addLocalStatusMessage('Voice input needs the Android app build.');
      return;
    }

    const hasMicPermission = await offlineSpeech.requestPermission();

    if (!hasMicPermission) {
      addLocalStatusMessage('Please allow microphone access so ALAB can listen to your question.');
      return;
    }

    if (!offlineSpeech.hasCheckedDownload) {
      addLocalStatusMessage('Checking your saved study helper...');
      return;
    }

    if (!offlineSpeech.shouldLoadModel) {
      addLocalStatusMessage('Please prepare the study helper from My Books first.');
      return;
    }

    if (!offlineSpeech.isReady) {
      offlineSpeech.prepareVoiceInput();
      const progress = Math.round(offlineSpeech.downloadProgress * 100);
      addLocalStatusMessage(
        `Voice input is getting ready${progress > 0 ? ` (${progress}%)` : ''}.`
      );
      return;
    }

    try {
      const didStart = await offlineSpeech.startListening();

      if (!didStart) {
        addLocalStatusMessage('Please allow microphone access so ALAB can listen to your question.');
      }
    } catch {
      addLocalStatusMessage('Please allow microphone access so ALAB can listen to your question.');
    }
  }, [
    addLocalStatusMessage,
    handleSend,
    isTyping,
    offlineSpeech,
  ]);

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

  return (
    <View style={styles.chatRoot}>
      <KeyboardAwareScrollView
        ref={scrollRef}
        style={styles.chatScroll}
        bottomOffset={96}
        extraKeyboardSpace={0}
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
              I only use the lessons you uploaded. Ask me anything,
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
              const canOpenStudyMessage = isOpenableStudyMessage(message);

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
                    ) : message.kind === 'quiz' && canOpenStudyMessage ? (
                      <Text style={styles.messageText}>
                        Your practice quiz is ready.
                      </Text>
                    ) : message.kind === 'flashcards' && canOpenStudyMessage ? (
                      <Text style={styles.messageText}>
                        Your flashcards are ready.
                      </Text>
                    ) : (
                      <RenderedMarkdown text={message.text} />
                    )}

                    {!isUser && getVisibleSources(message).length > 0 ? (
                      <View style={styles.sourcesUsed}>
                        <Text style={styles.sourcesUsedTitle}>Sources used</Text>
                        {getVisibleSources(message).map((source) => (
                          <Text key={source} style={styles.sourcesUsedText}>
                            {source}
                          </Text>
                        ))}
                      </View>
                    ) : null}

                      {!isUser && canOpenStudyMessage ? (
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

                    {!isUser && message.analysisText ? (
                      <Text style={styles.analysisText}>{message.analysisText}</Text>
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

      <KeyboardStickyView
        enabled={Platform.OS === 'android' || Platform.OS === 'ios'}
        offset={{ opened: 0, closed: 0 }}
        style={styles.chatInputSticky}
      >
        <View
          style={[
            styles.chatInputArea,
            {
              paddingBottom: isComposerFocused ? 3 : Math.max(insets.bottom, 6),
            },
          ]}
        >
          <View style={styles.chatInputBar}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={getComposerPlaceholder(offlineSpeech)}
              placeholderTextColor="#747685"
              editable={!isTyping && !offlineSpeech.isListening && !offlineSpeech.isTranscribing}
              style={[styles.chatInput, isTyping && styles.disabledChatInput]}
              returnKeyType="send"
              onSubmitEditing={() => handleSend()}
              onFocus={() => {
                setIsComposerFocused(true);
                onComposerFocusChange?.(true);
                setTimeout(() => {
                  scrollRef.current?.scrollToEnd({ animated: true });
                }, 120);
              }}
              onBlur={() => {
                setIsComposerFocused(false);
                onComposerFocusChange?.(false);
              }}
            />

            <Pressable
              disabled={isTyping || offlineSpeech.isTranscribing}
              onPress={handleVoicePress}
              style={[
                styles.voiceButton,
                offlineSpeech.isListening && styles.listeningVoiceButton,
                (isTyping || offlineSpeech.isTranscribing) && styles.disabledVoiceButton,
              ]}
            >
              <IconMic
                color={offlineSpeech.isListening ? '#ffffff' : '#002576'}
                size={17}
              />
            </Pressable>

            <Pressable
              disabled={isTyping || offlineSpeech.isListening || offlineSpeech.isTranscribing}
              onPress={() => handleSend()}
              style={[
                styles.sendButton,
                (isTyping || offlineSpeech.isListening || offlineSpeech.isTranscribing) &&
                  styles.disabledSendButton,
              ]}
            >
              <IconSend color="#ffffff" size={13.3} />
            </Pressable>
          </View>
        </View>
      </KeyboardStickyView>

      {activeStudyMessage ? (
        <View style={styles.studyPanelOverlay}>
          <StudyToolPanel
            message={activeStudyMessage}
            onClose={() => setActiveStudyMessage(null)}
          />
        </View>
      ) : null}
    </View>
  );
}
