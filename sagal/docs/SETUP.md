# Setting up Sagal (beginner guide)

You need three accounts. All have a web dashboard; no command line is needed.

| What | Service | Why this one |
|---|---|---|
| Database + private file storage | **Supabase** | One dashboard for both. You can browse your data in a table view. Free to start. |
| Running the app | **Render** | Already used for Bilan. Deploys straight from GitHub. |
| Sign-in codes by email | **Resend** (optional at first) | Free tier. Until it's set up, sign-in codes appear in Render's logs. |

> **Supabase or Cloudflare R2?** Supabase is the friendlier option for a beginner: the database and
> file storage live in the same place, and you only manage one set of settings. R2 is cheaper for very large
> amounts of video (it doesn't charge for downloads). The app works with either, so you can move files to R2
> later by changing five settings.
>
> Prices change; check supabase.com/pricing and render.com/pricing before you start. Supabase's free plan pauses
> projects that have been inactive for a week; the always-on workers keep it active, but if you'd rather not
> worry about it, the Pro plan doesn't pause.

---

## 1. Supabase: database and storage (about 10 minutes)

1. Create a project at **supabase.com** (pick the region closest to Helsinki, e.g. *North EU (Stockholm)*).
   Save the database password somewhere safe.
2. **Database connection string.** Click **Connect** (top of the project) → **Session pooler** → copy the URI.
   Replace `[YOUR-PASSWORD]` with your database password. This is your `DATABASE_URL`.
   *Sagal and Bilan both use this same string, so they share one memory.*
3. **Storage bucket.** Go to **Storage** → **New bucket** → name it `sagal-media` → leave **Public bucket OFF**.
   (Optional: a second private bucket `sagal-voiceovers` keeps your voiceovers completely separate.)
4. **Storage keys.** In **Storage** → **S3 Connection** (under Settings): turn on S3 access, then copy:
   - **Endpoint** → `S3_ENDPOINT` (looks like `https://abcd.storage.supabase.co/storage/v1/s3`)
   - **Region** → `S3_REGION` (e.g. `eu-north-1`)
   - Click **New access key** → copy the **Access key ID** → `S3_ACCESS_KEY_ID` and **Secret access key** → `S3_SECRET_ACCESS_KEY`.
     The secret is shown once; paste it straight into Render (next step).

## 2. Render: run the app (about 10 minutes)

1. In Render, open the existing Blueprint for this repository (or **New → Blueprint** and choose the repo).
   It now includes a service called **sagal**.
2. Fill in the values Render asks for:
   - `OWNER_EMAIL`: your email. Only this address can create the account.
   - `APP_URL`: the app's address, e.g. `https://sagal.onrender.com` (shown at the top of the service page; you
     can fill it in after the first deploy and redeploy).
   - `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` from step 1.4, and `S3_BUCKET` = `sagal-media`.
   - Using two buckets? Add `S3_VOICEOVER_BUCKET` = `sagal-voiceovers`.
3. **Database.** The blueprint points Sagal at the same Render database as Bilan. To use Supabase instead, open
   **both** services (`bilan-knowledge` and `sagal`) → **Environment** → set `DATABASE_URL` to the Supabase string from step 1.2.
4. `SECRETS_MASTER_KEY` is generated for you. **Copy it into your password manager.** It unlocks the API keys you'll
   paste later; if it's lost, you'd have to paste them again.
5. Deploy. When it's live, `https://<your-app>/healthz` shows `{"ok":true}`.

## 3. First sign-in

1. Open the app and choose **Set up Sagal**: enter your email and a password (10+ characters).
2. You'll be asked for a 6-digit code. Until email is set up, find it in Render → **sagal** → **Logs**: look for
   `Subject: 123456 is your Sagal code`.
3. After that, every sign-in is password + emailed code.

## 4. Look around (optional)

On the first Talk screen, **Load the sample week** fills every screen with the prototype's example content. It's
marked "Sample" everywhere, is never published, and **Remove sample content** (bottom of the menu) deletes it.

## 5. Connect services, when you're ready (Memory & settings → Connected accounts)

Everything works without these: anything Sagal can't do herself is handed to you (post by hand, make the
HeyGen video, the Captions edit). Each service in the app has its own step-by-step list. Suggested order:

1. **Claude** (Sagal's thinking). Without it she can't reply. console.anthropic.com → API keys. Press **Test it** after saving.
2. **Email (Resend)**, so codes and alerts reach your inbox. Press **Test it**.
3. **HeyGen** and **Captions**: keys are stored now; automatic sending arrives in the next build.
4. **Instagram + Facebook**, then **LinkedIn**, then **YouTube** and **TikTok**: paste the app ID/secret, add the
   redirect URL shown in the app to the developer app, then press **Connect**.

Keys are encrypted on the server (AES-256-GCM) and never shown again; the app only shows the last four characters.

---

## Running it on your own computer (optional)

Needs Node 22 and Postgres.

```bash
cd sagal
cp .env.example .env           # then fill in SECRETS_MASTER_KEY (npm run gen-key) and OWNER_EMAIL
npm install
npm run dev                    # http://localhost:8080
npm test                       # needs TEST_DATABASE_URL or a local sagal_test database
```
