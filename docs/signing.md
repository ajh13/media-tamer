# Firefox Signing Notes

Firefox requires Mozilla signing for permanent installation of release builds. This repo currently produces an unsigned self-distribution ZIP only.

## Current build artifact

```bash
npm ci
npm run build
```

Output:

```text
dist/media_tamer-<manifest-version>.zip
```

The ZIP is suitable for Mozilla Add-ons Developer Hub upload using the unlisted/self-distribution path. It is not directly installable as a permanent release in standard Firefox until Mozilla signs it.

## First signing workflow

1. Build the unsigned ZIP with `npm run build`.
2. Open Mozilla Add-ons Developer Hub.
3. Submit a new add-on for **On your own** distribution / self-distribution.
4. Upload `dist/media_tamer-<version>.zip`.
5. Complete Mozilla validation/review prompts.
6. Download the signed `.xpi` from the Developer Hub once available.
7. Install the signed `.xpi` in Firefox.

## Automation status

Automated AMO signing is intentionally not configured yet. It requires AMO API credentials or an interactive Mozilla login, and the first submission may involve account prompts/CAPTCHA. Do not disable Firefox signature verification to work around signing.
