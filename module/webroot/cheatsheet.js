// Static quick reference for the Cheatsheet tab.
//
// Each row carries a source tag.

window.PIF_CHEATSHEET = {
  note: "Upstream means the PlayIntegrityFork README. Tested device: Pixel 6, Android 14, custom ROM. Other devices can differ.",
  sections: [
    {
      title: "Android 13 and above",
      lead: "These verdicts depend on a locked bootloader check, so a keybox module must be set up first: Tricky Store, Tricky Store OSS, TEESimulator, TEESimulator-RS or Oh My Keymint. Then use a Pixel Canary or Beta print for your device from the Device tab. The WebUI sets MODEL to the device name.",
      rows: [
        { key: "spoofBuild", value: "1", src: "Upstream", note: "Default. Spoofs the Build fields from the print." },
        { key: "spoofProps", value: "1", src: "Upstream", note: "Default. Spoofs the system properties from the print." },
        { key: "spoofProvider", value: "0", src: "Tested", note: "Off with a keybox module. Upstream asks for it off for STRONG with Tricky Store, and only some prints need it on for DEVICE." },
        { key: "spoofSignature", value: "0", src: "Upstream", note: "Default. Only for a ROM signed with test keys, see below." },
        { key: "spoofVendingFinger", value: "1", src: "Tested", note: "Needed on the tested phone: with it off the verdict fell back to basic. Upstream advises it for a custom ROM whose fingerprint is banned." },
        { key: "spoofVendingSdk", value: "0", src: "Upstream", note: "Leave off. It replaces spoofVendingFinger and can break Play Store sign-in and downloads." },
        { key: "verboseLogs", value: "0", src: "Upstream", note: "Raise only to debug. Level 100 floods the log." }
      ],
      bullets: [
        "Extra properties: in Settings, under System Properties, use Add property for ro.product.model=<your MODEL>, ro.product.brand=google, init.svc.adbd=stopped and sys.usb.state=mtp. Without them the phone might lose device integrity and Play Store certification. Which one matters was not isolated.",
        "Applying a new print keeps your Advanced Settings and extra properties. Build fields and print properties come from the new print.",
        "Save in Settings restarts GMS, so a change takes effect without a reboot."
      ]
    },
    {
      title: "ROM signed with test keys",
      lead: "Play Integrity can fail DEVICE integrity on a ROM signed with the public AOSP test key.",
      cmd: "unzip -l /system/etc/security/otacerts.zip",
      cmdNote: "Run in a root shell. A name containing testkey means test keys; releasekey means a private key.",
      rows: [
        { key: "spoofSignature", value: "1", src: "Upstream", note: "Enable only if DEVICE still fails on a test keys ROM. Experimental. It spoofs the ROM signature in Package Manager." }
      ],
      bullets: [
        "Try first: Pixel Beta and Canary prints, which this WebUI generates, and some private prints appear to be exempt from the test key ban.",
        "Best fix: ask the ROM maintainer to sign builds with a private key."
      ]
    },
    {
      title: "If a check fails",
      bullets: [
        "Basic fails (Upstream): disable every other module except this one, then try a known working config.",
        "Device fails on KernelSU or APatch (Upstream): disable the Zygisk module, reboot, enable it, reboot again.",
        "A13+ device fails on a custom ROM (Upstream): set spoofVendingFinger to 1, then restart GMS.",
        "Not certified in the Play Store (Upstream): reflash the module, clear data for the Play Store and, if present, com.google.android.odad, then reboot. On the tested phone certification returned once the extra properties above were added."
      ]
    }
  ]
};
