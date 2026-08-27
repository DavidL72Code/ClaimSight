---
title: ClaimSight Backend
sdk: docker
app_port: 7860
pinned: false
---

# Insurance Damage Assessment Tool

An MVP for insurance claim triage that combines image segmentation, market-grounded valuation, and multimodal report generation.

## Problem

Insurance claims teams often have to make early decisions from incomplete information:

- Damage severity is judged from a small set of photos.
- Vehicle value can be misestimated when adjusters do not have fast access to comparable market listings.
- Intake details like year, mileage, trim, and prior damage are often partial or inconsistent.
- Human adjusters still need a short, defensible explanation for why a claim may be repairable or headed toward total loss review.

This project is meant to reduce that early triage friction by giving a structured first-pass assessment from photos plus whatever vehicle details the claimant can provide.

## What We Built To Combat It

ClaimSight turns vehicle photos and intake details into an adjuster-facing assessment:

- Upload a vehicle damage image
- Detect damage regions with Gemini's multimodal grounding, falling back to a classical CV detector if the model is unavailable
- Detect damage regions and estimate repair exposure
- Blend claimant-provided information such as year, mileage, trim, and prior damage with AI-detected vehicle identity
- Ground vehicle valuation against comparable market listings instead of relying on a freeform guess
- Produce a structured claim summary with valuation evidence, pricing factors, and total-loss reasoning
- Display the assessment in a simple web UI for quick review

## Technology Used

- `backend`: FastAPI app intended for Hugging Face Spaces using Docker
- `frontend/`: static app intended for Vercel
- FastAPI
- Jinja2 templates
- Vanilla HTML/CSS/JS
- Gemini structured-output vision for damage-region detection, with a classical OpenCV-style fallback detector
- Optional MobileSAM (ONNX, CPU) mask refiner, off by default (`ENABLE_SAM2_ONNX`)
- Gemini for multimodal damage understanding and narrative report generation
- Tavily / Google Search grounding for comparable market research and vehicle valuation support

## Security

- Uploads are limited by extension, declared MIME type, decoded image format, byte size, and pixel count.
- Pillow image verification rejects spoofed files and decompression-bomb-style oversized images.
- `/api/assess` and `/api/claim-assistant` require a verified Firebase ID token and rate-limit by Firebase UID.
- Legacy case and queue APIs require the Firebase `employee`, `manager`, or `admin` custom role.
- Firestore and Storage rules enforce claim ownership, assigned-agent access, upload limits, and protected workflow fields.
- Production defaults disable debug mode and API docs.
- CORS and trusted host rules restrict which frontends and hosts can call the backend.
- Trusted host checks are controlled with `ALLOWED_HOSTS`.
- Security headers are set on both the FastAPI backend and Vercel frontend.
- Health checks expose whether the segmentation provider failed to load without returning raw exception text.
- Frontend assessment rows are rendered with DOM text nodes instead of HTML interpolation.
- Gemini is prompted to treat image text and filenames as untrusted evidence, not instructions.
- See [SECURITY.md](/Users/davidle/Documents/Insurance%20damage%20assessment%20tool/SECURITY.md) for the checklist mapping.

## Deployment

- Backend deployed to Hugging Face Spaces with Docker using [Dockerfile](/Users/davidle/Documents/Insurance%20damage%20assessment%20tool/Dockerfile).
- Frontend deployed separately to Vercel and pointed at the Hugging Face backend.
- Core backend variables: `GEMINI_API_KEY`, `SEGMENTATION_PROVIDER` (`gemini` by default), `ALLOWED_ORIGINS`, `ALLOWED_HOSTS`, and one of
  `FIREBASE_SERVICE_ACCOUNT_JSON` / `FIREBASE_SERVICE_ACCOUNT_PATH` / `GOOGLE_APPLICATION_CREDENTIALS`.
- Without Firebase Admin credentials the backend still boots, but `/api/assess` and `/api/claim-assistant`
  reject every request with `401` — verify `/api/health` and a signed-in assessment after deploying.
- Core frontend build variables: `VITE_API_BASE_URL` plus the six `VITE_FIREBASE_*` values. The Vercel build
  fails fast if any are missing, so a misconfigured project never publishes a blank-config site.
- See [.env.example](.env.example) for the full annotated list.

### Required Firebase Security Deployment

1. Assign custom claims through a trusted Firebase Admin environment: customers use `role=customer`; adjusters use `role=employee`; supervisors use `role=manager` or `role=admin`.
2. Deploy `firebase/firestore.rules`, `firebase/storage.rules`, and `firebase/firestore.indexes.json` before enabling real claim traffic.
3. Run `python firebase/migrate_internal_notes.py` as a dry run, then rerun with `--apply` to move legacy internal notes out of customer-readable claim documents.
4. Configure `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_SERVICE_ACCOUNT_PATH`, or `GOOGLE_APPLICATION_CREDENTIALS` on the backend so ID tokens can be verified.
5. Do not deploy with blank Firebase frontend configuration. The employee preview login bypass is limited to localhost and `file://` development pages.
