# Cheese Run for Android

A small Android wrapper that plays `../index.html` in a full-screen WebView.
The game runs fully offline: fonts are bundled from `fonts/` (SIL OFL 1.1).

- Package: `com.omri.cheeserun`, min Android 7.0 (API 24), target API 34
- Back button pauses a running game; from the menus it closes the app
- The screen stays on while playing; rotation keeps the current game

## Build

`build.sh` builds and signs `build/cheese-run.apk` without Gradle. Point it at the
Android build tools:

```sh
ANDROID_JAR=/path/android.jar AAPT2=/path/aapt2 D8_JAR=/path/d8.jar \
APKSIGNER_JAR=/path/apksigner.jar ECJ_JAR=/path/ecj.jar ./build.sh
```

On first run it creates a signing key in `.keys/` (not committed). An APK signed
with a different key cannot update an installed copy, so uninstall the old one first.
