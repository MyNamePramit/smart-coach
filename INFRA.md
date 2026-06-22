# AI Coach MVP — Cloud Infrastructure Options

## AWS Free Tier (12 months)

| Service | Free Allowance | Enough? |
|---|---|---|
| EC2 t2.micro | 750 hrs/month | ✅ Run the whole app |
| RDS PostgreSQL t3.micro | 750 hrs/month | ✅ Replace SQLite |
| S3 | 5GB + 20K requests | ✅ Audio files |
| CloudFront | 1TB transfer | ✅ |
| Bedrock | ❌ Not free | 💸 Pay per token |
| Transcribe | 60 min/month | ⚠️ Very limited |
| Polly | 5M chars/month | ✅ Generous |

**Verdict:** App hosting is free. LLM (Bedrock) is the only real cost — ~$0.001–0.003 per session with Haiku.

---

## GCP Free Tier (always free, no expiry)

| Service | Free Allowance | Enough? |
|---|---|---|
| Cloud Run | 2M requests/month | ✅ Better than EC2 for this |
| Cloud SQL | ❌ Not free | 💸 ~$7/month minimum |
| Firestore | 1GB storage | ✅ Could replace SQLite |
| Gemini API | Free tier exists | ✅ Limited but works |
| Cloud Storage | 5GB | ✅ |
| Speech-to-Text | 60 min/month | ⚠️ Very limited |
| Text-to-Speech | 1M chars/month | ✅ |

**Verdict:** Cloud Run is excellent for this — scales to zero, free tier is generous. Gemini free tier can replace Bedrock for trials.

---

## Azure Free Tier

| Service | Free Allowance | Expires? | Enough? |
|---|---|---|---|
| App Service B1 (1 vCPU, 1.75GB) | 750 hrs/month | 12 months | ✅ Run FastAPI backend |
| Azure SQL Database S0 | 250GB | 12 months | ✅ Replace SQLite |
| Blob Storage | 5GB LRS | 12 months | ✅ TTS audio files |
| Azure CDN | 15GB outbound | 12 months | ⚠️ Low for heavy audio use |
| Static Web Apps | Unlimited | Always free | ✅ Best free React hosting |
| Azure OpenAI | ❌ Not free | — | 💸 Pay per token |
| Speech-to-Text | 5 hrs/month | Always free | ⚠️ Very limited |
| Text-to-Speech | 500K chars/month | Always free | ✅ Generous |
| Container Apps | 180K vCPU-seconds/month | Always free | ✅ Alternative to App Service |

**Verdict:** Azure Static Web Apps is the best free frontend hosting of the three — no config, git-push deploys, custom domain included. Backend on App Service B1 is solid. Azure OpenAI (which this app already uses) is the cost driver — no free tier, but cheap at GPT-4o-mini pricing (~$0.001–0.002 per session).

---

## Side-by-side Summary

| Concern | AWS | GCP | Azure |
|---|---|---|---|
| **Backend hosting** | EC2 t2.micro (12mo) | Cloud Run (always free) | App Service B1 (12mo) |
| **Frontend hosting** | S3 + CloudFront | Cloud Run or Firebase Hosting | Static Web Apps (always free) |
| **Database** | RDS t3.micro (12mo) | Firestore (always free) | Azure SQL S0 (12mo) |
| **Audio storage** | S3 5GB | Cloud Storage 5GB | Blob Storage 5GB |
| **LLM** | Bedrock (pay) | Gemini (free tier) | Azure OpenAI (pay) |
| **STT (Whisper)** | EC2 self-hosted | Cloud Run self-hosted | App Service self-hosted |
| **TTS** | Polly 5M chars | TTS 1M chars | Cognitive TTS 500K chars |
| **Free tier longevity** | ⚠️ Expires 12mo | ✅ Most services always free | ⚠️ Mix of 12mo + always free |

## Recommendation for a trial project

**Cheapest overall:** GCP — Cloud Run scales to zero (no idle cost), Gemini free tier covers LLM for low volume, no database cost with Firestore.

**Best if you're already on Azure:** Stay on Azure — Static Web Apps for frontend, App Service for backend, and you already have the Azure OpenAI keys wired in. Total cost after 12 months is just Azure OpenAI tokens (~$5–10/month for light usage).

**Best for a team already on AWS:** AWS with Bedrock Haiku. EC2 + RDS cover hosting free for 12 months. Bedrock is cheap enough that a trial with real users costs less than a coffee.
