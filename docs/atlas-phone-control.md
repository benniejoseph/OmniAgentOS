# ATLAS on this phone

The private Android application adds **This phone** as an explicit conversation
target in native contract **53**, app **1.28.0+89**. This document describes the
implementation; deployment and physical-device evidence are recorded separately.

## Everyday use

Open Settings → This phone, read the screen-access disclosure, and enable
Android Accessibility access for Asael. Starting phone control opens a bounded
session with an ongoing Android notification. Choose This phone in Assistant,
then give a written or spoken command. Ordinary navigation and short text entry
can proceed within that command. Consequential actions still open exact review.

The phone communicates directly with Asael. A Mac, USB cable and ADB are not
needed during normal operation. The initial supported control surface is
Android 14 or newer; Asael's other mobile features retain their existing minimum.

The initial actions are screen observation, app discovery and opening, element
presses, screenshot-based taps and swipes, editable-field text entry, scrolling,
Back and Home. These actions operate available app interfaces. They do not add
a terminal, access to other apps' private storage, notification ingestion, or
general filesystem authority. Asael's own data continues through its app tools.

## Voice and lifecycle

Android uses the continuous voice conversation path. A user-started foreground
service owns the active phone session; microphone use starts only for an explicit
voice call. The ongoing notification offers Mute, Stop and a return to Asael.
Calls can continue when another app is in front. There is no boot-time, sticky
or silent microphone start.

An active authenticated foreground session may defer the usual background
credential lock for its bounded lifetime. Protected Asael UI remains suspended
and concealed while in the background. This exception is tied to the native
session, not a saved preference. Stop, expiry, screen lock, revoked access,
logout or service failure ends that session and restores ordinary locking.

## Action boundaries

Android has its own `local.android.*` operations, native action schema and
`/api/mobile/android-control` transport. A phone cannot claim Mac commands.
The server binds work to the current tenant, actor, native installation, login
session and run, then uses the existing governed executor, claim leases,
approvals and completion receipts. A retired or uncertain mutation is not
automatically replayed.

Actions use a recent snapshot tied to the active package, window and display.
The native executor validates state again before touching the screen. App launch
and Home can establish the initial external view without reading Asael's own
protected window. All other screen interactions require their exact snapshot.

Screen text, screenshots and app metadata are untrusted evidence. They cannot
grant authority or change the user's objective. Observations are temporary input
for the assigned model and are scrubbed using the existing device-command
retention path. History retains bounded action outcomes rather than raw screens.
The setup disclosure explains that permitted screen evidence is sent to the
configured AI service to fulfil the command.

Secure fields, protected windows, known credential and finance apps, and system
security surfaces remain unavailable. The phone executor cannot operate Asael's
own approval UI or grant its own Android permissions. `FLAG_SECURE` stays enabled
on Asael. Sending, deleting, file transfer, financial and account/security
actions retain the governed approval boundary; ordinary task authority cannot
silently expand to them.

## Release

Migration 249 expands existing device and action checks for Android; it introduces
no new tenant table. Apply it through the backed-up, quiesced migration procedure
before the paired server/worker release. Publish native contract 53 and install
the signed Android build only after server deployment. Published earlier native
contracts remain frozen, and compatible Mac clients retain their platform scope.

This is a private APK feature. Google Play's rules for Accessibility-based
autonomous assistants do not provide a distribution path for this general
assistant. The implementation still observes Android's permission and secure
screen boundaries.

References: [Android AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService),
[foreground microphone services](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone),
[Google Play Accessibility policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en),
and [Mobilerun Portal](https://github.com/droidrun/mobilerun-portal).
No third-party phone-control runtime is installed by this feature.
