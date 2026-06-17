#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$PROJECT_ROOT/android"
APK_PATH="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
BREW_JDK_17="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
LOCAL_JDK_17="/tmp/alab-jdk17"
LOCAL_ANDROID_SDK="$HOME/Android/Sdk"

if [ -x "$LOCAL_JDK_17/bin/java" ]; then
  export JAVA_HOME="$LOCAL_JDK_17"
elif [ -d "$BREW_JDK_17" ]; then
  export JAVA_HOME="$BREW_JDK_17"
fi

if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA_BIN="$JAVA_HOME/bin/java"
else
  JAVA_BIN="$(command -v java || true)"
fi

if [ -z "$JAVA_BIN" ] || [ ! -x "$JAVA_BIN" ]; then
  echo "Java was not found. Install JDK 17+ and set JAVA_HOME if needed." >&2
  exit 1
fi

JAVA_VERSION="$("$JAVA_BIN" -version 2>&1 | sed -n '1p')"
echo "Using Java: $JAVA_VERSION"

if [ -z "${ANDROID_HOME:-}" ] && [ -d "$LOCAL_ANDROID_SDK" ]; then
  export ANDROID_HOME="$LOCAL_ANDROID_SDK"
fi

cd "$ANDROID_DIR"
./gradlew --stop
NODE_ENV=production ./gradlew --no-daemon --no-parallel assembleRelease

echo
echo "APK ready:"
echo "$APK_PATH"
