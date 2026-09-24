# Edge Score (R1)

A 0–100 summary of a trading record, computed in **R multiples** so it works for any instrument, account size or currency. Source of truth: `edgeScore()` in [`src/stats.js`](../src/stats.js).

Adapted from LuxAlgo's open, versioned [Edge Score v2](https://github.com/LuxAlgo/trade-journal/blob/main/docs/edge-score.md) (MIT). Their version uses account currency; this one uses R.

## Requirements

At least **5 closed trades with R**. Below that, the score is withheld (`score: null`) because tiny samples produce impressive-looking noise.

## Components

Each component is scaled to 0–100 against a "full marks" threshold, then combined with fixed weights.

| Component | Full marks at | Zero at | Weight |
|---|---|---|---|
| Win rate | 60% | 0% | 15 |
| Profit factor | 3.0 | 0 | 25 |
| Payoff ratio (avg win R / avg loss R) | 2.5 | 0 | 20 |
| Max drawdown (R) | 0R | ≥ 10R | 15 |
| Recovery factor (total R / max drawdown R) | 3 | ≤ 0 | 10 |
| Consistency (share of winning-day R made on the best day) | ≤ 15% | 100% | 15 |

**Score = Σ(component × weight) / Σ weights**, rounded to 2 decimals. Every result carries `version: "R1"`, and any change to thresholds or weights bumps the version.

## Limits

- The thresholds are calibration points, not statistical truths.
- The score measures the **record**, not the future. A 90 on 6 trades means less than a 65 on 300, which is why the trade count is always shown next to it.
- R depends on honest stop placement. Moving stops after entry distorts it.
