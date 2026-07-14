---
name: image-replay-reducer
description: Run, configure, verify, or stop the local Codex CLI image replay reducer when an OpenAI-compatible Responses provider repeatedly sends uploaded base64 images and wastes tokens. Use for Codex CLI custom-provider sessions affected by issue #28316; do not use for first-party ChatGPT-authenticated desktop traffic.
---

# Image Replay Reducer

Use this repository's `image-reducer` CLI as a localhost reverse proxy. It filters repeated `data:image/*;base64,...` history and never stores credentials. Image bytes are not retained by default; `--session-image-cache` enables encrypted, process-lifetime-only retention.

## Start

1. Identify the existing Responses-compatible upstream base URL and its API-key environment variable. Do not print the key.
2. Run `node ./bin/image-reducer.mjs start --listen 127.0.0.1:8787 --upstream <upstream-base-url>` from the repository root. Add `--session-image-cache` only when encrypted, memory-only retention for the reducer process is required.
3. Add this profile to `~/.codex/image-reducer.config.toml`, replacing the model and environment variable only when needed:

```toml
model_provider = "image_reducer"
model = "gpt-5.4"

[model_providers.image_reducer]
name = "Image Replay Reducer"
base_url = "http://127.0.0.1:8787"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
supports_websockets = false
```

4. Start a new Codex CLI session with `codex --profile image-reducer`.

## Verify and operate

- Attach an image, then send a later text-only turn. Confirm the reducer's stderr metrics report `images_replaced` and fewer `request_bytes` on the later request.
- Explicitly re-attach an image whenever the model must inspect it again; the newest user message is always preserved.
- Use `--bootstrap=strip-history` only before resuming an already polluted session. It strips images outside the newest user message on its first request and can omit an in-flight tool screenshot.
- Stop the proxy with Ctrl+C. Remove `~/.codex/image-reducer.config.toml` to undo the Codex configuration. Do not modify session/transcript files.
