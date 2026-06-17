#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BREW_JDK_17="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
LOCAL_JDK_17="/tmp/alab-jdk17"
LOCAL_ANDROID_SDK="$HOME/Android/Sdk"
DEFAULT_METRO_PORT="8081"

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

ARGS=("$@")
DEVICE_NAME=""
DEVICE_SERIAL=""
SHOULD_SELECT_DEVICE=false
METRO_PORT="$DEFAULT_METRO_PORT"

find_first_device() {
  adb devices -l | awk '
    NR > 1 && $2 == "device" {
      serial = $1
      name = serial
      for (i = 3; i <= NF; i += 1) {
        if ($i ~ /^model:/) {
          name = substr($i, 7)
        }
      }
      print serial "\t" name
      exit
    }
  '
}

find_serial_for_device_name() {
  local requested_name="$1"

  adb devices -l | awk -v requested_name="$requested_name" '
    NR > 1 && $2 == "device" {
      serial = $1
      name = serial
      for (i = 3; i <= NF; i += 1) {
        if ($i ~ /^model:/) {
          name = substr($i, 7)
        }
      }
      if (serial == requested_name || name == requested_name) {
        print serial
        exit
      }
    }
  '
}

for ((i = 0; i < ${#ARGS[@]}; i += 1)); do
  case "${ARGS[$i]}" in
    --device|-d)
      SHOULD_SELECT_DEVICE=true

      next_index=$((i + 1))
      if [ "$next_index" -lt "${#ARGS[@]}" ] && [[ "${ARGS[$next_index]}" != -* ]]; then
        DEVICE_NAME="${ARGS[$next_index]}"
      fi
      ;;
    --port|-p)
      next_index=$((i + 1))
      if [ "$next_index" -lt "${#ARGS[@]}" ]; then
        METRO_PORT="${ARGS[$next_index]}"
      fi
      ;;
  esac
done

if [ "$SHOULD_SELECT_DEVICE" = true ] && [ -z "$DEVICE_NAME" ]; then
  DEVICE_INFO="$(find_first_device || true)"

  if [ -z "$DEVICE_INFO" ]; then
    echo "No authorized Android device was found." >&2
    echo "Connect your phone, enable USB debugging, accept the authorization prompt, then run again." >&2
    exit 1
  fi

  DEVICE_SERIAL="${DEVICE_INFO%%$'\t'*}"
  DEVICE_NAME="${DEVICE_INFO#*$'\t'}"

  UPDATED_ARGS=()
  for ((i = 0; i < ${#ARGS[@]}; i += 1)); do
    UPDATED_ARGS+=("${ARGS[$i]}")

    if [ "${ARGS[$i]}" = "--device" ] || [ "${ARGS[$i]}" = "-d" ]; then
      next_index=$((i + 1))
      if [ "$next_index" -ge "${#ARGS[@]}" ] || [[ "${ARGS[$next_index]}" == -* ]]; then
        UPDATED_ARGS+=("$DEVICE_NAME")
      fi
    fi
  done
  ARGS=("${UPDATED_ARGS[@]}")
fi

if [ "$SHOULD_SELECT_DEVICE" = true ] && [ -z "$DEVICE_SERIAL" ]; then
  DEVICE_SERIAL="$(find_serial_for_device_name "$DEVICE_NAME" || true)"
fi

if [ -n "$DEVICE_SERIAL" ]; then
  echo "Using Android device: $DEVICE_NAME ($DEVICE_SERIAL)"
  adb -s "$DEVICE_SERIAL" reverse "tcp:$METRO_PORT" "tcp:$METRO_PORT" || true
fi

cd "$PROJECT_ROOT"
npx expo run:android "${ARGS[@]}"
