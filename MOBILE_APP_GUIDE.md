# Completion IQ Mobile App

This project now works as an installable mobile Progressive Web App.

## Use On A Phone

1. Start the backend:

   ```powershell
   python outputs\application-completion-intelligence-platform\backend\server.py
   ```

2. Open the app:

   ```text
   http://127.0.0.1:8000/mobile.html
   ```

   If you are opening it from a real phone on the same Wi-Fi, start the backend like this:

   ```powershell
   $env:HOST='0.0.0.0'
   python outputs\application-completion-intelligence-platform\backend\server.py
   ```

   Then find your laptop IP:

   ```powershell
   ipconfig
   ```

   Open this on the phone, replacing the IP:

   ```text
   http://YOUR-LAPTOP-IP:8000/mobile.html
   ```

3. On Android Chrome, open the browser menu and choose **Install app** or **Add to Home screen**.

4. On iPhone Safari, open Share and choose **Add to Home Screen**.

## Mobile Features Added

- Installable app manifest.
- App icons.
- Service worker for cached app shell.
- Phone-friendly bottom navigation.
- Touch-friendly buttons and inputs.
- Camera-friendly document upload using `capture="environment"`.
- Applicant-level document upload and scan flow.
- Backend sync through SQLite API.

## Production Native App Path

For a real Play Store/App Store build, reuse the backend and rebuild the frontend in:

- React Native / Expo for fastest Android + iOS delivery.
- Flutter if the team prefers Dart and strongly native UI.
- Native Android Kotlin if the first target is branch/RM Android devices only.

The production mobile app should connect to the same APIs:

- `GET /api/state`
- `POST /api/applications`
- `PATCH /api/applications/{id}`
- `POST /api/scan`
- `POST /api/reset`

Add later:

- camera OCR pipeline
- secure login / SSO
- encrypted file upload
- offline queue sync
- push notifications for follow-ups
- device-level biometric lock
