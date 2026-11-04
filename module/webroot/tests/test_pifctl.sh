#!/bin/sh
#
# Tests for pifctl.sh. The harness builds a fake module tree, including a stub
# autopif4.sh, so it never depends on the real upstream script and an upstream
# sync cannot break it. Run from anywhere:
#
#   sh module/webroot/tests/test_pifctl.sh
#
# Requires a POSIX shell with coreutils (Linux, Android, or Git bash on Windows).

set -u

HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
PIFCTL="$HERE/../pifctl.sh"
[ -f "$PIFCTL" ] || { echo "cannot find pifctl.sh at $PIFCTL"; exit 2; }

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t pifctl)
FAKE="$TMP/mod"
WORKDIR="$TMP/work"
mkdir -p "$FAKE"
trap 'rm -rf "$TMP"' EXIT INT TERM

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
no() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }
contains() { case "$2" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
assert_has() { if contains "$2" "$3"; then ok "$1"; else no "$1 (missing: $2)"; fi; }
assert_hasnt() { if contains "$2" "$3"; then no "$1 (unexpected: $2)"; else ok "$1"; fi; }

# --- build the fake module tree ------------------------------------------

cat > "$FAKE/module.prop" <<'EOF'
id=playintegrityfix
version=vTEST
versionCode=1
EOF

cat > "$FAKE/example.pif.prop" <<'EOF'
# Build Fields
MANUFACTURER=
MODEL=

# Advanced Settings
spoofBuild=1
verboseLogs=0
EOF

cat > "$FAKE/killpi.sh" <<'EOF'
#!/bin/sh
touch "$(dirname "$0")/.killed"
EOF

# Stub autopif4.sh: mirrors just enough behaviour to exercise the sandbox,
# the getprop shim, and match/mismatch detection. It also carries a device
# case map (inside an inert heredoc) for the offline fallback parser. The
# model is deliberately truncated to the first word to reproduce the real
# marketing-name round trip bug (e.g. "Pixel Fold" -> "Pixel") so the test
# proves pifctl.sh's post-match correction actually fixes it.
cat > "$FAKE/autopif4.sh" <<'EOF'
#!/bin/sh
MATCH=
for a in "$@"; do [ "$a" = "-m" ] && MATCH=1; done
BETA="shiba husky caiman"
DEV=shiba
MODEL="Pixel 8"
if [ -n "$MATCH" ]; then
  d=$(getprop ro.product.device)
  case " $BETA " in
    *" $d "*) DEV=$d; MODEL=$(getprop ro.product.model | cut -d' ' -f1) ;;
  esac
fi
cat > custom.pif.prop <<INNER
# Build Fields
MANUFACTURER=Google
MODEL=$MODEL
FINGERPRINT=google/${DEV}_beta/${DEV}:CANARY/AP4A.260110.001/12345678:user/release-keys
PRODUCT=${DEV}_beta
DEVICE=$DEV
SECURITY_PATCH=2026-01-05
DEVICE_INITIAL_SDK_INT=34

# Advanced Settings
spoofBuild=1
verboseLogs=0

# Canary Released: 2026-01-10
# Estimated Expiry: 2026-02-21
INNER
: <<'MAP'
  bluejay) DEVICE_INITIAL_SDK_INT=32;; # Pixel 6a
  husky) DEVICE_INITIAL_SDK_INT=34;; # Pixel 8 Pro
MAP
EOF

OFFLINE=
runp() {
    PIFCTL_MODDIR="$FAKE" PIFCTL_WORK="$WORKDIR" PIFCTL_CACHE="$TMP/cache" \
    PIFCTL_SH=/bin/sh PIFCTL_GETPROP=/bin/true \
    PIFCTL_OFFLINE="$OFFLINE" sh "$PIFCTL" "$@" 2>&1
}

# --- cases ----------------------------------------------------------------

assert_has "version reads module.prop" "vTEST" "$(runp version)"

out=$(runp read)
assert_has "read reports example template as source" "SOURCE=example.pif.prop" "$out"

out=$(runp devices-cached)
assert_has "no cache falls back to the built-in list" "__PIFCTL_DEVSRC__=builtin" "$out"
assert_has "built-in list reports no cache age" "__PIFCTL_AGE__=-1" "$out"
assert_has "built-in list parses bluejay" "bluejay	Pixel 6a" "$out"
assert_has "built-in list parses husky" "husky	Pixel 8 Pro" "$out"

out=$(runp init)
assert_has "init reports the version" "__PIFCTL_VERSION__=vTEST" "$out"
assert_has "init includes the device list" "husky	Pixel 8 Pro" "$out"
assert_has "init includes the config source" "SOURCE=example.pif.prop" "$out"
assert_has "init includes the config body marker" "__PIFCTL_BODY__" "$out"
case "$out" in *"__PIFCTL_DEVSRC__"*"SOURCE="*) ok "init prints devices before the free-form config" ;; *) no "init ordering" ;; esac

OFFLINE=1
out=$(runp devices)
OFFLINE=
assert_has "refresh with no network reports failure only" "__PIFCTL_DEVSRC__=failed" "$out"
assert_hasnt "failed refresh prints no rows" "$out" "	"

# Live refresh against a fake wget that serves canned Google pages, so the
# real crawl and parse code runs. One row has a hostile codename.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/wget" <<'EOF'
#!/bin/sh
out=; url=
while [ $# -gt 0 ]; do
  case "$1" in
    -O) out=$2; shift ;;
    -T) shift ;;
    -q|--no-check-certificate) ;;
    *) url=$1 ;;
  esac
  shift
done
case "$url" in
  */download-ota) : > "$out" ;;
  */download) printf '<tr id="shiba">\n<td>Pixel 8</td>\n<tr id="husky">\n<td>Pixel 8 Pro</td>\n<tr id="bad;code">\n<td>Pixel X</td>\n' > "$out" ;;
  */versions/17) printf '<a href="/about/versions/17/download">\n<a href="/about/versions/17/download-ota">\n' > "$out" ;;
  */versions) printf '<a href="/about/versions/17">\n<span data-icon="preview"></span>\n' > "$out" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/wget"

mkdir -p "$WORKDIR"; : > "$WORKDIR/marker"
out=$(PATH="$TMP/bin:$PATH" runp devices)
assert_has "live refresh reports live" "__PIFCTL_DEVSRC__=live" "$out"
assert_has "live refresh parses shiba" "shiba	Pixel 8" "$out"
assert_has "live refresh parses husky" "husky	Pixel 8 Pro" "$out"
assert_hasnt "live refresh drops a malformed codename" "$out" "bad;code"
if [ -f "$WORKDIR/marker" ]; then ok "live refresh leaves the generation sandbox alone"; else no "live refresh leaves the generation sandbox alone"; fi

out=$(runp devices-cached)
assert_has "cached list is served after a refresh" "__PIFCTL_DEVSRC__=cache" "$out"
assert_has "cached list reports a numeric age" "__PIFCTL_AGE__=" "$out"
assert_hasnt "cached list does not include the built-in rows" "$out" "bluejay"
assert_has "cached list keeps the refreshed rows" "shiba	Pixel 8" "$out"

printf '__PIFCTL_TS__=notanumber\nshiba\tPixel 8\n' > "$TMP/cache/devices"
out=$(runp devices-cached)
assert_has "corrupt cache falls back to the built-in list" "__PIFCTL_DEVSRC__=builtin" "$out"
rm -f "$TMP/cache/devices"
out=$(runp generate husky)
assert_has "generate matched device returns OK" "__PIFCTL_RESULT__=OK" "$out"
assert_has "generated print keeps requested device" "$WORKDIR/custom.pif.prop" "$out"
generated=$(cat "$WORKDIR/custom.pif.prop")
assert_has "generated file has DEVICE=husky" "DEVICE=husky" "$generated"
assert_has "generated model is corrected despite the stub truncating it" "MODEL=Pixel 8 Pro" "$generated"

# The WebUI bridge once split "Pixel 8 Pro" into words. A split name must not
# reach the print, so extra arguments are ignored and the listed name is used.
out=$(runp generate husky Pixel 8 Pro)
assert_has "extra words after the codename are ignored" "__PIFCTL_RESULT__=OK" "$out"
assert_has "model comes from the list, not the arguments" "MODEL=Pixel 8 Pro" "$(cat "$WORKDIR/custom.pif.prop")"

runp apply "$WORKDIR/custom.pif.prop" >/dev/null
assert_has "apply installs custom.pif.prop" "DEVICE=husky" "$(cat "$FAKE/custom.pif.prop")"
if [ -f "$FAKE/.killed" ]; then ok "apply runs killpi"; else no "apply runs killpi"; fi

out=$(runp read)
assert_has "read now reports custom source" "SOURCE=custom.pif.prop" "$out"

# Applying a print keeps the user's Advanced Settings and extra properties.
# The old config has a stale print-derived property, a commented advanced line
# and an inline comment, which are the cases a naive merge gets wrong.
cat > "$FAKE/custom.pif.prop" <<'EOF'
# Build Fields
MODEL=Old Model
FINGERPRINT=old/print

# System Properties
ro.build.fingerprint=old/print
ro.build.id=OLDID
ro.product.brand=google
init.svc.adbd=stopped

# Advanced Settings
spoofBuild=0
spoofVendingFinger=1  # keep me
verboseLogs=50
#spoofVendingSdk=1
EOF
cat > "$WORKDIR/merge.prop" <<'EOF'
# Build Fields
MODEL=New Model
FINGERPRINT=new/print

# System Properties
ro.build.fingerprint=new/print
#ro.build.id=NEWID

# Advanced Settings
spoofBuild=1
spoofVendingFinger=0
spoofVendingSdk=0
verboseLogs=0
spoofProvider=1

# Canary Released: 2026-01-10
EOF
runp apply "$WORKDIR/merge.prop" >/dev/null
merged=$(cat "$FAKE/custom.pif.prop")
assert_has "apply takes build fields from the new print" "MODEL=New Model" "$merged"
assert_hasnt "apply drops the old print's build fields" "$merged" "Old Model"
assert_has "apply takes print properties from the new print" "ro.build.fingerprint=new/print" "$merged"
assert_hasnt "apply does not revive a property the new print has commented out" "$merged" "OLDID"
assert_has "apply keeps an advanced value from the old config" "spoofBuild=0" "$merged"
assert_has "apply keeps the inline comment on a kept line" "spoofVendingFinger=1  # keep me" "$merged"
assert_has "apply keeps the old verboseLogs" "verboseLogs=50" "$merged"
assert_has "apply ignores a commented advanced line" "spoofVendingSdk=0" "$merged"
assert_has "apply keeps a default the old config lacks" "spoofProvider=1" "$merged"
assert_has "apply carries over extra properties" "ro.product.brand=google" "$merged"
assert_has "apply carries over a second extra property" "init.svc.adbd=stopped" "$merged"
section=$(printf '%s\n' "$merged" | sed -n '/^# System Properties/,/^# Advanced Settings/p')
assert_has "carried properties land in System Properties" "ro.product.brand=google" "$section"
assert_has "the footer comment survives the merge" "# Canary Released: 2026-01-10" "$merged"

# A leftover backup from an earlier run must not leak into a first apply.
rm -f "$FAKE/custom.pif.prop"
runp apply "$WORKDIR/merge.prop" >/dev/null
fresh=$(cat "$FAKE/custom.pif.prop")
assert_has "a first apply is a plain copy" "spoofBuild=1" "$fresh"
assert_hasnt "a first apply ignores a stale backup" "$fresh" "ro.product.brand"

out=$(runp generate bluejay)
assert_has "unavailable device reports mismatch" "__PIFCTL_RESULT__=MISMATCH:shiba" "$out"

out=$(runp generate "bad code")
assert_has "invalid codename is rejected" "__PIFCTL_ERROR__=invalid device codename" "$out"

out=$(runp generate nosuchdevice)
assert_has "a codename missing from the list is rejected" "__PIFCTL_ERROR__=unknown device" "$out"

out=$(runp generate-random)
assert_has "random generation returns OK" "__PIFCTL_RESULT__=OK" "$out"

if [ ! -d "$TMP/cache/generate.lock" ]; then ok "lock is released after a run"; else no "lock is released after a run"; fi

# A live lock holder blocks generation; a lock left by a dead process does not.
mkdir -p "$TMP/cache/generate.lock"
sleep 30 &
holder=$!
echo "$holder" > "$TMP/cache/generate.lock/pid"
out=$(runp generate husky)
assert_has "generation is refused while another run holds the lock" "__PIFCTL_ERROR__=another generation is already running" "$out"
assert_hasnt "a refused run leaves the other run's sandbox alone" "$out" "__PIFCTL_RESULT__"
kill "$holder" 2>/dev/null
wait "$holder" 2>/dev/null
out=$(runp generate husky)
assert_has "a lock left by a dead run is reclaimed" "__PIFCTL_RESULT__=OK" "$out"

out=$(runp apply /etc/hosts)
assert_has "apply outside sandbox is refused" "refusing to apply a file outside the sandbox" "$out"

out=$(runp save "not valid base64 !!")
assert_has "invalid base64 payload is rejected" "__PIFCTL_ERROR__=invalid payload" "$out"

payload=$(printf 'DEVICE=fromsave\n' | base64 | tr -d '\n')
runp save "$payload" >/dev/null
assert_has "save writes decoded body" "DEVICE=fromsave" "$(cat "$FAKE/custom.pif.prop")"
if [ -f "$FAKE/custom.pif.prop.bak" ]; then ok "save backs up previous config"; else no "save backs up previous config"; fi

# --- summary --------------------------------------------------------------

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
