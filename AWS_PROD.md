# AI Coach MVP — Production AWS Architecture

> Assumes: AWS Enterprise Support, cost not a constraint, team familiar with AWS.

---

## Architecture Overview

```
Users
  │
  ▼
Route 53 (DNS + health routing)
  │
  ▼
CloudFront (CDN + WAF)
  ├── /api/* → ALB → ECS Fargate (FastAPI)
  └── /*     → S3  (React SPA)
                      │
            ┌─────────┼──────────────┐
            ▼         ▼              ▼
      Aurora PG    S3 (audio)    Bedrock
      Serverless   + lifecycle   (Claude)
      v2 Multi-AZ  policy
            │
      ElastiCache
      (Redis session
       cache)
```

---

## Service Breakdown

### Networking

| Component | Service | Why |
|---|---|---|
| DNS | Route 53 | Latency-based routing, health checks, failover |
| CDN | CloudFront | Global edge, API + static assets in one distribution |
| WAF | AWS WAF on CloudFront | Rate limiting, OWASP Top 10, bot protection |
| Load balancer | ALB (Application Load Balancer) | HTTP/2, path routing, WebSocket support for SSE |
| VPC | 3-AZ VPC | Public subnets (ALB), private subnets (ECS, DB) |
| NAT | NAT Gateway (per AZ) | Outbound internet from private subnets |
| VPC Endpoints | S3, Bedrock, Secrets Manager | Keep traffic off public internet |

### Compute

| Component | Service | Spec | Why |
|---|---|---|---|
| FastAPI backend | ECS Fargate | 2 vCPU / 4GB per task | No servers to manage, scales per request |
| Whisper STT | ECS Fargate (separate service) | 4 vCPU / 8GB (CPU inference) | Isolated scaling — STT load ≠ API load |
| Kokoro TTS | ECS Fargate (sidecar or separate) | 2 vCPU / 4GB | Same isolation reason |
| Auto Scaling | ECS Service Auto Scaling | Target tracking on CPU + ALB request count | Scales out under load, in at night |

> **GPU option:** If Whisper `tiny` isn't fast enough at scale, move STT to a `g4dn.xlarge` EC2 with Graviton or keep ECS Fargate with `FARGATE_SPOT` for cost resilience.

### Database

| Component | Service | Config | Why |
|---|---|---|---|
| Primary DB | Aurora PostgreSQL Serverless v2 | Min 0.5 ACU, Max 16 ACU, Multi-AZ | Auto-scales compute, no idle cost, HA built-in |
| Cache | ElastiCache (Redis) | cache.t4g.small, 2 replicas | Session metadata, scenario cache, rate limiting |
| Migrations | Flyway via CodeBuild step | — | Versioned schema changes in CI/CD |

> Replace SQLite + `session_meta_*.json` files with Aurora. Session metadata moves into a `session_metadata` JSONB column or normalized tables. Audio file paths stored as S3 URIs.

### Storage

| Component | Service | Config |
|---|---|---|
| TTS audio files | S3 | Lifecycle: expire after 7 days |
| React SPA | S3 | Versioned, CloudFront origin |
| Model weights (Whisper, Kokoro, SentenceTransformer) | S3 | Pulled into ECS task on startup via init container |
| Session exports / reports | S3 | Long-term retention, SSE-S3 encryption |

### AI / ML

| Component | Service | Notes |
|---|---|---|
| LLM (conversation + judging) | Amazon Bedrock — Claude 3.5 Sonnet | Already on AWS, no key management overhead. Sonnet for quality, Haiku for judge calls. |
| STT | Self-hosted Whisper `tiny` on ECS | Amazon Transcribe Streaming is an alternative if you want fully managed |
| TTS | Self-hosted Kokoro on ECS | Amazon Polly Neural is the managed alternative |
| Embeddings | Self-hosted `all-MiniLM-L6-v2` on ECS | Stays in-process with the API — no separate service needed |

### Auth

| Component | Service | Notes |
|---|---|---|
| User auth | Amazon Cognito User Pool | SSO/SAML if org uses Okta/Azure AD — Cognito supports SAML federation |
| API auth | JWT (Cognito tokens) validated in FastAPI | Replace open endpoints with `Depends(verify_token)` |
| Machine-to-machine | IAM roles for ECS tasks | No hardcoded credentials anywhere |

### Security

| Layer | Control |
|---|---|
| Secrets | AWS Secrets Manager (OpenAI keys, DB password) — injected as env vars at ECS task start |
| Encryption at rest | KMS-managed keys for RDS, S3, ElastiCache |
| Encryption in transit | TLS everywhere — ALB terminates, internal traffic within VPC |
| WAF rules | AWS Managed Rules (OWASP), rate limit 100 req/min per IP |
| Network | ECS tasks in private subnets — no public IPs. Only ALB is public-facing. |
| Audit | CloudTrail for all API calls, S3 access logs |

### Observability

| Component | Service |
|---|---|
| Logs | CloudWatch Logs — structured JSON from FastAPI |
| Metrics | CloudWatch Metrics + custom metrics (session count, STT latency, LLM latency) |
| Tracing | AWS X-Ray — end-to-end trace per request through ALB → ECS → Bedrock |
| Dashboards | CloudWatch Dashboard |
| Alerts | CloudWatch Alarms → SNS → PagerDuty / Slack |
| Uptime | Route 53 health checks + CloudWatch Synthetics (canary) |

### CI/CD

```
GitHub (main branch push)
  │
  ▼
GitHub Actions
  ├── Run tests
  ├── Build Docker images
  ├── Push to ECR (Elastic Container Registry)
  └── Deploy to ECS via `aws ecs update-service --force-new-deployment`
       ├── FastAPI service
       ├── Whisper service
       └── Kokoro service

Frontend:
  └── Build React → sync to S3 → CloudFront invalidation
```

---

## Scaling Model

| Users (concurrent) | ECS Tasks (FastAPI) | Aurora ACU | Notes |
|---|---|---|---|
| 1–10 | 1 task | 0.5 ACU | Dev / trial |
| 10–100 | 2–4 tasks | 2–4 ACU | Early production |
| 100–500 | 4–10 tasks | 4–8 ACU | Growth stage |
| 500–1000 | 10–20 tasks | 8–16 ACU | Scale |
| 1M users | Multi-region, SQS queue for STT/TTS jobs, Bedrock on-demand throughput reservation | — | Separate architecture discussion |

---

## 100K MAU Architecture

At 100K monthly active users, assumptions:
- ~5K peak concurrent sessions (5% of MAU, aggressive peak)
- ~30 min average session
- ~10 API calls per session (messages + STT + TTS)
- ~500K sessions/month total

### What changes at this scale

**Compute — async job queues replace synchronous STT/TTS**

At 5K concurrent sessions, synchronous STT and TTS inside the API request becomes the bottleneck. Move them to async workers:

```
API request (FastAPI)
  │
  ├── STT job → SQS → Whisper Worker Fleet (ECS, Auto Scaling)
  │                        └── result → ElastiCache (Redis pub/sub)
  │                                          └── SSE stream picks it up
  └── TTS job → SQS → Kokoro Worker Fleet (ECS, Auto Scaling)
                           └── audio → S3 → pre-signed URL in SSE event
```

**LLM — Bedrock Provisioned Throughput**

At this volume, on-demand Bedrock will throttle. Purchase Provisioned Throughput units for Claude 3.5 Haiku (judge calls) and Sonnet (conversation). This also gives predictable latency under load.

**Database — Aurora Global + Read Replicas**

- 1 writer + 2 read replicas in primary region
- Aurora Global Database if you expand to a second region
- Connection pooling via RDS Proxy (ECS tasks open/close connections rapidly — RDS Proxy prevents connection exhaustion)

**Multi-region (optional at 100K, required beyond)**

| Region | Role |
|---|---|
| us-east-1 | Primary — writes, Bedrock |
| eu-west-1 | Read replica + regional API for EU users (latency + GDPR) |

Route 53 latency-based routing sends users to nearest region.

### Updated Service Sizing

| Service | Config | Count |
|---|---|---|
| ECS FastAPI tasks | 4 vCPU / 8GB | 20–40 (auto-scaled) |
| ECS Whisper workers | 4 vCPU / 8GB | 10–20 (queue-depth scaled) |
| ECS Kokoro workers | 2 vCPU / 4GB | 10–20 (queue-depth scaled) |
| Aurora writer | r6g.2xlarge | 1 |
| Aurora read replicas | r6g.xlarge | 2 |
| RDS Proxy | — | 1 per AZ |
| ElastiCache (Redis) | r6g.large cluster mode | 3-node |
| SQS queues | STT queue + TTS queue | Standard queues |
| ALB | — | 1 (multi-AZ) |
| CloudFront | — | Global |

### Cost Estimate at 100K MAU

| Service | Est. Monthly Cost |
|---|---|
| ECS Fargate — API (30 tasks avg) | ~$900 |
| ECS Fargate — Whisper workers (15 tasks avg) | ~$700 |
| ECS Fargate — Kokoro workers (15 tasks avg) | ~$450 |
| Aurora PostgreSQL (writer + 2 replicas) | ~$800 |
| RDS Proxy | ~$100 |
| ElastiCache r6g.large (3-node) | ~$300 |
| SQS (500M requests) | ~$200 |
| ALB | ~$50 |
| CloudFront (estimated traffic) | ~$150 |
| S3 (audio + assets) | ~$80 |
| Bedrock Provisioned Throughput (Haiku) | ~$1,200 |
| Bedrock on-demand (Sonnet, conversation) | ~$800 |
| NAT Gateway (3 AZ) | ~$150 |
| WAF | ~$50 |
| CloudWatch / X-Ray / CloudTrail | ~$100 |
| Route 53 | ~$20 |
| **Total** | **~$6,050/month** |

~$0.012 per session at 500K sessions/month. Bedrock is ~35% of the bill — the dominant cost, same as at any scale.

---

## Migration Path from Current Docker Compose

1. **Week 1** — Containerise properly: split into 3 Dockerfiles (api, whisper, kokoro). Push to ECR.
2. **Week 2** — Provision VPC, Aurora, ElastiCache via Terraform/CDK. Migrate SQLite → Aurora. Replace `session_meta_*.json` with DB.
3. **Week 3** — ECS Fargate services + ALB. Point CloudFront at ALB for `/api/*` and S3 for `/*`. Wire Secrets Manager.
4. **Week 4** — Cognito auth, WAF rules, CloudWatch dashboards, X-Ray tracing.
5. **Week 5** — Load test, tune auto-scaling policies, set CloudWatch alarms, cut over DNS.

---

## Cost Estimate (100 concurrent users, ~1000 sessions/day)

| Service | Est. Monthly Cost |
|---|---|
| ECS Fargate (4 tasks × 2vCPU/4GB) | ~$120 |
| Aurora Serverless v2 (avg 2 ACU) | ~$70 |
| ElastiCache t4g.small | ~$25 |
| ALB | ~$20 |
| CloudFront + S3 | ~$15 |
| Bedrock Claude 3.5 Sonnet (1000 sessions) | ~$30–80 |
| Bedrock Claude Haiku (LLM judge, 1000 sessions) | ~$5 |
| NAT Gateway | ~$35 |
| WAF | ~$20 |
| CloudWatch + X-Ray | ~$15 |
| **Total** | **~$355–405/month** |

Drops significantly if you use `FARGATE_SPOT` for Whisper/Kokoro tasks (up to 70% cheaper) and Aurora scales down during off-hours.
