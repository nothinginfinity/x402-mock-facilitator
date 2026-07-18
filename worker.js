// x402-mock-facilitator
//
// A TEST-ONLY x402 facilitator. It implements /verify with a REAL
// EIP-712 signature recovery check (the same cryptographic step a real
// facilitator does), and /settle with a FAKE transaction hash — no RPC
// provider, no gas, no real chain interaction, no funds move anywhere.
//
// Purpose: let you rehearse the full sign -> verify -> settle loop
// against x402-sub-agent-mcp before wiring up real testnet USDC (or
// mainnet). The message format matches the real EIP-3009
// TransferWithAuthorization structure real USDC uses, so switching this
// out for x402.org/facilitator or Coinbase's CDP facilitator later is a
// one-line change (facilitator_url) — nothing about your signing code
// needs to change.
//
// NEVER point real payment_rules at this in production. It will happily
// "settle" any structurally-valid signature with a fake tx hash.

import { verifyTypedData } from 'viem';

const VERSION = '0.1.0';
const WORKER = 'x402-mock-facilitator';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function j(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

// Canonical EIP-3009 TransferWithAuthorization shape — the same one real
// USDC (and most x402-compatible stablecoins) use. Keeping this exact
// means a payload signed for this mock facilitator only needs its
// `domain` swapped (name/version/chainId/verifyingContract) to become a
// real payment against real USDC.
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

function badRequest(reason) {
  return { isValid: false, invalidReason: reason };
}

async function recoverAndCheck(paymentPayload, paymentRequirements) {
  if (!paymentPayload || paymentPayload.scheme !== 'exact') return badRequest('unsupported scheme, mock facilitator only implements exact');
  const payload = paymentPayload.payload;
  const auth = payload && payload.authorization;
  const signature = payload && payload.signature;
  if (!auth || !signature) return badRequest('payload.authorization and payload.signature are required');

  const domain = {
    name: paymentRequirements.extra && paymentRequirements.extra.eip712Name || 'Mock USD',
    version: paymentRequirements.extra && paymentRequirements.extra.eip712Version || '2',
    chainId: paymentRequirements.extra && paymentRequirements.extra.chainId || 84532, // Base Sepolia
    verifyingContract: paymentRequirements.asset
  };

  let valid;
  try {
    valid = await verifyTypedData({
      address: auth.from,
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce
      },
      signature
    });
  } catch (e) {
    return badRequest('signature recovery failed: ' + String(e.message || e));
  }
  if (!valid) return badRequest('signature does not recover to authorization.from');

  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validAfter) > now) return badRequest('authorization not yet valid (validAfter in the future)');
  if (Number(auth.validBefore) < now) return badRequest('authorization expired (validBefore in the past)');
  if (auth.to.toLowerCase() !== String(paymentRequirements.payTo).toLowerCase()) return badRequest('authorization.to does not match paymentRequirements.payTo');
  if (BigInt(auth.value) < BigInt(paymentRequirements.maxAmountRequired)) return badRequest('authorization.value is less than maxAmountRequired');
  if (paymentPayload.network !== paymentRequirements.network) return badRequest('network mismatch between payload and requirements');

  return { isValid: true, payer: auth.from };
}

async function handleVerify(req) {
  const body = await readJson(req);
  if (!body.paymentPayload || !body.paymentRequirements) {
    return j({ isValid: false, invalidReason: 'paymentPayload and paymentRequirements are both required' });
  }
  const result = await recoverAndCheck(body.paymentPayload, body.paymentRequirements);
  return j(result);
}

async function handleSettle(req) {
  const body = await readJson(req);
  if (!body.paymentPayload || !body.paymentRequirements) {
    return j({ success: false, error: 'paymentPayload and paymentRequirements are both required', txHash: null, networkId: null });
  }
  const check = await recoverAndCheck(body.paymentPayload, body.paymentRequirements);
  if (!check.isValid) {
    return j({ success: false, error: check.invalidReason, txHash: null, networkId: body.paymentPayload.network || null });
  }
  // No real chain interaction. Fake tx hash, clearly tagged.
  const fakeTxHash = '0xMOCK' + crypto.randomUUID().replace(/-/g, '');
  return j({ success: true, error: null, txHash: fakeTxHash, networkId: body.paymentPayload.network, payer: check.payer, note: 'MOCK SETTLEMENT — no real chain transaction was submitted' });
}

function status() {
  return {
    ok: true,
    worker: WORKER,
    version: VERSION,
    mode: 'MOCK_FACILITATOR_TEST_ONLY',
    warning: 'This facilitator performs real EIP-712 signature checks but fake settlement. Never point production payment rules at it.',
    supported: [{ scheme: 'exact', network: 'base-sepolia' }, { scheme: 'exact', network: 'base' }]
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/' || url.pathname === '/status' || url.pathname === '/health') return j(status());
      if (url.pathname === '/supported') return j({ kinds: status().supported });
      if (req.method === 'POST' && url.pathname === '/verify') return handleVerify(req);
      if (req.method === 'POST' && url.pathname === '/settle') return handleSettle(req);
      return j({ ok: false, error: 'not_found', worker: WORKER }, 404);
    } catch (e) {
      return j({ ok: false, error: String(e.message || e), worker: WORKER }, 500);
    }
  }
};
