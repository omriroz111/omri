#!/usr/bin/env bash
# Builds cheese-run.apk from ../index.html without Gradle or Android Studio.
#
# Needs Java 17+, python3, zip, and these Android build tools:
#   ANDROID_JAR    platform android.jar (API 33 or newer)
#   AAPT2          aapt2 binary
#   D8_JAR         d8.jar (r8)
#   APKSIGNER_JAR  apksigner.jar
# Optional: ECJ_JAR (Eclipse compiler; use it with d8 8.2, which fails on javac 21 output),
#           KEYSTORE / KS_PASS / KEY_ALIAS (a key is created on first run),
#           VERSION_CODE / VERSION_NAME, OUT (build directory).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OUT="${OUT:-$HERE/build}"
: "${ANDROID_JAR:?set ANDROID_JAR to a platform android.jar}"
: "${AAPT2:?set AAPT2 to the aapt2 binary}"
: "${D8_JAR:?set D8_JAR to d8.jar}"
: "${APKSIGNER_JAR:?set APKSIGNER_JAR to apksigner.jar}"
KEYSTORE="${KEYSTORE:-$HERE/.keys/cheese-run.jks}"
KS_PASS="${KS_PASS:-cheeserun}"
KEY_ALIAS="${KEY_ALIAS:-cheeserun}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0}"
MIN_SDK=24
TARGET_SDK=34

rm -rf "$OUT"
mkdir -p "$OUT/assets/game/fonts" "$OUT/classes" "$OUT/dex"

echo "1/4 game page"
# Swap Google Fonts for the bundled copies so the app works offline, and turn off pinch zoom.
python3 - "$HERE/../index.html" "$OUT/assets/game/index.html" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
src = re.sub(r'<link rel="preconnect"[^>]*>\n', '', src)
src, n = re.subn(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com[^"]*">',
                 '<link rel="stylesheet" href="fonts/fonts.css">', src)
assert n == 1, 'Google Fonts link not found in index.html'
src = src.replace('initial-scale=1, viewport-fit=cover',
                  'initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')
open(sys.argv[2], 'w', encoding='utf-8').write(src)
PY
cp "$HERE"/fonts/*.woff2 "$HERE"/fonts/fonts.css "$HERE"/fonts/OFL-*.txt "$OUT/assets/game/fonts/"

echo "2/4 resources"
"$AAPT2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$AAPT2" link -o "$OUT/unsigned.apk" -I "$ANDROID_JAR" \
  --manifest "$HERE/AndroidManifest.xml" -A "$OUT/assets" \
  --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  "$OUT/res.zip"

echo "3/4 code"
if [ -n "${ECJ_JAR:-}" ]; then
  java -jar "$ECJ_JAR" -8 -nowarn -encoding UTF-8 -bootclasspath "$ANDROID_JAR" -d "$OUT/classes" "$HERE/src"
else
  javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 \
    -bootclasspath "$ANDROID_JAR" -d "$OUT/classes" $(find "$HERE/src" -name '*.java')
fi
java -cp "$D8_JAR" com.android.tools.r8.D8 --release --min-api "$MIN_SDK" \
  --lib "$ANDROID_JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -X "$OUT/unsigned.apk" classes.dex)

echo "4/4 align + sign"
# zipalign: start every uncompressed entry's data on a 4-byte boundary.
python3 - "$OUT/unsigned.apk" "$OUT/aligned.apk" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as zin, zipfile.ZipFile(sys.argv[2], 'w') as zout:
    for info in zin.infolist():
        data = zin.read(info)
        out = zipfile.ZipInfo(info.filename, date_time=info.date_time)
        out.compress_type = info.compress_type
        out.external_attr = info.external_attr
        if out.compress_type == zipfile.ZIP_STORED:
            start = zout.fp.tell() + 30 + len(info.filename.encode())
            out.extra = b'\0' * ((-start) % 4)
        zout.writestr(out, data)
PY
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Cheese Run, O=Omri" >/dev/null
fi
# apksigner also 4-byte aligns uncompressed entries such as resources.arsc.
java -jar "$APKSIGNER_JAR" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" \
  --ks-key-alias "$KEY_ALIAS" --key-pass "pass:$KS_PASS" \
  --min-sdk-version "$MIN_SDK" --out "$OUT/cheese-run.apk" "$OUT/aligned.apk"
java -jar "$APKSIGNER_JAR" verify --min-sdk-version "$MIN_SDK" "$OUT/cheese-run.apk"
echo "built $OUT/cheese-run.apk"
