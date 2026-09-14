# solana-grid-bot

A grid-trading bot for a single Solana token, trading against real Jupiter
prices. It rests buy orders below the current price and sell orders above
it across a fixed range, profiting from price oscillating inside that range.

Paper mode simulates fills from real Jupiter quotes without ever touching a
wallet. Live mode places real resting orders through Jupiter's Trigger API —
funds move into a Jupiter-managed vault the moment an order is placed, not
only once it fills.

## Disclaimer

**This is experimental, unaudited software that can place real orders with
real money. Use it entirely at your own risk.**

- Not financial advice. Grid trading does not guarantee profit — it can
  lose money, including your full deposited balance, especially if price
  trends straight through the configured range instead of oscillating
  inside it.
- Provided "as is", with no warranty of any kind. There is no guarantee
  this code is free of bugs, including bugs that could cause unintended
  trades, stuck orders, or fund loss.
- Large parts of this codebase are a reconstruction after the original
  project was accidentally deleted (see "Origin" below) — some files are
  verbatim recoveries, others are faithful reimplementations that have
  **not** been exercised in live trading as extensively as the original.
  Read a file's own header comment before trusting it with real funds.
- You are solely responsible for any funds you configure this bot to
  trade, for the wallet key you provide it, and for verifying its behavior
  (start in paper mode, and with a small budget in live mode) before
  trusting it further.
- The author(s) and any contributors accept no liability for financial
  losses, security incidents, or other damages arising from the use of
  this software.

## Origin

This rebuilds the grid module of an earlier project (`solana-scalpe-bot-alpha`)
after that directory was accidentally deleted. Some files were recovered
verbatim from a still-open conversation transcript; the rest are a faithful
reimplementation of the same observed behavior, not a byte-exact recovery.
See each file's own comments for specifics — `engine.ts`, `liveBroker.ts`,
`broker.ts`, `feeds/jupiterTrigger.ts`, and the grid section of `config.ts`
are exact; everything else was rewritten to match.

`liveBroker.ts` carries two fixes found in the original project the day
before it was deleted:

- Every placed order now sends an explicit `slippageBps` (`GRID_SLIPPAGE_BPS`,
  default 100). Omitting it left Jupiter's own default in effect, which is
  the likely cause of a real incident where a correctly-triggered order
  failed 10 straight fill attempts and got stuck open at 0% filled.
- `checkFill` now queries order history with `orderStatus=open` instead of
  an unfiltered page 1. Without it, an old resting order could fall off the
  page as the account's order history grew and become permanently
  undetectable as filled.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` directly (never paste secrets into chat) and set:

- `WALLET_PRIVATE_KEY` — base58-encoded 64-byte secret key. Required for
  live mode only.
- `JUP_API_KEY` — required for live mode (Jupiter's Trigger API needs a
  registered account; the keyless tier doesn't cover it).
- `RPC_URL` — defaults to the public mainnet-beta RPC if unset.
- The `GRID_*` values for the asset, price range, level count/size, and
  budget. See `.env.example` for the current defaults (SKR, $0.016–$0.021,
  4 levels, $10/level, $40 budget).

## Running

```bash
npm run grid       # paper mode by default (GRID_LIVE unset or false)
```

Set `GRID_LIVE=true` to trade for real. This requires an interactive
terminal — you'll be asked to type `I ACCEPT REAL FUND RISK` to proceed, and
there is no way to skip that from a script or environment variable.

Live mode also enforces hard ceilings that are **not** read from `.env`
(edit `src/config.ts` directly to raise them):

- `GRID_LIVE_MAX_BUDGET_USD` — 150
- `GRID_LIVE_MAX_RESTING_ORDERS` — 10
- `GRID_LIVE_MAX_DRAWDOWN_USD` — 45 (permanent halt on unrealized loss
  across open inventory; existing resting sells still close out normally,
  but no new buy exposure is added until a human restarts)

## Data

Journal files (`grid_events.jsonl`, `grid_fills.jsonl`, `open_grid.json`)
are written to `DATA_DIR` (default `data`). The ladder state in
`open_grid.json` is what the bot resumes from on restart — if it doesn't
match what's actually resting on Jupiter (e.g. after restoring this project
from a backup, or switching data directories), reconcile against Jupiter's
real order state before restarting live, to avoid placing duplicate orders
at levels that are already live.

## Typecheck / smoke test

```bash
npm run typecheck
```

There's no automated test suite yet — the rebuild was verified with a short
live paper-mode run against real Jupiter prices (placed orders, persisted
the ladder, resumed correctly, shut down cleanly on SIGTERM).
