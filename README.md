# ResumeGPT (PAG)

ResumeGPT drafts Korean self-introduction essays (자기소개서) with AI, based on
a job posting (JD) and the applicant's own experience.

- **Frontend**: plain HTML/JS with Tailwind CSS (built ahead of time), served by
  Firebase Hosting
- **Backend**: a Cloud Function (`generateEssay`, Seoul region) that calls the
  Gemini API
- **Auth/data**: Firebase Authentication (email/password, Google) and Cloud
  Firestore

```
public/            # static site (index.html, app.js, styles.css ← build output)
src/input.css      # Tailwind input
functions/         # Cloud Functions (Node 22)
  index.js         #   entry point: Gemini call, secrets/params
  handler.js       #   auth, daily limit, save logic
  prompt.js        #   input validation, prompt, response parsing
  test/            #   unit tests (node --test)
firestore.rules    # security rules
firestore.indexes.json  # TTL policy (expireAt)
```

## How it works

1. A signed-in user calls `generateEssay`. Anonymous users are rejected.
2. The function validates the input (required fields, length limits) and
   increments the user's daily counter. The default limit is 20 per day and
   resets at midnight KST.
3. It calls Gemini. The API key lives only in Secret Manager.
4. It saves the result to `users/{uid}/resumes/{id}`. Clients can **only read
   and delete** these documents; writes are server-only.
5. If Google Search grounding is on, the response's Google Search suggestions
   and sources are shown unmodified, as the terms require. The saved document
   is deleted automatically after 2 years via `expireAt` and the TTL policy.

## Pre-deployment checklist

1. **Firebase project.** Create one at <https://console.firebase.google.com>
   and upgrade it to the **Blaze plan**. Cloud Functions and Secret Manager
   require Blaze. Setting a **budget alert** in Google Cloud Billing is also
   recommended.
2. **Authentication.** Under Sign-in method, enable **Email/Password** and
   **Google**. Add your deployment domain under Settings → Authorized domains.
3. **Firestore.** Create the database in Native mode. `asia-northeast3`
   (Seoul) is recommended.
4. **Gemini API key.** Create one in Google AI Studio. On the free tier, inputs
   may be used to improve Google's services. This app sends applicants'
   personal information, so check the [Gemini API terms](https://ai.google.dev/gemini-api/terms)
   and consider using a key with billing enabled.
5. **Install and deploy:**

```bash
npm install -g firebase-tools
npm install && npm --prefix functions install
firebase login
firebase use --add                               # choose your project
firebase functions:secrets:set GEMINI_API_KEY    # paste the key
firebase deploy                                  # Hosting + Functions + rules + TTL
```

`firebase deploy` builds the CSS automatically and runs the function tests
before deploying.

### Settings (`functions/.env`)

| Key | Default | Description |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model to use. Check the [model list](https://ai.google.dev/gemini-api/docs/models) |
| `DAILY_LIMIT` | `20` | Generations per user per day |
| `ENFORCE_APP_CHECK` | `false` | Set to `true` to require App Check (see below) |

### App Check (recommended)

App Check blocks callers that are not your web app.

1. Create a reCAPTCHA Enterprise key.
2. Register the web app under App Check in the Firebase console.
3. Put the site key in `<meta name="recaptcha-site-key">` in `public/index.html`.
4. Set `ENFORCE_APP_CHECK=true` and redeploy.

## Local development

```bash
npm run build:css     # or: npm run watch:css
npm test              # function unit tests
npm run emulators     # Auth/Firestore/Functions/Hosting emulators → http://127.0.0.1:5000
```

When served from localhost, the app connects to the emulators automatically.
The function emulator calls the real Gemini API, so put
`GEMINI_API_KEY=...` in `functions/.secret.local` (this file is in
`.gitignore`).

## Before launching publicly

- A privacy policy page: this app collects email, name, and career information
  and sends them to the Gemini API.
- Terms of service, including a notice that results are AI-generated drafts.
- A budget alert, and a `DAILY_LIMIT` that fits your expected usage.
