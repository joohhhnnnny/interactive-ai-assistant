import { useEffect, useRef } from 'react';
import { Animated, Text, View } from 'react-native';
import { cleanStudentReadableText, formatStudentOutput } from '../../../../ai/textCleanup';
import { styles } from './styles';

type MarkdownSegment = {
  text: string;
  bold: boolean;
};

export function RenderedMarkdown({ text }: { text: string }) {
  const lines = formatVisibleMessage(text)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => looksLikeCodeOutput(text) ? line.trimEnd() : line.trim())
    .filter((line) => Boolean(line) && !/^\|?\s*-{3,}/.test(line));

  if (lines.length === 0) {
    return null;
  }

  return (
    <View style={styles.markdownBlock}>
      {lines.map((line, index) => {
        const heading = line.match(/^(#{1,3})\s*(.+)$/);
        const bullet = line.match(/^[-*]\s+(.+)$/);
        const numbered = line.match(/^(\d+)[.)]\s+(.+)$/);
        const cleanLine = cleanMarkdownText(line);

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
          const body = cleanMarkdownText(bullet?.[1] ?? numbered?.[2] ?? cleanLine);

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

export function TypingDots() {
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

function cleanMarkdownText(text: string) {
  return cleanStudentReadableText(text);
}

function formatVisibleMessage(text: string) {
  if (looksLikeCodeOutput(text)) {
    return cleanStudentReadableText(text);
  }

  return formatStudentOutput(text);
}

function looksLikeCodeOutput(text: string) {
  return (
    /\b(public|private|protected|class|function|const|let|var|return|import)\b/.test(text) ||
    /[{};]\s*$/.test(text)
  );
}
