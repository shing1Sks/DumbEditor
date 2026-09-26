---
name: asset-generation
description: Generate or source image, speech, music, and video assets while preserving user intent, cost, provenance, and license obligations.
---

# Asset generation and sourcing

Choose the route from the user's intent:

- If they say *generate*, create a new asset with `generate_asset`. Do not silently substitute stock media.
- If they ask to *find*, *use free music*, or do not require a unique asset, prefer a verified open-license catalog result.
- If either route fails, report the exact failure. Offer or use the other route only when the request permits a fallback, and label the fallback clearly.

## Generate

1. Call `generate_asset` with `kind` and a concrete prompt. Omit optional provider, model, voice, and provider options when using configured defaults; never send strings such as `null` or `default`.
2. Use the returned asset ID. Never claim generation succeeded until the tool returns an asset.
3. Use `add_image_overlay` for images and `add_background_music` with source `asset` for music or speech.
4. Keep the provider, model, cost, and generated provenance attached. Generated media does not automatically have a Creative Commons or public-domain license.
5. If a generation provider returns an empty result or availability error, state that the provider failed. Do not describe a later catalog asset as generated.

## Source reusable media

"Royalty-free" is a payment/licensing label, not a synonym for copyright-free or restriction-free. Inspect the license for the individual asset and retain its title, creator, source URL, exact license name and URL, required attribution, and a note about modifications.

- **CC0:** copyright reuse has no conditions, but trademark, patent, privacy, publicity, and endorsement issues can still apply.
- **CC BY:** commercial use and adaptations are allowed with appropriate creator credit, a license link, and an indication of changes. Do not imply endorsement.
- **CC BY-NC:** exclude from commercial or unclear commercial projects unless the user confirms the use is noncommercial.
- **CC BY-ND:** do not distribute an edited or remixed version.
- **Site licenses:** Unsplash and Pexels allow broad free use but retain restrictions such as resale of unmodified media, competing libraries, trademarks, endorsement, or harmful depictions. Preserve the source's own license URL.
- **Mixed repositories:** Freesound, Wikimedia Commons, and similar catalogs license each item separately. Verify the item page rather than assuming the site's name defines the license.

For CC BY, prepare a credit containing title, creator, source, `CC BY 4.0`, the license URL, and `modified` when the asset was trimmed, looped, mixed, recolored, or otherwise changed.

Primary references: https://creativecommons.org/licenses/by/4.0/ | https://creativecommons.org/publicdomain/zero/1.0/ | https://unsplash.com/license | https://www.pexels.com/license/ | https://freesound.org/help/faq/
