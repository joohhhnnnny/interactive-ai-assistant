#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$PROJECT_ROOT/android"
APK_PATH="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
BREW_JDK_17="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"

if [ -d "$BREW_JDK_17" ]; then
  export JAVA_HOME="$BREW_JDK_17"
fi

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "Java 17 was not found. Install it with: brew install openjdk@17" >&2
  exit 1
fi

JAVA_VERSION="$("$JAVA_HOME/bin/java" -version 2>&1 | sed -n '1p')"
echo "Using Java: $JAVA_VERSION"

cd "$ANDROID_DIR"
NODE_ENV=production ./gradlew assembleRelease

echo
echo "APK ready:"
echo "$APK_PATH"
