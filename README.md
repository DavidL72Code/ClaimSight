---
title: ClaimSight Backend
sdk: docker
app_port: 7860
pinned: false
---

# Insurance Damage Assessment Tool

An MVP for insurance claim triage that combines image segmentation with multimodal report generation.

## Deployment shape

- `backend`: FastAPI app intended for Hugging Face Spaces using Docker
- `frontend/`: static app intended for Vercel

## What this version does

- Upload a vehicle damage image
- Run a Hugging Face-hosted SAM 2 segmentation pipeline with graceful fallback if the model is not ready
- Optionally use Gemini to generate a grounded structured claim summary
- Display the assessment in a simple web UI

## Stack

- FastAPI
- Jinja2 templates
- Vanilla HTML/CSS/JS

## Run backend locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open `http://127.0.0.1:8000`.

## Run frontend locally

```bash
cd frontend
VITE_API_BASE_URL=http://127.0.0.1:8000 node scripts/dev.mjs
```

Then open `http://127.0.0.1:4173`.

## Backend environment

Copy `.env.example` into your shell environment or export the variables manually.

```bash
export GEMINI_API_KEY=your_key_here
export APP_ENV=production
export DEBUG=false
export ENABLE_API_DOCS=false
export API_ACCESS_TOKEN=
export GEMINI_MODEL=gemini-3.5-flash
export SEGMENTATION_PROVIDER=sam2
export SAM2_MODEL_ID=facebook/sam2-hiera-tiny
export ALLOWED_ORIGINS=https://your-frontend.vercel.app
export ALLOWED_HOSTS=your-space-subdomain.hf.space,*.hf.space
export ALLOW_CORS_WILDCARD=false
export MAX_UPLOAD_BYTES=8388608
export MAX_IMAGE_PIXELS=12000000
export RATE_LIMIT_WINDOW_SECONDS=60
export RATE_LIMIT_MAX_REQUESTS=12
```

`SEGMENTATION_PROVIDER` options:

- `sam2`: use the SAM 2 adapter and fall back to classical prompts if SAM 2 is unavailable
- `classical`: use the built-in image-analysis pipeline
- `mock`: use deterministic sample regions for demos

## Security controls

- Uploads are limited by extension, declared MIME type, decoded image format, byte size, and pixel count.
- Pillow image verification rejects spoofed files and decompression-bomb-style oversized images.
- `/api/assess` has a simple in-memory per-IP rate limit for demo deployments.
- `/api/assess` can require `Authorization: Bearer <token>` when `API_ACCESS_TOKEN` is set.
- Production Docker defaults disable debug mode and API docs.
- CORS defaults to local development origins; set `ALLOWED_ORIGINS` to the exact Vercel URL in production.
- Wildcard CORS is ignored unless `ALLOW_CORS_WILDCARD=true`; do not enable it for the public demo.
- Trusted host checks are controlled with `ALLOWED_HOSTS`.
- Security headers are set on both the FastAPI backend and Vercel frontend.
- Health checks expose whether SAM 2 failed to load without returning raw exception text.
- Frontend assessment rows are rendered with DOM text nodes instead of HTML interpolation.
- Gemini is prompted to treat image text and filenames as untrusted evidence, not instructions.
- See [SECURITY.md](/Users/davidle/Documents/Insurance%20damage%20assessment%20tool/SECURITY.md) for the checklist mapping.

Do not put `API_ACCESS_TOKEN` into the public Vercel frontend. Use it only for private API testing,
or add a server-side proxy/auth layer before enabling it for a browser-facing production app.

The deployment requirements target Python 3.10+. The existing local `.venv` is Python 3.9, so it
cannot install some security-fixed packages such as recent `python-multipart` and `requests`
versions. Use the Docker/Hugging Face Python runtime or a fresh Python 3.10+ venv for dependency
audits before a real public launch.

## SAM 2 notes

The app is wired to SAM 2 by default for the Hugging Face Space backend. The official
`facebookresearch/sam2` repository documents `python>=3.10`, `torch>=2.5.1`, and
`torchvision>=0.20.1`, and shows image inference with `SAM2ImagePredictor(...).set_image(...)`
followed by `predict(...)`. It also supports loading checkpoints from Hugging Face with
`SAM2ImagePredictor.from_pretrained(...)`.

This project's existing `.venv` was created with Python 3.9, so it can keep running the fallback
path, but a true local SAM 2 runtime will need a Python 3.10+ environment plus:

```bash
pip install -r requirements-sam2.txt
```

## API

- `GET /health`
- `GET /api/health`
- `GET /`
- `POST /api/assess`

## Deploy backend to Hugging Face Spaces

Use a `Docker` Space and point it at this repository root.

- HF Space SDK: `Docker`
- App port: `7860`
- Main container entrypoint is already defined in [Dockerfile](/Users/davidle/Documents/Insurance%20damage%20assessment%20tool/Dockerfile)
- Set secrets/variables in the Space:
  - `GEMINI_API_KEY`
  - `GEMINI_MODEL`
  - `SEGMENTATION_PROVIDER`
  - `SAM2_MODEL_ID`
  - `ALLOWED_ORIGINS`
  - `ALLOWED_HOSTS`
  - `APP_ENV`
  - `DEBUG`
  - `ENABLE_API_DOCS`
  - `API_ACCESS_TOKEN` if you are protecting the backend behind a private proxy
- Recommended first SAM 2 model: `facebook/sam2-hiera-tiny`
- Upgrade later if the Space has enough RAM: `facebook/sam2-hiera-small`
- `INSTALL_SAM2=1` is set in the Dockerfile so the Space installs SAM 2 dependencies during build.

The backend health URL will be:

```text
https://<your-space-subdomain>.hf.space/api/health
```

The health response includes the requested segmentation provider, active provider, SAM 2 model id,
and whether the SAM 2 adapter is ready. If SAM 2 cannot load, the API still responds using the
classical fallback so the demo does not hard-crash during cold starts or constrained deployments.

## Deploy frontend to Vercel

Point Vercel at the [frontend](/Users/davidle/Documents/Insurance%20damage%20assessment%20tool/frontend) directory.

- Build command: `node scripts/build.mjs`
- Output directory: `dist`
- Environment variable:
  - `VITE_API_BASE_URL=https://<your-space-subdomain>.hf.space`

## Next steps

- Confirm SAM 2 memory use on the selected Hugging Face Space tier
- Store claim history in a database
- Add side-by-side original image and predicted mask overlays
