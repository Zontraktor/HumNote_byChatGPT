# HumNote

HumNote is a mobile-first Progressive Web App for capturing melody ideas by humming, whistling, or singing into your microphone.

## What it does

- Records short melody ideas from your microphone
- Detects likely pitches while you record
- Saves the original audio clip plus a simple note sketch
- Stores everything locally in your browser with offline support
- Lets you replay either the original recording or a synthetic melody playback
- Installs on Android as a home-screen app

## Run locally

1. Open a terminal in `F:\00_ChatGPT_Codex_stuff-02`
2. Run `npm start`
3. Open `http://localhost:4173`

## Install on a Pixel phone

1. Make sure the app is served over `https` or from a trusted local development tunnel
2. Open the app in Chrome on your Pixel
3. Use Chrome's install option or the in-app `Install App` button when available
4. Grant microphone permission

## Notes

- The current MVP stores entries in browser IndexedDB, so recordings stay on the device/browser profile where they were created.
- Pitch detection works best with steady humming, whistling, or single-note singing.
- A future native Android version could add better background recording, cloud sync, MIDI export, and stronger pitch analysis.
