# StockBasis

Cost basis, P&L and tax-ready reports for tokenized equities on Solana.

Paste a wallet address → get a brokerage-style statement of your tokenized-stock
activity: every trade, average cost per lot, realized P&L, and a CSV export you
can hand to an accountant.

## Why

Tokenized stocks trade 24/7 on Solana — hundreds of small swaps per active month,
and no brokerage statement at the end of the year. Every holder hits this problem
personally. This tool reads on-chain history (read-only, no keys, no approvals)
and turns it into a report a human can use.

## Live demo

**https://stockbasis.tail88c821.ts.net** — paste a wallet, get the report.

## Usage

Web UI (recommended):

```
npm run serve            # → http://localhost:8787
```

Paste a wallet address, hit Scan. The server walks the wallet's recent on-chain
history (default: newest 250 transactions, `INGEST_MAX_TX` to change), classifies
tokenized-equity mints via Jupiter token tags, computes FIFO cost basis and
renders the report with a CSV export.

CLI:

```
node src/cli.mjs report  <address>    # terminal report
node src/cli.mjs csv     <address>    # stockbasis-<address>.csv
node src/cli.mjs scan    <address>    # debug: which equity tokens did the wallet touch
```

Env: `SOLANA_RPC` — comma-separated list of RPC endpoints (fallback rotation);
`INGEST_MAX_SCAN_TX`, `INGEST_TARGET_TRADES`, `INGEST_CONCURRENCY`, `PORT`. Zero npm
dependencies, Node ≥ 24.

## Status

Working end to end on mainnet: history scan, stock classification, FIFO P&L, CSV.
Known simplification: WSOL cash legs are valued at the current SOL price rather
than the price at trade time.

## License

MIT
