import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';

const PORT = '3999';
const BASE = `http://localhost:${PORT}`;
let server;

before(async () => {
  // Throwaway key: nothing is sent in these tests, and the key is never used on a real network.
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PRIVATE_KEY: ethers.Wallet.createRandom().privateKey, PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start in time')), 30000);
    server.stdout.on('data', (d) => d.toString().includes('Faucet BSC Testnet') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => reject(new Error(`Server exited early (code ${code})`)));
  });
});

after(() => server?.kill());

test('GET /api/info returns the faucet address and the claim amount', async () => {
  const res = await fetch(`${BASE}/api/info`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.amount, '0.3');
  assert.ok(ethers.isAddress(body.faucetAddress));
});

test('POST /api/claim rejects an invalid address', async () => {
  const res = await fetch(`${BASE}/api/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: 'not-an-address' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/claim refuses the faucet\'s own address or an empty faucet', async () => {
  const info = await (await fetch(`${BASE}/api/info`)).json();
  const res = await fetch(`${BASE}/api/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: info.faucetAddress }),
  });
  // The test faucet has no tBNB, so it answers 503 (empty) or 400 (own address). Both mean no transaction is sent.
  assert.ok([400, 503].includes(res.status));
});
