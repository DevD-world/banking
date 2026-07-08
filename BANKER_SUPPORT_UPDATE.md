# Banker Support Netlify Update

This package is meant for the existing Netlify site named `banker support`.

It includes:

- Latest mobile app build with address matching.
- Netlify API proxy for `/api/*`.
- Customer upload portal support.
- Manager dashboard support.
- PWA cache update.
- Upload payload guard: 4 MB per document, with clean error handling.
- Capacity endpoint: `/api/capacity` with active requests, requests/minute, OCR workers, and harness details.
- Image orientation/scaling detection for uploaded documents.
- Increased default OCR worker pool to 32, with estimated OCR capacity of 64-128 documents/minute on adequate backend hardware.
- Added bank capacity profiles: branch pilot, regional rollout, and enterprise queue-backed OCR fleet.
- Adaptive scaling: `/api/capacity?uploadsPerMinute=300` recommends OCR workers and queue strategy based on upload volume.
- Enterprise security: security headers, restricted CORS support, optional staff API key, upload guard, and audit trail posture.
- Strong cross verification: applicant name, PAN, Aadhaar, address, duplicate identity, and required document-set checks on every scan.

After deployment, open:

```text
/mobile.html?v=20260610-netlify-address-match
```

Required Netlify environment variable:

```text
BACKEND_URL=https://your-backend-domain.com
```

Use the existing `banker support` project in Netlify. Do not create a new project.
