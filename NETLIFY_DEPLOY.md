# Netlify Deployment Notes - Banker Support

Use these files for the existing Netlify project named `banker support`.

Netlify should host the frontend. The Python OCR/API backend must run separately on Render, Railway, Fly, or a VPS.

## Required Netlify Setting

In the existing `banker support` Netlify project, set this environment variable:

```text
BACKEND_URL=https://your-backend-domain.com
```

Do not include `/api` at the end. Example:

```text
BACKEND_URL=https://completion-iq-api.onrender.com
```

## How It Works

- Browser calls `/api/...` on the Netlify site.
- Netlify redirects `/api/*` to `netlify/functions/api-proxy.mjs`.
- The function forwards the request to `BACKEND_URL/api/...`.
- The backend keeps SQLite, OCR, validation flags, address matching, and workflow actions.

## Netlify Build

This repo includes:

```text
netlify.toml
scripts/build-netlify.mjs
netlify/functions/api-proxy.mjs
```

Netlify build command:

```text
node scripts/build-netlify.mjs
```

Publish directory:

```text
netlify-publish
```

## Updating Existing Site

In Netlify:

1. Open the existing `banker support` site.
2. Go to Deploys.
3. Upload the updated source/package or trigger a Git redeploy from this folder.
4. Do not create a new Netlify site.
5. Confirm `BACKEND_URL` is set before testing scan/upload/dashboard actions.

## Payload Capacity

Recommended upload limit for the demo:

```text
4 MB per document
```

Reason:

- Netlify Functions have a small request payload ceiling.
- Image/PDF uploads are sent as base64 JSON, which increases size by about 33%.
- A 4 MB file becomes roughly a 5.3 MB JSON request.

Backend/proxy guard:

```text
Default backend JSON request cap: 5 MB
Optional Netlify override: MAX_PAYLOAD_BYTES=5242880
```

OCR worker capacity:

```text
Default OCR workers: 32
Estimated image OCR capacity: 64-128 documents/minute on adequate backend hardware
Regional scale: COMPLETION_IQ_OCR_WORKERS=64 for 128-256 documents/minute
Enterprise scale: queue-backed OCR worker fleet for 500-2000+ documents/minute
```

Adaptive scaling check:

```text
/api/capacity?uploadsPerMinute=300
```

Enterprise security controls:

```text
COMPLETION_IQ_ALLOWED_ORIGIN=https://your-netlify-site.netlify.app
COMPLETION_IQ_API_KEY=<staff-api-key-for-protected-api-routes>
```

Cross verification now checks:

```text
Applicant name
PAN
Aadhaar
Address
Duplicate identity
Required document set
```

## Important

If `BACKEND_URL` is not set, the frontend will open but API actions like scan, dashboard, customer upload, and workflow buttons will return a backend configuration error.
