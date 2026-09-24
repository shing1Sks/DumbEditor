# Asset generation

Generate an asset only when the requested edit needs one. The configured provider model is selected separately for image, speech audio, music, and video.

1. Call `generate_asset` with the correct kind and a concrete prompt.
2. Use the returned asset ID rather than guessing its path.
3. Image assets can be passed to `add_image_overlay`.
4. Generated music and speech audio can be passed to `add_background_music` with source `asset`.
5. Generated video is retained in the project workspace for a later edit or export workflow.

Generation can incur provider charges. Prefer local edit tools and the open-license catalog when they meet the request.

