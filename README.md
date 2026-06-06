# ALAB - Offline AI Study Companion

<p align="center">
  <img src="./assets/images/logo/alab-logo.png" alt="ALAB logo" width="140" />
</p>

ALAB is an offline-first mobile study companion for students who need learning
support even when internet access is limited. Teachers or students can add
lesson PDFs, then students can ask questions, review sources, generate quizzes,
and study with flashcards from the materials stored on the device.

The name **ALAB** comes from the Filipino word for blaze or passion. The app is
designed to feel focused, practical, and encouraging for everyday study.

---

## Current App Flow

```txt
/
/onboarding
/register
/bookshelf
/book/[bookId]
```

Inside a book, students use:

- Sources
- ALAB Chat
- Study Tools
- Interactive quiz panel
- Interactive flashcard panel

---

## Current Features

- Loading, onboarding, and student registration screens
- Profile-driven startup flow for returning students
- Bookshelf with locally stored lesson books
- Book create, edit, archive, restore, and confirmed permanent delete flows
- PDF source upload and source management
- Local source-processing states such as `Analyzing...`, `Reading PDF...`, and `Ready to study`
- ALAB Chat with source-grounded offline answer flow
- Chat history saved per book and pruned to the latest 20 student turns
- Readable AI answer rendering for headings, bold text, bullets, and numbered lists
- Study Tools shortcuts that generate quiz or flashcard requests through ALAB Chat
- Interactive quiz and flashcard panels opened from chat results
- SQLite-backed student profile, books, sources, chunks, embeddings, chat, quizzes, and flashcards
- Web preview fallback storage through `database.web.ts`
- Android-first local AI wiring through ExecuTorch platform files

---

## Tech Stack

- React Native
- Expo SDK 56
- Expo Router
- TypeScript
- Expo SQLite
- Expo FileSystem
- Expo DocumentPicker
- React Native Safe Area Context
- React Native Keyboard Controller
- React Native SVG
- React Native ExecuTorch

The mobile v1 path is Android-first. The old Python backend prototype is not
part of the active app path, and ALAB should not depend on Ollama, ChromaDB, or
FAISS for mobile v1.

---

## Privacy And Local Data

ALAB is designed to keep student study data local to the installed app.

- Student profile, books, sources, chat messages, extracted text, chunks, quizzes, and flashcards are stored locally.
- Uploaded PDFs are copied into app-private document storage on native builds.
- The offline Android study-helper path does not require committed cloud API keys.
- Android backup is disabled in the native manifest with `android:allowBackup="false"` and `android:fullBackupContent="false"`.
- On normal Android uninstall, Android removes the app-private database and copied source files from the device.

Do not commit local build outputs, signing keys, `.env` files, generated Android
local files, or service config files.

---

## Build An APK

Full APK notes are in:

```txt
docs/BUILD_APK.md
```

Run the release APK build:

```bash
npm run apk:release
```

Release APK output:

```txt
android/app/build/outputs/apk/release/app-release.apk
```

For faster local testing:

```bash
npm run apk:debug
```

Debug APK output:

```txt
android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Development Checks

Run these before building an APK or pushing changes:

```bash
npx tsc --noEmit
npm run lint
npx expo export --platform web
```

---

## Installation

Install dependencies:

```bash
npm install
```

Start Expo:

```bash
npx expo start
```

Start with a clean cache:

```bash
npx expo start -c
```

---

## Project Structure

```txt
interactive-ai-assistant/
├── assets/
│   └── images/
│       ├── logo/
│       │   └── alab-logo.png
│       └── book-stack.png
├── docs/
│   ├── BUILD_APK.md
│   ├── PROJECT_MEMORY.md
│   ├── ROADMAP.md
│   └── step-by-step/
├── src/
│   ├── ai/
│   ├── app/
│   ├── components/
│   ├── data/
│   ├── features/
│   └── types/
├── app.json
├── package.json
├── tsconfig.json
└── README.md
```

---

## Important Notes

- Keep `docs/` markdown-only because it is the durable project memory layer.
- Use Expo SDK 56 docs when changing Expo APIs.
- Keep web previews away from native-only Android AI and SQLite paths.
- Student-facing UI should say ALAB or study helper, not model, RAG, embedding, Qwen, or ExecuTorch.
- Debug and release APKs should stay out of git.

---

## Reference Docs

- Expo SDK 56 reference: https://docs.expo.dev/versions/v56.0.0/
- Expo Router: https://docs.expo.dev/router/introduction/
- Expo SQLite: https://docs.expo.dev/versions/v56.0.0/sdk/sqlite/
- Expo DocumentPicker: https://docs.expo.dev/versions/v56.0.0/sdk/document-picker/
- React Native Safe Area Context: https://docs.expo.dev/versions/v56.0.0/sdk/safe-area-context/
- React Native SVG for Expo: https://docs.expo.dev/versions/v56.0.0/sdk/svg/
