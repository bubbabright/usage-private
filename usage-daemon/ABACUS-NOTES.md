# Abacus.ai ChatLLM Provider — Research Findings

## API Endpoint
`POST https://apps.abacus.ai/api/v1/_getCompleteUserInfo`
Body: `{"isDesktop":true}`
Auth: Cookie-based (same browser session)

## Usage Data Available

### Compute Points (primary meter)
```
computePointInfo: {
  updatedAt: "2026-08-21T10:11:19.538519+00:00",
  last24HoursUsage: 125419,
  last7DaysUsage: 173621,
  currMonthAvailPoints: 200000,
  currMonthUsage: 200001,
  freeTierTotal: 200000,
  freeTierExpiresAt: "2026-09-07T09:01:07+00:00"
}
```

### Free Tier Credits
```
freeTierCreditsInfo: {
  total: 200000,
  remaining: 0,
  expiresAt: "2026-09-07T09:01:07+00:00"
}
```

### Account Info
- `billingPlan`: "cc"
- `subscriptionTier`: "free"
- `paymentDone`: false
- `is_free_tier`: true
- `exp`: "chatllm_free_trial"
- `organization.name`: "Daniel Bright's Team"

## Key Observations
1. `currMonthAvailPoints` = 200,000 (monthly credit cap, in milli-credits)
2. `currMonthUsage` = 200,001 (all consumed, in milli-credits)
3. `freeTierTotal` = 200,000 (matches avail, in milli-credits)
4. `freeTierExpiresAt` = 2026-09-07 (free trial end)
5. `last24HoursUsage` = 125,419 (heavy recent usage, in milli-credits)
6. `last7DaysUsage` = 173,621 (in milli-credits)

## Unit Scaling
Raw API values are in **milli-credits** (1000x). The UI shows **credits** (divide by 100):
- 200,000 milli-credits = **2,000 credits** (2K)
- 200,001 milli-credits used = **2,000 credits** used (all consumed)
- 125,419 milli-credits in 24h = **1,254 credits** (heavy usage)

## Tier Info
- **Free Tier**: 2,000 credits total, one-time grant (does not refresh), expires 2026-09-07
- After free tier: upgrade to a paid plan for more credits + full features
- `subscriptionTier`: "free", `billingPlan`: "cc", `is_free_tier`: true
- Credits are for chatting + limited Agent mode

## Design Decisions
- Single window: `compute_points` — show `currMonthUsage / 1000` / `currMonthAvail / 1000` as used
- `pct` = `(currMonthUsage / currMonthAvailPoints) * 100` (same in either unit)
- `unit`: "credits" (displayed as "2,000 / 2,000 credits")
- `used_is_remaining: false` (showing consumed, not remaining)
- Poll interval: 300s (same as other cookie-based providers)
- Auth: cookie-based, like ollama/mistral
- Category: `plan` (it's an AI plan, not a support service)
- `resets_at`: null (free tier credits don't refresh — one-time bucket)
- TODO: for paid tiers, `currMonthAvailPoints` would be higher and likely resets monthly