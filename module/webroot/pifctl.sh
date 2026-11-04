#!/system/bin/sh
#
# pifctl.sh - WebUI backend for Play Integrity Fork
#
# Backend helper used only by the module WebUI (webroot/). It adds files and
# never edits upstream scripts, so syncing with upstream stays conflict free.
# To target a specific device it copies the current autopif4.sh into a sandbox
# and drives it with a shadowed getprop, staying in sync with upstream changes.
#
# Usage: sh pifctl.sh <command> [args...]
#   version                         print module version
#   read                            print active config (SOURCE line + body)
#   save <base64>                   write base64-decoded body to custom.pif.prop
#   init                            version, cached device list and config in one call
#   devices                         refresh the device list from Google (slow, cached)
#   devices-cached                  device list without the network (instant)
#   generate <codename>            sandbox-generate a fresh print for a device
#   generate-random                 sandbox-generate a fresh print (random device)
#   apply <printfile>               install a generated print and restart GMS
#   killpi                          restart GMS DroidGuard / Play Store processes
#

MODID=playintegrityfix

# MODDIR and WORK are overridable so the test harness can run against a fake
# module tree without touching the real one.
MODDIR=${PIFCTL_MODDIR:-/data/adb/modules/$MODID}
[ -f "$MODDIR/module.prop" ] || MODDIR=/data/adb/modules/$MODID
WORK=${PIFCTL_WORK:-/data/local/tmp/pifctl_gen}

# --- helpers --------------------------------------------------------------

die() { echo "__PIFCTL_ERROR__=$*"; exit 1; }

# A device codename is lowercase alphanumeric with underscores. Anything else
# is rejected before it reaches the generated getprop shim.
valid_code() { case "$1" in ''|*[!a-z0-9_]*) return 1;; esac; }

# A marketing model is free text from Google's device list. Restrict it to a
# printable subset so it cannot break out of the shim it gets written into.
valid_model() { case "$1" in ''|*[!A-Za-z0-9\ ._\(\)+/-]*) return 1;; esac; }

# Tab used as the field separator in device rows.
TAB=$(printf '\t')

# base64 payloads are standard-alphabet only.
valid_b64() { echo "$1" | grep -qE '^[A-Za-z0-9+/=]+$'; }

# Portable downloader: prefer wget, fall back to busybox wget, then curl.
BUSYBOX=
find_busybox() {
  [ -n "$BUSYBOX" ] && return 0
  local p
  for p in /data/adb/modules/busybox-ndk/system/*/busybox \
           /data/adb/magisk/busybox /data/adb/ksu/bin/busybox \
           /data/adb/ap/bin/busybox; do
    [ -f "$p" ] && { BUSYBOX="$p"; return 0; }
  done
  return 1
}

dl() { # dl <url> <outfile>
  if command -v wget >/dev/null 2>&1 && ! grep -q "wget-curl" "$(command -v wget)" 2>/dev/null; then
    wget -q -T 10 -O "$2" --no-check-certificate "$1" 2>/dev/null && return 0
  fi
  if find_busybox; then
    "$BUSYBOX" wget -q -T 10 -O "$2" --no-check-certificate "$1" 2>/dev/null && return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -s -m 15 -k -o "$2" "$1" 2>/dev/null && return 0
  fi
  return 1
}

# --- commands -------------------------------------------------------------

cmd_version() {
  local l
  [ -f "$MODDIR/module.prop" ] || return 0
  while IFS= read -r l; do
    case "$l" in version=*) echo "${l#version=}"; return 0;; esac
  done < "$MODDIR/module.prop"
}

# Print the active config. Priority: custom.pif.prop > example.pif.prop template.
cmd_read() {
  local f
  if [ -f "$MODDIR/custom.pif.prop" ]; then
    f="$MODDIR/custom.pif.prop"; echo "SOURCE=custom.pif.prop"
  elif [ -f "$MODDIR/custom.pif.json" ]; then
    f="$MODDIR/custom.pif.json"; echo "SOURCE=custom.pif.json"
  elif [ -f "$MODDIR/example.pif.prop" ]; then
    f="$MODDIR/example.pif.prop"; echo "SOURCE=example.pif.prop"
  else
    echo "SOURCE=none"; return 0
  fi
  echo "__PIFCTL_BODY__"
  cat "$f"
}

# Write a new custom.pif.prop from a base64-encoded body (avoids shell quoting).
cmd_save() {
  [ -n "$1" ] || die "no data"
  valid_b64 "$1" || die "invalid payload"
  local tmp="$WORK/save.$$"
  mkdir -p "$WORK"
  if echo "$1" | base64 -d > "$tmp" 2>/dev/null; then :; else
    find_busybox && echo "$1" | "$BUSYBOX" base64 -d > "$tmp" 2>/dev/null || die "base64 decode failed"
  fi
  [ -s "$tmp" ] || die "empty payload"
  [ -f "$MODDIR/custom.pif.prop" ] && cp -f "$MODDIR/custom.pif.prop" "$MODDIR/custom.pif.prop.bak"
  cp -f "$tmp" "$MODDIR/custom.pif.prop"
  rm -f "$tmp"
  echo "__PIFCTL_SAVED__=custom.pif.prop"
}

# Device list. Lines are "codename<TAB>Model".
#
# The live list comes from the same Google pages autopif4 crawls. It is slow
# (several sequential downloads), so it is cached and the WebUI only refreshes
# it when the cache is old. The built-in list parsed from autopif4's own device
# map is the instant fallback, so the picker is never empty or blocked.

CACHE=${PIFCTL_CACHE:-/data/local/tmp/pifctl_cache}
DEVCACHE="$CACHE/devices"

# Keep only well-formed rows so a changed or hostile page cannot put anything
# unexpected into the cache or the UI.
_clean_devices() {
  local code model
  while IFS="$TAB" read -r code model; do
    valid_code "$code" || continue
    valid_model "$model" || continue
    echo "$code$TAB$model"
  done
}

_rows() { local n; n=$(grep -c 'tr id=' "$1" 2>/dev/null); echo "${n:-0}"; }

# Crawl in a private directory (not $WORK) so a refresh never races with, or
# gets wiped by, a generation run.
_crawl_devices() {
  local d="$CACHE/crawl.$$" src latest
  mkdir -p "$d" && cd "$d" || return 1
  dl "https://developer.android.com/about/versions" PIXEL_VERSIONS_HTML || { cd /; rm -rf "$d"; return 1; }
  latest=$(grep -B4 -A2 'data-icon="preview' PIXEL_VERSIONS_HTML | grep -o 'href="/about/versions/.*[0-9]"' | cut -d\" -f2)
  [ "$latest" ] || latest=$(grep -oE 'href="/about/versions/[0-9]{2}"' PIXEL_VERSIONS_HTML | cut -d\" -f2 | sort -ru | head -n1)
  if [ "$latest" ] && dl "https://developer.android.com$latest" PIXEL_LATEST_HTML; then
    dl "https://developer.android.com$(grep -o 'href=".*download.*"' PIXEL_LATEST_HTML | grep -v 'ota' | cut -d\" -f2 | sort -ru | head -n1)" PIXEL_FI_HTML
    dl "https://developer.android.com$(grep -o 'href=".*download-ota.*"' PIXEL_LATEST_HTML | cut -d\" -f2 | sort -ru | head -n1)" PIXEL_OTA_HTML
    src=FI
    [ "$(_rows PIXEL_FI_HTML)" -lt "$(_rows PIXEL_OTA_HTML)" ] && src=OTA
    if grep -q 'tr id=' "PIXEL_${src}_HTML" 2>/dev/null; then
      grep 'tr id=' "PIXEL_${src}_HTML" | sed 's;.*<tr id="\(.*\)">.*;\1;' > codes
      grep -A1 'tr id=' "PIXEL_${src}_HTML" | grep 'td' | sed 's;.*<td>\(.*\)</td>.*;\1;' > models
      if [ -s codes ] && [ "$(wc -l < codes)" = "$(wc -l < models)" ]; then
        paste -d"$TAB" codes models | _clean_devices > rows
        if [ -s rows ]; then
          { echo "__PIFCTL_TS__=$(date +%s)"; cat rows; } > "$d/cache"
          mkdir -p "$CACHE" && mv -f "$d/cache" "$DEVCACHE"
          cat rows
          cd /; rm -rf "$d"
          return 0
        fi
      fi
    fi
  fi
  cd /; rm -rf "$d"
  return 1
}

# Network refresh. Prints the new list after __PIFCTL_DEVSRC__=live, or only
# __PIFCTL_DEVSRC__=failed so the UI keeps whatever it is already showing.
cmd_devices() {
  local rows
  if [ -z "$PIFCTL_OFFLINE" ] && rows=$(_crawl_devices) && [ -n "$rows" ]; then
    echo "__PIFCTL_DEVSRC__=live"
    echo "$rows"
  else
    echo "__PIFCTL_DEVSRC__=failed"
  fi
}

# No network: the cached live list if present, else the built-in one. Also
# reports the cache age in seconds (-1 when there is no cache) so the UI can
# decide whether a refresh is worth it.
cmd_devices_cached() {
  local ts now
  if [ -f "$DEVCACHE" ]; then
    ts=$(sed -n '1s/^__PIFCTL_TS__=//p' "$DEVCACHE")
    case "$ts" in ''|*[!0-9]*) ts= ;; esac
  fi
  if [ -n "$ts" ]; then
    now=$(date +%s)
    echo "__PIFCTL_DEVSRC__=cache"
    echo "__PIFCTL_AGE__=$((now - ts))"
    sed '1d' "$DEVCACHE" | _clean_devices
  else
    echo "__PIFCTL_DEVSRC__=builtin"
    echo "__PIFCTL_AGE__=-1"
    cmd_devices_builtin
  fi
}

# Parse autopif4's device map, e.g.
#   "  panther|cheetah) DEVICE_INITIAL_SDK_INT=33;; # Pixel 7 Series"
# Pure shell parameter expansion and echo only. printf is not a builtin in
# Android's sh, so every call would fork; the earlier sed-per-line version cost
# roughly a hundred forks.
cmd_devices_builtin() {
  [ -f "$MODDIR/autopif4.sh" ] || return 0
  local line codes name c oldifs
  # grep first: mksh reads a file one byte per syscall, so looping over the
  # whole 12 KB script is slower than one grep plus a loop over ~14 lines.
  grep -E 'DEVICE_INITIAL_SDK_INT=[0-9]+;; #' "$MODDIR/autopif4.sh" | while IFS= read -r line; do
    case "$line" in
      *') DEVICE_INITIAL_SDK_INT='[0-9]*';; #'*) ;;
      *) continue ;;
    esac
    codes=${line%%)*}
    codes=${codes#"${codes%%[![:space:]]*}"}
    name=${line#*';; #'}
    name=${name%%;*}
    name=${name#"${name%%[![:space:]]*}"}
    name=${name%"${name##*[![:space:]]}"}
    oldifs=$IFS; IFS='|'
    set -f
    for c in $codes; do
      valid_code "$c" && [ -n "$name" ] && echo "$c$TAB$name"
    done
    set +f
    IFS=$oldifs
  done
}

# Everything the WebUI needs on open, in one process: version, device list
# and config. The config goes last because its body is free-form text.
cmd_init() {
  echo "__PIFCTL_VERSION__=$(cmd_version)"
  cmd_devices_cached
  cmd_read
}

# Build a getprop shim so a copy of autopif4 "matches" the chosen device.
# Interpreter and passthrough binary are overridable for the test harness.
_make_shim() {
  cat > "$WORK/getprop" <<EOF
#!${PIFCTL_SH:-/system/bin/sh}
case "\$1" in
  ro.product.device) echo "$1";;
  ro.product.model) echo "$2";;
  *) exec ${PIFCTL_GETPROP:-/system/bin/getprop} "\$@";;
esac
EOF
  chmod 0755 "$WORK/getprop"
}

# Generation wipes and rewrites $WORK, so two runs at once (a retry, or the
# page reopened mid-run) would delete each other's files. Allow one at a time.
# A lock left by a killed run is detected by its dead PID and reclaimed.
LOCK="$CACHE/generate.lock"

_unlock() { rm -rf "$LOCK"; }

_lock() {
  local pid
  mkdir -p "$CACHE" || die "no cache dir"
  if ! mkdir "$LOCK" 2>/dev/null; then
    pid=$(cat "$LOCK/pid" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      die "another generation is already running"
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || die "could not take the generation lock"
  fi
  echo $$ > "$LOCK/pid"
  trap _unlock EXIT INT TERM
}
# Prepare a clean sandbox with the CURRENT autopif4.sh copied in (never edited).
_prep_sandbox() {
  rm -rf "$WORK"; mkdir -p "$WORK" || die "no workdir"
  cp -f "$MODDIR/autopif4.sh" "$WORK/autopif4.sh" || die "autopif4.sh missing"
  chmod 0755 "$WORK/autopif4.sh"
}

# Run the sandboxed autopif4 so it never auto-installs; we validate then apply.
# $1 = extra args (e.g. -m). A getprop shim in $WORK (if present) is shadowed in.
_run_sandbox() {
  cd "$WORK" || die "no workdir"
  PATH="$WORK:$PATH" sh "$WORK/autopif4.sh" $1
}

cmd_generate() {
  local code="$1" model
  [ -n "$code" ] || die "no device"
  valid_code "$code" || die "invalid device codename"
  # The name is looked up here, not passed in: the WebUI bridge can split an
  # argument with a space ("Pixel 6a") and the model arrived as just "Pixel".
  model=$(cmd_devices_cached | grep -m1 "^$code$TAB" | cut -f2)
  [ -n "$model" ] || die "unknown device"
  _lock
  _prep_sandbox
  _make_shim "$code" "$model"
  _run_sandbox "-m"
  local out="$WORK/custom.pif.prop"
  [ -f "$out" ] || out="$WORK/pif.prop"
  if [ ! -f "$out" ]; then
    echo "__PIFCTL_RESULT__=FAIL"; return 0
  fi
  local got
  got=$(grep -m1 '^DEVICE=' "$out" | cut -d= -f2 | cut -d\# -f1 | tr -d ' \t')
  if [ "$got" = "$code" ]; then
    # MODEL in $out is whatever autopif4 read back through the getprop shim.
    # Pin it to the listed name instead of trusting that round trip, since it
    # is the one field here that depends on scraped marketing names.
    sed -i "s#^MODEL=.*#MODEL=$model#" "$out"
    echo "__PIFCTL_RESULT__=OK"
    echo "__PIFCTL_PRINT__=$out"
  else
    echo "__PIFCTL_RESULT__=MISMATCH:$got"
    echo "__PIFCTL_PRINT__=$out"
  fi
}

cmd_generate_random() {
  _lock
  _prep_sandbox
  _run_sandbox ""
  local out="$WORK/custom.pif.prop"
  [ -f "$out" ] || out="$WORK/pif.prop"
  if [ -f "$out" ]; then
    echo "__PIFCTL_RESULT__=OK"
    echo "__PIFCTL_PRINT__=$out"
  else
    echo "__PIFCTL_RESULT__=FAIL"
  fi
}

# First uncommented "key=..." line of a file.
_line_for() {
  local l
  while IFS= read -r l || [ -n "$l" ]; do
    case "$l" in "$1="*) echo "$l"; return 0;; esac
  done < "$2"
  return 1
}

# True if the file mentions the key, commented out or not.
_has_key() {
  local l
  while IFS= read -r l || [ -n "$l" ]; do
    case "$l" in "$2="*|"#$2="*|"# $2="*) return 0;; esac
  done < "$1"
  return 1
}

# A new print would otherwise reset the user's Advanced Settings and drop the
# properties they added. Advanced values come from the old file; dotted
# properties the new print does not define are carried over. Build fields and
# print-derived properties always come from the new print, so nothing stale
# from the old one gets mixed in.
_keep_user_settings() {
  local old="$1" new="$2" tmp="$2.merge" sec="" line key kept extras=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in *=*) ;; *) continue;; esac
    key=${line%%=*}
    case "$key" in ''|*[!A-Za-z0-9_.]*) continue;; *.*) ;; *) continue;; esac
    _has_key "$new" "$key" || extras="${extras:+$extras
}$line"
  done < "$old"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "# Advanced Settings") sec=adv;;
      "#"*=*) ;;
      "#"*) sec=other;;
      *=*) if [ "$sec" = adv ]; then
             kept=$(_line_for "${line%%=*}" "$old") && line=$kept
           fi;;
    esac
    echo "$line"
    [ "$line" = "# System Properties" ] && [ -n "$extras" ] && echo "$extras"
  done < "$new" > "$tmp"
  cat "$tmp" > "$new"
  rm -f "$tmp"
}

cmd_apply() {
  local src="$1" had=0
  # Only a print produced by this script (inside WORK) may be installed.
  case "$src" in
    "$WORK"/*) ;;
    *) die "refusing to apply a file outside the sandbox";;
  esac
  [ -f "$src" ] || die "no generated print"
  local dest="$MODDIR/custom.pif.prop"
  case "$src" in
    *.json) dest="$MODDIR/custom.pif.json";;
  esac
  # Merge only from a backup made just now, never a stale one from an old run.
  [ -f "$dest" ] && { cp -f "$dest" "$dest.bak"; had=1; }
  cp -f "$src" "$dest"
  if [ "$had" = 1 ]; then
    case "$dest" in *.prop) _keep_user_settings "$dest.bak" "$dest";; esac
  fi
  echo "__PIFCTL_APPLIED__=$(basename "$dest")"
  cmd_killpi
}

cmd_killpi() {
  if [ -f "$MODDIR/killpi.sh" ]; then
    sh "$MODDIR/killpi.sh" 2>&1 || true
    echo "__PIFCTL_KILLPI__=done"
  else
    echo "__PIFCTL_KILLPI__=missing"
  fi
}

# --- dispatch -------------------------------------------------------------

CMD="$1"; shift 2>/dev/null
case "$CMD" in
  version) cmd_version;;
  read) cmd_read;;
  save) cmd_save "$1";;
  init) cmd_init;;
  devices) cmd_devices;;
  devices-cached) cmd_devices_cached;;
  generate) cmd_generate "$1";;
  generate-random) cmd_generate_random;;
  apply) cmd_apply "$1";;
  killpi) cmd_killpi;;
  *) die "unknown command: $CMD";;
esac
