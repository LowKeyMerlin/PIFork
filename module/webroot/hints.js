// Curated hint / description map for Play Integrity Fork options.
//
// This is an enrichment layer only. The settings form is built dynamically by
// parsing the live config file, so new or unknown options still render on their
// own (with a generic cue). Add an entry here to give any option a nicer
// description without changing any other file.
//
// Keys are matched case-insensitively against the config key. Inline `#`
// comments present in the config file take precedence over these.

window.PIF_HINTS = {
  // ---- Build Fields -------------------------------------------------------
  MANUFACTURER: { desc: "Device maker, e.g. Google. Maps to ro.product.manufacturer / Build.MANUFACTURER." },
  MODEL: { desc: "Marketing model name shown to apps, e.g. 'Pixel 8 Pro'. Must match the spoofed device." },
  FINGERPRINT: { desc: "The full build fingerprint (brand/product/device:release/id/incremental:type/tags). The single most important value for passing integrity. Also sets ro.build.fingerprint." },
  BRAND: { desc: "Build brand, usually 'google'. Derived from FINGERPRINT if left empty." },
  PRODUCT: { desc: "Build product name, e.g. 'husky_beta'. Derived from FINGERPRINT if left empty. Also sets ro.product.name." },
  DEVICE: { desc: "Device codename, e.g. 'husky' (Pixel 8 Pro). Derived from FINGERPRINT if left empty. Also sets ro.product.device." },
  RELEASE: { desc: "Android release/version from the fingerprint (e.g. 15, or CANARY for a Canary print). Derived from FINGERPRINT if empty." },
  ID: { desc: "Build ID, e.g. 'AP4A.241205.013'. Derived from FINGERPRINT if empty. Also sets ro.build.id. Often encodes the build date (YYMMDD)." },
  INCREMENTAL: { desc: "Incremental build number. Derived from FINGERPRINT if empty." },
  TYPE: { desc: "Build type, usually 'user'. Derived from FINGERPRINT if empty." },
  TAGS: { desc: "Build tags, usually 'release-keys'. Derived from FINGERPRINT if empty." },
  SECURITY_PATCH: { desc: "Security patch date (YYYY-MM-DD). Must be plausible for the build. Also sets ro.build.version.security_patch. For STRONG integrity with Tricky Store this is sometimes commented out so patch levels can be matched instead." },
  DEVICE_INITIAL_SDK_INT: { desc: "The device's first API level (ro.product.first_api_level). 21-25 tends to suit <A13 DEVICE integrity (AOSP software keybox); 26-32 suits <A13 STRONG (hardware keybox). Values >35 may require an RKP keybox." },

  // ---- System Properties --------------------------------------------------
  "ro.build.fingerprint": { desc: "System property form of FINGERPRINT, spoofed to DroidGuard." },
  "ro.build.id": { desc: "System property form of the build ID." },
  "ro.product.device": { desc: "System property form of the device codename." },
  "ro.product.name": { desc: "System property form of the product name." },
  "ro.build.version.security_patch": { desc: "System property form of the security patch date. Comment out (prefix #) to let Tricky Store manage the patch level for STRONG integrity." },
  "ro.board.first_api_level": { desc: "Board first API level. Set to 32 by default to override conflicting ROM values greater than 32." },
  "ro.product.first_api_level": { desc: "System property form of DEVICE_INITIAL_SDK_INT (first API level)." },
  "ro.product.model": { desc: "Model name DroidGuard reads as a system property. Keep it equal to MODEL." },
  "ro.product.brand": { desc: "Brand DroidGuard reads as a system property, usually 'google'." },
  "init.svc.adbd": { desc: "Reported state of the adb daemon. 'stopped' hides active debugging from DroidGuard." },
  "sys.usb.state": { desc: "Reported USB mode. 'mtp' hides an adb connection from DroidGuard." },

  // ---- Advanced Settings --------------------------------------------------
  spoofBuild: { desc: "Spoof the android.os.Build fields from the fingerprint. Enabled by default. Disable only if another module should own Build spoofing." },
  spoofProps: { desc: "Spoof the system properties from the fingerprint. Enabled by default. Usually required for <A13 DEVICE integrity via Tricky Store." },
  spoofProvider: { desc: "Spoof the Keystore provider. Enabled by default. Disable when using an unrevoked hardware keybox with Tricky Store to pass <A13 STRONG integrity." },
  spoofSignature: { desc: "Spoof the ROM signature in Package Manager. Disabled by default. Experimental workaround for the AOSP testkey ROM ban. Check your ROM signing key with: unzip -l /system/etc/security/otacerts.zip | grep -oE 'testkey|releasekey'." },
  spoofVendingFinger: { desc: "Spoof ROM FINGERPRINT to the Play Store (com.android.vending). Set 1 to use this print, or a custom FINGERPRINT value. Helps A13+ DEVICE integrity when your ROM fingerprint is banned. A value from a too-dissimilar device can change app availability and served variants." },
  spoofVendingSdk: { desc: "Spoof ROM SDK_INT/sdkVersion 32 to the Play Store to force the older <A13 PI verdicts. Disabled by default and not recommended to leave on, since it can break Play Store navigation, sign-in and downloads. Use the QSTile toggle for temporary testing." },
  verboseLogs: { desc: "Logging level: 0 off, 1 to 3 increasing detail, 100 dumps all Build fields and every property DroidGuard checks. View with: logcat | grep 'PIF/'." }
};
