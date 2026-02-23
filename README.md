# Youtube to Nostr (Chrome Extension)

Chrome extension to create timestamped YouTube share links, preview before sharing, publish to Nostr via your existing signer extension, and manage history.

## Features

- In-page `Share to Nostr` button on YouTube watch pages.
- Timestamp preview modal:
  - Use current playback time or scrub to a custom timestamp.
  - Live timestamped URL generation.
  - Copy URL in one click.
- Nostr share flow:
  - Uses NIP-07 signer extensions (`window.nostr`) for `getPublicKey` + `signEvent`.
  - Lets you edit note text before signing.
  - Publishes to write relays from signer config (`getRelays`) with fallback relays.
- Share history:
  - Save/update/delete shared timestamps.
  - Reload a history item and keep editing timestamp/comment.
  - Popup history viewer with open/copy/delete.
## Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `clip-youtube`.

## Usage

1. Open any YouTube video page (`https://www.youtube.com/watch?v=...`).
2. Click `Share to Nostr` (next to YouTube top action buttons).
3. Adjust timestamp and copy URL, or add a comment and click `Share to Nostr`.
4. Save shares to history and re-open/edit them later.

## Notes

- For Nostr sharing, install a signer extension that injects `window.nostr` (e.g. Alby or nos2x).
- Custom preview capture is the visible-tab snapshot. Pause the video at the frame you want before capturing for best results.
