#!/bin/bash
# ساخت APK اپ اندروید — بدون گریدل، فقط با build-tools (aapt2/javac/d8/zipalign/apksigner)
# خروجی: APK امضاشده با همان versionCode/versionName مانیفست (۴٫۴ = ۹)
#
# استفاده (از پوشه‌ی android-app):
#   scripts/build-apk.sh
#
# متغیرهای محیطی (اختیاری):
#   TOOLS_DIR   پوشه‌ی build-tools (aapt2/d8/zipalign/apksigner)
#   ANDROID_JAR مسیر android.jar پلتفرم ۳۴
#   KEYSTORE    مسیر keystore.jks (در ریپو نیست؛ محلی یا سیکریت CI)
#   KS_PASS / KS_ALIAS / KEY_PASS
#   OUT         مسیر APK خروجی
set -e
cd "$(dirname "$0")/.."

TOOLS_DIR="${TOOLS_DIR:-$ANDROID_BUILD_TOOLS}"
[ -z "$TOOLS_DIR" ] && TOOLS_DIR=$(dirname "$(command -v aapt2)")
AAPT2="$TOOLS_DIR/aapt2"; D8="$TOOLS_DIR/d8"
ZALIGN="$TOOLS_DIR/zipalign"; APKSIGNER="$TOOLS_DIR/apksigner"
ANDROID_JAR="${ANDROID_JAR:-$ANDROID_HOME/platforms/android-34/android.jar}"
KEYSTORE="${KEYSTORE:-keystore.jks}"
KS_PASS="${KS_PASS:-webproxy2024}"; KS_ALIAS="${KS_ALIAS:-webproxy}"; KEY_PASS="${KEY_PASS:-webproxy2024}"
OUT="${OUT:-../WebProxy.apk}"

for t in "$AAPT2" "$D8" "$ZALIGN" "$APKSIGNER" "$ANDROID_JAR" "$KEYSTORE"; do
  [ -e "$t" ] || { echo "پیدا نشد: $t (متغیرهای TOOLS_DIR/ANDROID_JAR/KEYSTORE را تنظیم کن)"; exit 1; }
done

B=build
rm -rf "$B" && mkdir -p "$B/gen" "$B/classes" "$B/dex"

echo "1) aapt2 compile - resources"
"$AAPT2" compile --dir app/src/main/res -o "$B/res.zip"

echo "2) aapt2 link - manifest + resources + R.java"
"$AAPT2" link -o "$B/base.apk" -I "$ANDROID_JAR" \
  --manifest app/src/main/AndroidManifest.xml \
  --java "$B/gen" \
  --min-sdk-version 21 --target-sdk-version 34 \
  --version-code 9 --version-name 4.4 \
  "$B/res.zip"

echo "3) javac - 8 classes + generated R"
find app/src/main/java "$B/gen" -name '*.java' > "$B/sources.txt"
javac -encoding UTF-8 --release 11 \
  -classpath "$ANDROID_JAR" \
  -d "$B/classes" \
  @"$B/sources.txt"

echo "4) d8 - dex (min-api 21)"
find "$B/classes" -name '*.class' > "$B/classes.txt"
"$D8" --release --min-api 21 --lib "$ANDROID_JAR" \
  --output "$B/dex" $(cat "$B/classes.txt")

echo "5) package - resources.arsc stored (Android 11+ requirement)"
cd "$B"
python3 - <<'EOF'
import os, zipfile
src = []
with zipfile.ZipFile('base.apk') as z:
    for n in z.namelist():
        src.append((n, z.read(n)))
if not os.path.exists('dex/classes.dex'):
    raise SystemExit('dex/classes.dex MISSING')
src.append(('classes.dex', open('dex/classes.dex', 'rb').read()))
with zipfile.ZipFile('unsigned.apk', 'w') as z:
    order = {'AndroidManifest.xml': 0, 'resources.arsc': 1, 'classes.dex': 2}
    src.sort(key=lambda x: order.get(x[0], 9))
    for n, data in src:
        if n == 'AndroidManifest.xml':
            z.writestr(zipfile.ZipInfo(n), data, zipfile.ZIP_DEFLATED)
        elif n == 'resources.arsc':
            zi = zipfile.ZipInfo(n); zi.compress_type = zipfile.ZIP_STORED
            z.writestr(zi, data)
        else:
            z.writestr(n, data, zipfile.ZIP_DEFLATED)
print('unsigned.apk OK,', len(src), 'entries (dex included)')
EOF

echo "6) zipalign + sign"
cd ..
"$ZALIGN" -f 4 "$B/unsigned.apk" "$B/aligned.apk"
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" \
  --ks-key-alias "$KS_ALIAS" --key-pass "pass:$KEY_PASS" \
  --out "$OUT" "$B/aligned.apk"
"$APKSIGNER" verify --print-certs "$OUT" | head -3

echo "=== OUT: $OUT ==="
ls -la "$OUT"
