# x402-mock-facilitator

**TEST-ONLY.** A minimal x402 facilitator that performs real EIP-712
signature recovery (`viem`'s `verifyTypedData`) against a
`TransferWithAuthorization` payload — the exact structure real USDC and
most x402-compatible stablecoins use — but never touches a blockchain.
`/settle` returns a fake `0xMOCK...` transaction hash instead of
broadcasting anything.

## Why this exists

To rehearse the full x402 flow (sign → `/verify` → `/settle`) against
`x402-sub-agent-mcp` without needing testnet ETH for gas, a funded
faucet wallet, or a deployed token contract. Because the signed message
format is identical to real EIP-3009, switching to a real facilitator
later is just changing `facilitator_url` — no changes to how you sign.

## Endpoints

- `GET /status` — health check
- `GET /supported` — `{ kinds: [{scheme:'exact', network:'base-sepolia'}, ...] }`
- `POST /verify` — real signature check, no chain call
- `POST /settle` — same check, then a fake tx hash

## What "real" means here vs. what's faked

| Step | Real? |
|---|---|
| EIP-712 domain/type hashing | ✅ real (`viem`) |
| ECDSA signature recovery | ✅ real |
| `validAfter`/`validBefore` window check | ✅ real |
| `payTo`/`value`/`network` match against requirements | ✅ real |
| On-chain balance/allowance check | ❌ not checked — this is the big one |
| Actual token transfer | ❌ never happens |
| `txHash` | ❌ fake, prefixed `0xMOCK` |

That means: a signature from a wallet with **zero balance** will still
pass `/verify` and `/settle` here. That's expected — it's testing the
x402 plumbing (rule matching, 402 challenge, header round-trip,
verify/settle proxying, usage logging), not token custody. Swap in a
real facilitator before trusting any of that with real value.

## Deploy

Same iPhone-friendly push-to-deploy pattern as `x402-sub-agent-mcp`:
add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repo secrets,
then push to `main` or run the workflow manually from the Actions tab.
No D1, no other bindings — this worker is stateless.
