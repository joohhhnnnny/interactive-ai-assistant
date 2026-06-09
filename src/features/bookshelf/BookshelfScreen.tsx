import { useMemo, useState } from 'react';
import {
  GestureResponderEvent,
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
  IconBookCard,
  IconDots,
  IconNewBook,
  IconSearch,
} from '../../components/icons/icons';
import { AppHeader } from '../../components/layout/AppHeader';
import { Screen } from '../../components/layout/Screen';
import { BottomSheet } from '../../components/ui/BottomSheet';
import { SheetTextInput } from '../../components/ui/SheetTextInput';
import { OfflineModelDownloadCard } from '../../ai/OfflineModelDownloadCard';
import { useOfflineStudyHelperStatus } from '../../ai/useOfflineStudyHelperStatus';
import { Book } from '../../types/Book';
import { StudentProfile } from '../../types/StudentProfile';

type BookshelfScreenProps = {
  userName: string;
  books: Book[];
  onBookSelect: (book: Book) => void;
  onAddBook: (title: string, description: string) => Promise<void>;
  onArchiveBook: (bookId: string) => Promise<void>;
  onBooksChanged: () => void;
  onProfileUpdated: (profile: StudentProfile) => void;
  onUpdateBook: (
    bookId: string,
    title: string,
    description: string
  ) => Promise<void>;
};

function getGreeting() {
  const hour = new Date().getHours();

  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';

  return 'Good Evening';
}

export function BookshelfScreen({
  userName,
  books,
  onBookSelect,
  onAddBook,
  onArchiveBook,
  onBooksChanged,
  onProfileUpdated,
  onUpdateBook,
}: BookshelfScreenProps) {
  const { width } = useWindowDimensions();
  const [searchQuery, setSearchQuery] = useState('');
  const [bookSheetOpen, setBookSheetOpen] = useState(false);
  const [bookTitle, setBookTitle] = useState('');
  const [bookDescription, setBookDescription] = useState('');
  const [bookError, setBookError] = useState('');
  const [activeMenuBookId, setActiveMenuBookId] = useState<string | null>(null);
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [editBookTitle, setEditBookTitle] = useState('');
  const [editBookDescription, setEditBookDescription] = useState('');
  const [editBookError, setEditBookError] = useState('');
  const [bookToArchive, setBookToArchive] = useState<Book | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const studyHelper = useOfflineStudyHelperStatus();
  const isTablet = width >= 700;
  const canCreateBook = Platform.OS === 'web' || studyHelper.isReady;
  const containerWidth = Math.min(width, isTablet ? 980 : 448);
  const horizontalPadding = isTablet ? 64 : 40;
  const gridGap = isTablet ? 18 : 14;
  const columnCount = isTablet ? 3 : 2;
  const cardWidth = Math.floor(
    (containerWidth - horizontalPadding - gridGap * (columnCount - 1)) /
      columnCount
  );

  const filteredBooks = useMemo(() => {
    const query = searchQuery.toLowerCase();

    return books.filter((book) => {
      return (
        book.title.toLowerCase().includes(query) ||
        book.description?.toLowerCase().includes(query)
      );
    });
  }, [books, searchQuery]);

  const handleBookSubmit = async () => {
    const nextTitle = bookTitle.trim();

    if (!nextTitle) {
      setBookError('Please enter the lesson name.');
      return;
    }

    setIsSaving(true);
    await onAddBook(nextTitle, bookDescription.trim());
    setIsSaving(false);
    setBookTitle('');
    setBookDescription('');
    setBookError('');
    setBookSheetOpen(false);
  };

  const openBookMenu = (event: GestureResponderEvent, bookId: string) => {
    event.stopPropagation();
    setActiveMenuBookId((currentId) => (currentId === bookId ? null : bookId));
  };

  const handleEditBookPress = (book: Book) => {
    setEditingBook(book);
    setEditBookTitle(book.title);
    setEditBookDescription(book.description ?? '');
    setEditBookError('');
    setActiveMenuBookId(null);
  };

  const handleEditBookSubmit = async () => {
    if (!editingBook) return;

    const nextTitle = editBookTitle.trim();

    if (!nextTitle) {
      setEditBookError('Please enter the lesson name.');
      return;
    }

    setIsSaving(true);
    await onUpdateBook(editingBook.id, nextTitle, editBookDescription.trim());
    setIsSaving(false);
    setEditingBook(null);
    setEditBookTitle('');
    setEditBookDescription('');
    setEditBookError('');
  };

  const handleArchivePress = (book: Book) => {
    setActiveMenuBookId(null);
    setBookToArchive(book);
  };

  const handleArchiveConfirm = async () => {
    if (!bookToArchive || isArchiving) {
      return;
    }

    setIsArchiving(true);
    await onArchiveBook(bookToArchive.id);
    setIsArchiving(false);
    setBookToArchive(null);
  };

  return (
    <Screen style={styles.screen}>
      <AppHeader
        onBooksChanged={onBooksChanged}
        onProfileUpdated={onProfileUpdated}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.container, isTablet && styles.tabletContainer]}>
          <View style={styles.heading}>
            <Text style={styles.greeting}>
              {getGreeting()}, {userName}
            </Text>

            <Text style={styles.title}>My Books</Text>

            <Text style={styles.description}>
              Tap a book to start asking questions
            </Text>
          </View>

          <OfflineModelDownloadCard helper={studyHelper} />

          <View style={styles.searchBar}>
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search"
              placeholderTextColor="#747685"
              style={styles.searchInput}
            />

            <Pressable style={styles.searchButton}>
              <IconSearch color="#ffffff" size={18} />
            </Pressable>
          </View>

          <View style={[styles.grid, { gap: gridGap }]}>
            {canCreateBook ? (
              <Pressable
                onPress={() => {
                  setBookSheetOpen(true);
                }}
                style={({ pressed }) => [
                  styles.newBookCard,
                  { width: cardWidth },
                  isTablet && styles.tabletCard,
                  pressed && styles.cardPressed,
                ]}
              >
                <View style={styles.newBookIcon}>
                  <IconNewBook color="#002576" size={16} />
                </View>

                <Text style={styles.newBookText}>New Book</Text>
              </Pressable>
            ) : null}

            {filteredBooks.length === 0 && books.length > 0 ? (
              <View style={[styles.emptySearchCard, { width: cardWidth }]}>
                <Text style={styles.emptySearchTitle}>No lessons found</Text>
                <Text style={styles.emptySearchText}>
                  Try a simpler search word.
                </Text>
              </View>
            ) : null}

            {filteredBooks.map((book) => (
              <Pressable
                key={book.id}
                onPress={() => onBookSelect(book)}
                style={({ pressed }) => [
                  styles.bookCard,
                  { width: cardWidth },
                  isTablet && styles.tabletCard,
                  pressed && styles.cardPressed,
                ]}
              >
                <Pressable
                  onPress={(event) => openBookMenu(event, book.id)}
                  hitSlop={10}
                  style={styles.dotsButton}
                >
                  <IconDots color="#1A1C1C" />
                </Pressable>

                {activeMenuBookId === book.id ? (
                  <View style={styles.bookMenu}>
                    <Pressable
                      onPress={() => handleEditBookPress(book)}
                      style={({ pressed }) => [
                        styles.bookMenuItem,
                        pressed && styles.cardPressed,
                      ]}
                    >
                      <Text style={styles.bookMenuText}>Edit title</Text>
                    </Pressable>

                    <Pressable
                      onPress={() => handleArchivePress(book)}
                      style={({ pressed }) => [
                        styles.bookMenuItem,
                        pressed && styles.cardPressed,
                      ]}
                    >
                      <Text style={styles.deleteMenuText}>Delete</Text>
                    </Pressable>
                  </View>
                ) : null}

                <View style={styles.bookIconArea}>
                  <IconBookCard color={book.color} width={133} height={30} />
                </View>

                <View style={styles.bookInfo}>
                  <Text style={styles.bookTitle} numberOfLines={2}>
                    {book.title}
                  </Text>

                  <Text style={styles.bookMeta} numberOfLines={1}>
                    {book.date} · {book.sources} sources
                  </Text>

                  {book.description ? (
                    <Text style={styles.bookDescription} numberOfLines={2}>
                      {book.description}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </ScrollView>

      <BottomSheet
        visible={bookSheetOpen}
        title="New lesson"
        snapPoints={['58%', '78%']}
        onClose={() => {
          setBookSheetOpen(false);
          setBookError('');
        }}
      >
        <View style={styles.sheetForm}>
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>LESSON NAME</Text>
            <SheetTextInput
              value={bookTitle}
              onChangeText={(text) => {
                setBookTitle(text);
                setBookError('');
              }}
              placeholder="e.g. Science Grade 7"
              placeholderTextColor="#747685"
              style={styles.input}
              autoCapitalize="sentences"
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>DESCRIPTION</Text>
            <SheetTextInput
              value={bookDescription}
              onChangeText={setBookDescription}
              placeholder="Optional short note"
              placeholderTextColor="#747685"
              style={[styles.input, styles.descriptionInput]}
              multiline
              textAlignVertical="top"
            />
          </View>

          {bookError ? <Text style={styles.errorText}>{bookError}</Text> : null}

          <Pressable
            disabled={isSaving}
            onPress={handleBookSubmit}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.cardPressed,
              isSaving && styles.disabledButton,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {isSaving ? 'Saving...' : 'Create lesson'}
            </Text>
          </Pressable>
        </View>
      </BottomSheet>

      <BottomSheet
        visible={Boolean(editingBook)}
        title="Edit lesson"
        snapPoints={['58%', '78%']}
        onClose={() => {
          setEditingBook(null);
          setEditBookError('');
        }}
      >
        <View style={styles.sheetForm}>
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>LESSON NAME</Text>
            <SheetTextInput
              value={editBookTitle}
              onChangeText={(text) => {
                setEditBookTitle(text);
                setEditBookError('');
              }}
              placeholder="e.g. Science Grade 7"
              placeholderTextColor="#747685"
              style={styles.input}
              autoCapitalize="sentences"
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>DESCRIPTION</Text>
            <SheetTextInput
              value={editBookDescription}
              onChangeText={setEditBookDescription}
              placeholder="Optional short note"
              placeholderTextColor="#747685"
              style={[styles.input, styles.descriptionInput]}
              multiline
              textAlignVertical="top"
            />
          </View>

          {editBookError ? (
            <Text style={styles.errorText}>{editBookError}</Text>
          ) : null}

          <Pressable
            disabled={isSaving}
            onPress={handleEditBookSubmit}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.cardPressed,
              isSaving && styles.disabledButton,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {isSaving ? 'Saving...' : 'Save lesson'}
            </Text>
          </Pressable>
        </View>
      </BottomSheet>

      <BottomSheet
        visible={Boolean(bookToArchive)}
        title="Delete book?"
        snapPoints={['36%']}
        onClose={() => {
          setBookToArchive(null);
        }}
      >
        <View style={styles.sheetForm}>
          <Text style={styles.archiveConfirmText}>
            This book will be moved to Archive Books. You can restore it there
            later.
          </Text>

          <Pressable
            disabled={isArchiving}
            onPress={handleArchiveConfirm}
            style={({ pressed }) => [
              styles.dangerButton,
              pressed && styles.cardPressed,
              isArchiving && styles.disabledButton,
            ]}
          >
            <Text style={styles.dangerButtonText}>
              {isArchiving ? 'Moving...' : 'Move to Archive'}
            </Text>
          </Pressable>

          <Pressable
            disabled={isArchiving}
            onPress={() => setBookToArchive(null)}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.cardPressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Keep Book</Text>
          </Pressable>
        </View>
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f8f8f8',
  },
  scrollContent: {
    paddingBottom: 48,
  },
  container: {
    width: '100%',
    maxWidth: 448,
    alignSelf: 'center',
    paddingTop: 24,
    paddingHorizontal: 20,
  },
  tabletContainer: {
    maxWidth: 980,
    paddingHorizontal: 32,
  },
  heading: {
    marginBottom: 32,
  },
  greeting: {
    color: '#747685',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
    marginBottom: 4,
  },
  title: {
    color: '#1a1c1c',
    fontSize: 30,
    lineHeight: 38,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  description: {
    color: '#444653',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
    paddingTop: 4,
  },
  searchBar: {
    marginBottom: 32,
    backgroundColor: '#e8e8e8',
    borderWidth: 1,
    borderColor: '#c4c5d5',
    borderRadius: 999,
    paddingVertical: 6,
    paddingLeft: 15,
    paddingRight: 6,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  searchInput: {
    flex: 1,
    color: '#1a1c1c',
    fontSize: 16,
    fontWeight: '400',
    paddingVertical: 0,
    paddingHorizontal: 4,
  },
  searchButton: {
    marginLeft: 4,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#002576',
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  newBookCard: {
    minHeight: 180,
    borderRadius: 16,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#c4c5d5',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  newBookIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#dce1ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  newBookText: {
    color: '#1a1c1c',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '600',
  },
  emptySearchCard: {
    minHeight: 180,
    borderRadius: 16,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#c4c5d5',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  emptySearchTitle: {
    color: '#1a1c1c',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 4,
  },
  emptySearchText: {
    color: '#747685',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '400',
    textAlign: 'center',
  },
  bookCard: {
    minHeight: 180,
    borderRadius: 16,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#c4c5d5',
    padding: 17,
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  tabletCard: {
    minHeight: 204,
  },
  cardPressed: {
    transform: [{ scale: 0.97 }],
  },
  dotsButton: {
    position: 'absolute',
    top: 9,
    right: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    zIndex: 2,
  },
  bookMenu: {
    position: 'absolute',
    top: 36,
    right: 10,
    width: 132,
    zIndex: 5,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e0e1e6',
    backgroundColor: '#ffffff',
    padding: 6,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  bookMenuItem: {
    minHeight: 38,
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  bookMenuText: {
    color: '#1a1c1c',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  deleteMenuText: {
    color: '#E12531',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  bookIconArea: {
    paddingTop: 16,
  },
  bookInfo: {
    paddingTop: 16,
  },
  bookTitle: {
    color: '#1a1c1c',
    fontSize: 14,
    lineHeight: 19.25,
    fontWeight: '600',
    marginBottom: 4,
  },
  bookMeta: {
    color: '#747685',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    letterSpacing: 0.6,
  },
  bookDescription: {
    color: '#444653',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '400',
    marginTop: 6,
  },
  sheetForm: {
    gap: 16,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    color: '#444653',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  input: {
    width: '100%',
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#c4c5d5',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#1a1c1c',
    fontSize: 16,
    fontWeight: '400',
  },
  descriptionInput: {
    minHeight: 88,
  },
  errorText: {
    color: '#E12531',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
  },
  primaryButton: {
    width: '100%',
    height: 52,
    borderRadius: 999,
    backgroundColor: '#002576',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
  },
  dangerButton: {
    width: '100%',
    height: 52,
    borderRadius: 999,
    backgroundColor: '#E12531',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerButtonText: {
    color: '#ffffff',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
  },
  secondaryButton: {
    width: '100%',
    height: 50,
    borderRadius: 999,
    backgroundColor: '#eeeeee',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#1a1c1c',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  archiveConfirmText: {
    color: '#444653',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400',
  },
  disabledButton: {
    opacity: 0.65,
  },
});
