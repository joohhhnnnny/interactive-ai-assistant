import { File } from 'expo-file-system';
import { useEffect, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  deleteArchivedBookPermanently,
  getStudentProfile,
  listArchivedBooks,
  listSourcesByBook,
  restoreBook,
  saveStudentProfile,
} from '../../data/database';
import { Book } from '../../types/Book';
import { StudentProfile } from '../../types/StudentProfile';
import { IconArchive, IconDots, IconSettings, IconUserProfile } from '../icons/icons';
import { BottomSheet } from '../ui/BottomSheet';

type AppHeaderProps = {
  onBooksChanged?: () => void;
  onProfileUpdated?: (profile: StudentProfile) => void;
};

const logo = require('../../../assets/images/logo/alab-logo.png');

export function AppHeader({ onBooksChanged, onProfileUpdated }: AppHeaderProps) {
  const [profileSheetOpen, setProfileSheetOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [archivedBooks, setArchivedBooks] = useState<Book[]>([]);
  const [archiveMenuBookId, setArchiveMenuBookId] = useState<string | null>(null);
  const [bookToDelete, setBookToDelete] = useState<Book | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeletingBook, setIsDeletingBook] = useState(false);

  useEffect(() => {
    if (!profileSheetOpen && !profileMenuOpen) return;

    let isMounted = true;

    async function loadProfile() {
      const savedProfile = await getStudentProfile();

      if (!isMounted) return;

      setProfile(savedProfile);
      setFirstName(savedProfile?.firstName ?? '');
      setLastName(savedProfile?.lastName ?? '');
    }

    loadProfile();

    return () => {
      isMounted = false;
    };
  }, [profileMenuOpen, profileSheetOpen]);

  useEffect(() => {
    if (!settingsSheetOpen) return;

    let isMounted = true;

    async function loadArchivedBooks() {
      const archived = await listArchivedBooks();

      if (!isMounted) return;

      setArchivedBooks(archived);
    }

    loadArchivedBooks();

    return () => {
      isMounted = false;
    };
  }, [settingsSheetOpen]);

  const handleProfileClose = () => {
    setProfileSheetOpen(false);
    setEditingName(false);
    setError('');
  };

  const handleSettingsClose = () => {
    setSettingsSheetOpen(false);
  };

  const handleSaveName = async () => {
    const nextFirstName = firstName.trim();
    const nextLastName = lastName.trim();

    if (!nextFirstName || !nextLastName) {
      setError('Please enter both names.');
      return;
    }

    setIsSaving(true);
    await saveStudentProfile(nextFirstName, nextLastName);

    const nextProfile = {
      id: 1,
      firstName: nextFirstName,
      lastName: nextLastName,
    };

    setProfile(nextProfile);
    onProfileUpdated?.(nextProfile);
    setIsSaving(false);
    setEditingName(false);
    setError('');
  };

  const handleRestoreBook = async (bookId: string) => {
    await restoreBook(bookId);
    setArchivedBooks((currentBooks) =>
      currentBooks.filter((book) => book.id !== bookId)
    );
    setArchiveMenuBookId(null);
    onBooksChanged?.();
  };

  const handleDeleteArchivedBook = async () => {
    if (!bookToDelete || isDeletingBook) {
      return;
    }

    setIsDeletingBook(true);

    try {
      const sources = await listSourcesByBook(bookToDelete.id);
      await deleteArchivedBookPermanently(bookToDelete.id);

      if (Platform.OS !== 'web') {
        for (const source of sources) {
          try {
            const file = new File(source.fileUri);
            file.delete();
          } catch {
            // The database delete is the durable cleanup; file cleanup is best effort.
          }
        }
      }

      setArchivedBooks((currentBooks) =>
        currentBooks.filter((book) => book.id !== bookToDelete.id)
      );
      setBookToDelete(null);
      setArchiveMenuBookId(null);
      onBooksChanged?.();
    } finally {
      setIsDeletingBook(false);
    }
  };

  return (
    <>
      <View style={styles.header}>
        <View style={styles.inner}>
          <View style={styles.brand}>
            <View style={styles.logoBox}>
              <Image source={logo} style={styles.logo} resizeMode="cover" />
            </View>

            <Text style={styles.logoText}>ALAB</Text>
          </View>

          <View style={styles.actions}>
            <Pressable
              onPress={() => {
                setProfileMenuOpen(false);
                setSettingsSheetOpen(true);
              }}
              hitSlop={8}
              style={({ pressed }) => [
                styles.profileButton,
                pressed && styles.pressed,
              ]}
            >
              <IconSettings color="#747685" size={22} />
            </Pressable>

            <Pressable
              onPress={() => {
                setSettingsSheetOpen(false);
                setProfileMenuOpen((isOpen) => !isOpen);
              }}
              hitSlop={8}
              style={({ pressed }) => [
                styles.profileButton,
                pressed && styles.pressed,
              ]}
            >
              <IconUserProfile color="#747685" size={22} />
            </Pressable>
          </View>
        </View>
      </View>

      {profileMenuOpen ? (
        <View style={styles.profileMenu}>
          <Text style={styles.profileMenuName} numberOfLines={1}>
            {profile ? `${profile.firstName} ${profile.lastName}` : 'Student'}
          </Text>

          <Pressable
            onPress={() => {
              setProfileMenuOpen(false);
              setEditingName(true);
              setProfileSheetOpen(true);
            }}
            style={({ pressed }) => [
              styles.profileMenuOption,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.profileMenuOptionText}>Change name</Text>
          </Pressable>
        </View>
      ) : null}

      <BottomSheet
        visible={profileSheetOpen}
        title={editingName ? 'Change name' : 'Profile'}
        snapPoints={editingName ? ['54%', '76%'] : ['34%', '54%']}
        onClose={handleProfileClose}
      >
        {!editingName ? (
          <View style={styles.settingsContent}>
            <View style={styles.profileSummary}>
              <View style={styles.profileIconLarge}>
                <IconUserProfile color="#747685" size={26} />
              </View>

              <View style={styles.profileTextBlock}>
                <Text style={styles.profileLabel}>STUDENT</Text>
                <Text style={styles.profileName}>
                  {profile
                    ? `${profile.firstName} ${profile.lastName}`
                    : 'No student yet'}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={() => {
                setEditingName(true);
              }}
              style={({ pressed }) => [
                styles.sheetOption,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.sheetOptionText}>Change name</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.form}>
            <View style={styles.fieldGroup}>
              <Text style={styles.inputLabel}>FIRST NAME</Text>
              <TextInput
                value={firstName}
                onChangeText={(text) => {
                  setFirstName(text);
                  setError('');
                }}
                placeholder="e.g. Maria"
                placeholderTextColor="#747685"
                style={styles.input}
                autoCapitalize="words"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.inputLabel}>LAST NAME</Text>
              <TextInput
                value={lastName}
                onChangeText={(text) => {
                  setLastName(text);
                  setError('');
                }}
                placeholder="e.g. Santos"
                placeholderTextColor="#747685"
                style={styles.input}
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={handleSaveName}
              />
            </View>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Pressable
              disabled={isSaving}
              onPress={handleSaveName}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.pressed,
                isSaving && styles.disabledButton,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                {isSaving ? 'Saving...' : 'Save name'}
              </Text>
            </Pressable>
          </View>
        )}
      </BottomSheet>

      <BottomSheet
        visible={settingsSheetOpen}
        title="Settings"
        snapPoints={['52%', '78%']}
        onClose={handleSettingsClose}
      >
        <View style={styles.settingsContent}>
          <View style={styles.profileSummary}>
            <View style={styles.profileIconLarge}>
              <IconArchive color="#747685" size={26} />
            </View>

            <View style={styles.profileTextBlock}>
              <Text style={styles.profileLabel}>ARCHIVE</Text>
              <Text style={styles.profileName}>Archived books</Text>
            </View>
          </View>

          {archivedBooks.length === 0 ? (
            <View style={styles.emptyArchive}>
              <Text style={styles.emptyArchiveTitle}>No archived books</Text>
              <Text style={styles.emptyArchiveText}>
                Deleted books will stay here so you can restore them later.
              </Text>
            </View>
          ) : (
            <View style={styles.archiveList}>
              {archivedBooks.map((book) => (
                <View
                  key={book.id}
                  style={[
                    styles.archiveItem,
                    archiveMenuBookId === book.id && styles.activeArchiveItem,
                  ]}
                >
                  <View style={styles.archiveTextBlock}>
                    <Text style={styles.archiveTitle} numberOfLines={1}>
                      {book.title}
                    </Text>
                    <Text style={styles.archiveDescription} numberOfLines={2}>
                      {book.description || 'No description'}
                    </Text>
                  </View>

                  <Pressable
                    onPress={() =>
                      setArchiveMenuBookId((currentId) =>
                        currentId === book.id ? null : book.id
                      )
                    }
                    style={({ pressed }) => [
                      styles.archiveDotsButton,
                      pressed && styles.pressed,
                    ]}
                    hitSlop={10}
                  >
                    <IconDots color="#1A1C1C" />
                  </Pressable>

                  {archiveMenuBookId === book.id ? (
                    <View style={styles.archiveMenu}>
                      <Pressable
                        onPress={() => handleRestoreBook(book.id)}
                        style={({ pressed }) => [
                          styles.archiveMenuItem,
                          pressed && styles.pressedMenuItem,
                        ]}
                      >
                        <Text style={styles.archiveMenuText}>Restore</Text>
                      </Pressable>

                      <Pressable
                        onPress={() => {
                          setBookToDelete(book);
                          setArchiveMenuBookId(null);
                        }}
                        style={({ pressed }) => [
                          styles.archiveMenuItem,
                          pressed && styles.pressedMenuItem,
                        ]}
                      >
                        <Text style={styles.archiveMenuDangerText}>Delete</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          )}
        </View>
      </BottomSheet>

      <BottomSheet
        visible={Boolean(bookToDelete)}
        title="Are you sure about this?"
        snapPoints={['36%', '54%']}
        onClose={() => setBookToDelete(null)}
      >
        <View style={styles.settingsContent}>
          <Text style={styles.confirmDeleteText}>
            This permanently deletes the archived book, its sources, saved chat,
            quizzes, and flashcards from this device.
          </Text>

          <Pressable
            disabled={isDeletingBook}
            onPress={handleDeleteArchivedBook}
            style={({ pressed }) => [
              styles.deleteForeverButton,
              pressed && styles.pressed,
              isDeletingBook && styles.disabledButton,
            ]}
          >
            <Text style={styles.deleteForeverButtonText}>
              {isDeletingBook ? 'Deleting...' : 'Delete forever'}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setBookToDelete(null)}
            style={({ pressed }) => [
              styles.keepArchiveButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.keepArchiveButtonText}>Keep book</Text>
          </Pressable>
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 65,
    width: '100%',
    backgroundColor: '#f8f8f8',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(196,197,213,0.15)',
    zIndex: 10,
  },
  inner: {
    width: '100%',
    height: '100%',
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoBox: {
    width: 60,
    height: 48,
    overflow: 'visible',
  },
  logo: {
    position: 'absolute',
    width: 61,
    height: 61,
    top: -6,
    left: -6,
  },
  logoText: {
    marginLeft: -5,
    color: '#002576',
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  profileButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#c4c5d5',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.75,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  profileMenu: {
    position: 'absolute',
    top: 56,
    right: 20,
    width: 188,
    zIndex: 40,
    elevation: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e0e1e6',
    backgroundColor: '#ffffff',
    padding: 10,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  profileMenuName: {
    color: '#747685',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  profileMenuOption: {
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#f8f8f8',
    paddingHorizontal: 12,
  },
  profileMenuOptionText: {
    color: '#1a1c1c',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  settingsContent: {
    gap: 16,
  },
  profileSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e0e1e6',
    backgroundColor: '#f8f8f8',
    padding: 14,
  },
  profileIconLarge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#c4c5d5',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileTextBlock: {
    flex: 1,
  },
  profileLabel: {
    color: '#747685',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  profileName: {
    color: '#1a1c1c',
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '700',
  },
  sheetOption: {
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#eef2ff',
    paddingHorizontal: 14,
  },
  sheetOptionText: {
    color: '#002576',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
  },
  form: {
    gap: 16,
  },
  fieldGroup: {
    gap: 6,
  },
  inputLabel: {
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
  disabledButton: {
    opacity: 0.65,
  },
  emptyArchive: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e0e1e6',
    backgroundColor: '#f8f8f8',
    padding: 16,
  },
  emptyArchiveTitle: {
    color: '#1a1c1c',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
    marginBottom: 4,
  },
  emptyArchiveText: {
    color: '#444653',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
  },
  archiveList: {
    gap: 10,
  },
  archiveItem: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e0e1e6',
    backgroundColor: '#ffffff',
    padding: 12,
    zIndex: 1,
  },
  activeArchiveItem: {
    zIndex: 20,
    elevation: 20,
  },
  archiveTextBlock: {
    flex: 1,
  },
  archiveTitle: {
    color: '#1a1c1c',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  archiveDescription: {
    color: '#747685',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '400',
  },
  archiveDotsButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8f8f8',
  },
  archiveMenu: {
    position: 'absolute',
    top: 48,
    right: 12,
    width: 138,
    padding: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e0e1e6',
    backgroundColor: '#ffffff',
    zIndex: 30,
    elevation: 30,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  archiveMenuItem: {
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  pressedMenuItem: {
    backgroundColor: '#f4f5f7',
  },
  archiveMenuText: {
    color: '#1a1c1c',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  archiveMenuDangerText: {
    color: '#93000A',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  confirmDeleteText: {
    color: '#444653',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400',
  },
  deleteForeverButton: {
    minHeight: 50,
    borderRadius: 12,
    backgroundColor: '#E12531',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteForeverButtonText: {
    color: '#ffffff',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
  },
  keepArchiveButton: {
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: '#eeeeee',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keepArchiveButtonText: {
    color: '#1a1c1c',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  restoreButton: {
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: 999,
    backgroundColor: '#002576',
    paddingHorizontal: 14,
  },
  restoreButtonText: {
    color: '#ffffff',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
});
