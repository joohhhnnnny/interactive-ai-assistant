import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { IconChat, IconSources, IconTools } from '../icons/icons';

export type BookTab = 'sources' | 'chat' | 'tools';

type BookBottomNavProps = {
  activeTab: BookTab;
  onTabChange: (tab: BookTab) => void;
};

export function BookBottomNav({ activeTab, onTabChange }: BookBottomNavProps) {
  const { width } = useWindowDimensions();
  const isNarrow = width < 360;
  const isTablet = width >= 700;

  const tabs: { id: BookTab; label: string }[] = [
    { id: 'sources', label: 'Sources' },
    { id: 'chat', label: 'ALAB Chat' },
    { id: 'tools', label: 'Tools' },
  ];

  return (
    <View style={styles.wrapper}>
      <View style={styles.nav}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;

          const iconColor = isActive ? '#ffffff' : '#444653';
          const textColor = isActive ? '#ffffff' : '#444653';

          return (
            <Pressable
              key={tab.id}
              onPress={() => onTabChange(tab.id)}
              style={({ pressed }) => [
                styles.tab,
                isNarrow && styles.narrowTab,
                isTablet && styles.tabletTab,
                isActive && styles.activeTab,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.iconBox}>
                {tab.id === 'sources' ? (
                  <IconSources color={iconColor} size={22} />
                ) : null}

                {tab.id === 'chat' ? (
                  <IconChat color={iconColor} size={22} />
                ) : null}

                {tab.id === 'tools' ? (
                  <IconTools color={iconColor} size={19.5} />
                ) : null}
              </View>

              <Text
                style={[
                  styles.label,
                  isNarrow && styles.narrowLabel,
                  { color: textColor },
                ]}
                numberOfLines={1}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: '#ffffff',
  },
  nav: {
    width: '100%',
    height: 62,
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,

    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,

    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  tab: {
    flex: 1,
    maxWidth: 150,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  narrowTab: {
    paddingHorizontal: 8,
  },
  tabletTab: {
    maxWidth: 180,
  },
  activeTab: {
    backgroundColor: '#0038a8',
  },
  iconBox: {
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: 1,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    letterSpacing: 0.6,
  },
  narrowLabel: {
    fontSize: 11,
    letterSpacing: 0,
  },
  pressed: {
    opacity: 0.8,
  },
});
