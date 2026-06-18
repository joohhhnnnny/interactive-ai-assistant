#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const settingsPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "@react-native",
  "gradle-plugin",
  "settings.gradle.kts"
);

const oldResolver =
  'id("org.gradle.toolchains.foojay-resolver-convention").version("0.5.0")';
const newResolver =
  'id("org.gradle.toolchains.foojay-resolver-convention").version("1.0.0")';

if (!fs.existsSync(settingsPath)) {
  console.warn(
    "[postinstall] React Native Gradle plugin settings were not found; skipping Foojay resolver patch."
  );
  process.exit(0);
}

const source = fs.readFileSync(settingsPath, "utf8");

if (source.includes(newResolver)) {
  console.log("[postinstall] React Native Gradle plugin Foojay resolver is already patched.");
  process.exit(0);
}

if (!source.includes(oldResolver)) {
  console.error(
    "[postinstall] Could not find the expected Foojay resolver pin in React Native's Gradle plugin."
  );
  console.error(`[postinstall] Checked: ${settingsPath}`);
  process.exit(1);
}

fs.writeFileSync(settingsPath, source.replace(oldResolver, newResolver));
console.log("[postinstall] Patched React Native Gradle plugin Foojay resolver to 1.0.0.");
