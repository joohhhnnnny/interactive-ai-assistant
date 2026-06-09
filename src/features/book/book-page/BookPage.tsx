import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useOfflineAi } from '../../../ai/useOfflineAi';
import { AppHeader } from '../../../components/layout/AppHeader';
import { Screen } from '../../../components/layout/Screen';
import { BookBottomNav, BookTab } from '../../../components/navigation/BookBottomNav';
import { hasProcessingSources, hasReadyStudyChunks } from '../../../data/database';
import { Book } from '../../../types/Book';
import { ALABChat } from './alab-chat/ALABChat';
import { Sources } from './sources/Sources';
import { StudyTools } from './study-tools/StudyTools';
import { styles } from './styles';
import { PendingChatPrompt, StudyReadiness } from './types';

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
  const [isChatComposerFocused, setIsChatComposerFocused] = useState(false);
  const [studyReadiness, setStudyReadiness] = useState<StudyReadiness>({
    isChecking: true,
    hasReadyChunks: false,
    hasProcessingSources: false,
  });
  const offlineAi = useOfflineAi(book.id, book.title);

  const refreshStudyReadiness = useCallback(async () => {
    setStudyReadiness((current) => ({
      ...current,
      isChecking: true,
    }));

    const [hasReadyChunks, hasSourcesProcessing] = await Promise.all([
      hasReadyStudyChunks(book.id),
      hasProcessingSources(book.id),
    ]);

    setStudyReadiness({
      isChecking: false,
      hasReadyChunks,
      hasProcessingSources: hasSourcesProcessing,
    });
  }, [book.id]);

  useEffect(() => {
    let isActive = true;

    Promise.all([hasReadyStudyChunks(book.id), hasProcessingSources(book.id)])
      .then(([hasReadyChunks, hasSourcesProcessing]) => {
        if (!isActive) {
          return;
        }

        setStudyReadiness({
          isChecking: false,
          hasReadyChunks,
          hasProcessingSources: hasSourcesProcessing,
        });
      })
      .catch(() => {
        if (isActive) {
          setStudyReadiness({
            isChecking: false,
            hasReadyChunks: false,
            hasProcessingSources: false,
          });
        }
      });

    return () => {
      isActive = false;
    };
  }, [book.id]);

  const sendToolPrompt = (text: string) => {
    setActiveTab('chat');
    setPendingPrompt({ id: Date.now(), text });
  };

  const handleTabChange = (tab: BookTab) => {
    setIsChatComposerFocused(false);
    setActiveTab(tab);
  };

  const shouldHideBottomNav = activeTab === 'chat' && isChatComposerFocused;

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
        <View
          style={[
            styles.mountedTab,
            activeTab !== 'sources' && styles.hiddenMountedTab,
          ]}
        >
          <Sources
            book={book}
            offlineAi={offlineAi}
            onSourcesChanged={refreshStudyReadiness}
          />
        </View>

        <View
          style={[
            styles.mountedTab,
            activeTab !== 'chat' && styles.hiddenMountedTab,
          ]}
        >
          <ALABChat
            book={book}
            offlineAi={offlineAi}
            onComposerFocusChange={setIsChatComposerFocused}
            pendingPrompt={pendingPrompt}
            onPromptHandled={() => setPendingPrompt(null)}
          />
        </View>

        <View
          style={[
            styles.mountedTab,
            activeTab !== 'tools' && styles.hiddenMountedTab,
          ]}
        >
          <StudyTools
            onPrompt={sendToolPrompt}
            readiness={studyReadiness}
          />
        </View>
      </View>

      {shouldHideBottomNav ? null : (
        <BookBottomNav activeTab={activeTab} onTabChange={handleTabChange} />
      )}
    </Screen>
  );
}
