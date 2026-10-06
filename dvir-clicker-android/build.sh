#!/usr/bin/env bash
# Builds DvirClicker.apk from ../dvir-clicker without Gradle or the full Android SDK.
#
# Needs: a JDK (javac, keytool) and, on Debian/Ubuntu:
#   sudo apt-get install aapt dalvik-exchange zipalign apksigner
# android.jar (API 34) is downloaded on first run unless ANDROID_JAR points at one.
set -euo pipefail

cd "$(dirname "$0")"
OUT=build
APK=DvirClicker.apk
ANDROID_JAR=${ANDROID_JAR:-$OUT/android-34.jar}
ANDROID_JAR_URL=https://raw.githubusercontent.com/Reginer/aosp-android-jar/main/android-34/android.jar
KEYSTORE=dvir-clicker.keystore
KEY_ALIAS=dvir
KEY_PASS=dvirclicker

rm -rf "$OUT/classes" "$OUT/assets" "$OUT"/*.apk "$OUT/classes.dex"
mkdir -p "$OUT/classes" "$OUT/assets"

if [ ! -f "$ANDROID_JAR" ]; then
  echo "Downloading android.jar (API 34)..."
  curl -fsSL -o "$ANDROID_JAR" "$ANDROID_JAR_URL"
fi

echo "Bundling the web game..."
cp -r ../dvir-clicker "$OUT/assets/www"

echo "Compiling Java..."
javac -nowarn -Xlint:-options -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
  -d "$OUT/classes" $(find src -name '*.java')

echo "Dexing..."
dalvik-exchange --dex --min-sdk-version=24 --output="$OUT/classes.dex" "$OUT/classes"

echo "Packaging resources and assets..."
aapt package -f -M AndroidManifest.xml -S res -A "$OUT/assets" -I "$ANDROID_JAR" -F "$OUT/unsigned.apk"
(cd "$OUT" && aapt add -k unsigned.apk classes.dex >/dev/null)

echo "Aligning..."
zipalign -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [ ! -f "$KEYSTORE" ]; then
  echo "Creating signing key $KEYSTORE..."
  keytool -genkeypair -keystore "$KEYSTORE" -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KEY_PASS" -keypass "$KEY_PASS" -dname "CN=Dvir Clicker"
fi

echo "Signing..."
apksigner sign --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEY_PASS" --key-pass "pass:$KEY_PASS" --v4-signing-enabled false \
  --out "$APK" "$OUT/aligned.apk"
apksigner verify "$APK"

echo "Done: $(pwd)/$APK ($(du -h "$APK" | cut -f1))"
