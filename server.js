import express from 'express';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Safety constants (deliberately NOT configurable through .env) ----
const AMOUNT = '0.3';            // max tBNB per request
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 claim per 24 h per address and per IP
const CHAIN_ID = 97;             // BSC Testnet only
const MAINNET_CHAIN_ID = 56;     // BSC Mainnet, read-only: used to check the requester's balance
const MIN_MAINNET_BNB = '0.002'; // the requester must hold at least this much real BNB
const CLAIMS_FILE = path.join(__dirname, 'data', 'claims.json');

// ---- Config from .env ----
const {
  PRIVATE_KEY,
  RPC_URL = 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  MAINNET_RPC_URL = 'https://bsc-dataseed.bnbchain.org',
  PORT = '3000',
  TRUST_PROXY,
} = process.env;
if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY is missing (see .env.example)');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
// Mainnet: never used to send, only to read the requester's balance
const mainnet = new ethers.JsonRpcProvider(MAINNET_RPC_URL);

// Safeguard: refuse to start if the RPC is not BSC Testnet (avoids sending real BNB)
const network = await provider.getNetwork();
if (network.chainId !== BigInt(CHAIN_ID)) {
  console.error(`Wrong network (chainId ${network.chainId}), expected ${CHAIN_ID} (BSC Testnet).`);
  process.exit(1);
}

const mainnetNetwork = await mainnet.getNetwork();
if (mainnetNetwork.chainId !== BigInt(MAINNET_CHAIN_ID)) {
  console.error(`MAINNET_RPC_URL points to the wrong network (chainId ${mainnetNetwork.chainId}), expected ${MAINNET_CHAIN_ID} (BSC Mainnet).`);
  process.exit(1);
}

// ---- Claim storage (max 0.3 tBNB per address AND per IP every 24 h) ----
fs.mkdirSync(path.dirname(CLAIMS_FILE), { recursive: true });
let claims = { addresses: {}, ips: {} };
if (fs.existsSync(CLAIMS_FILE)) claims = JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8'));
const save = () => {
  const tmp = CLAIMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(claims, null, 2));
  fs.renameSync(tmp, CLAIMS_FILE);
};

// Time left (ms) before a record expires (0 if free)
const remaining = (rec) => (rec?.date ? Math.max(0, Date.parse(rec.date) + COOLDOWN_MS - Date.now()) : 0);

// Queue: handles one request at a time (no race condition, clean nonce)
let queue = Promise.resolve();
const enqueue = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

const app = express();
if (TRUST_PROXY) app.set('trust proxy', Number(TRUST_PROXY)); // e.g. 1 behind nginx/Cloudflare
app.use(express.json({ limit: '1kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/info', async (_req, res) => {
  try {
    const bal = await provider.getBalance(wallet.address);
    res.json({ amount: AMOUNT, minMainnetBnb: MIN_MAINNET_BNB, faucetAddress: wallet.address, balance: ethers.formatEther(bal) });
  } catch {
    res.status(502).json({ error: 'RPC unavailable' });
  }
});

app.post('/api/claim', (req, res) => {
  const raw = req.body?.address;
  if (typeof raw !== 'string' || !ethers.isAddress(raw)) {
    return res.status(400).json({ error: 'Invalid address' });
  }
  const address = ethers.getAddress(raw);
  const key = address.toLowerCase();
  const ip = req.ip;

  enqueue(async () => {
    const waitMs = Math.max(remaining(claims.addresses[key]), remaining(claims.ips[ip]));
    if (waitMs > 0) {
      const h = Math.ceil(waitMs / 3600000);
      return res.status(429).json({ error: `Limit reached: 0.3 tBNB per 24 h. Try again in about ${h} h.` });
    }
    if (key === wallet.address.toLowerCase()) {
      return res.status(400).json({ error: 'The faucet address is not allowed' });
    }

    // Anti-farming: the requester must hold at least 0.002 real BNB on BSC Mainnet
    let mainnetBalance;
    try {
      mainnetBalance = await mainnet.getBalance(address);
    } catch {
      return res.status(502).json({ error: 'Could not check your mainnet balance, try again later' });
    }
    if (mainnetBalance < ethers.parseEther(MIN_MAINNET_BNB)) {
      return res.status(403).json({ error: `This address must hold at least ${MIN_MAINNET_BNB} BNB on BSC Mainnet.` });
    }

    const value = ethers.parseEther(AMOUNT);
    const balance = await provider.getBalance(wallet.address);
    if (balance < value + ethers.parseEther('0.01')) {
      return res.status(503).json({ error: 'The faucet is empty, try again later' });
    }

    // Reserve BEFORE sending (anti double-claim), release if the send fails
    const prevAddr = claims.addresses[key];
    const prevIp = claims.ips[ip];
    const reserved = { pending: true, date: new Date().toISOString() };
    claims.addresses[key] = reserved;
    claims.ips[ip] = reserved;
    save();
    try {
      const tx = await wallet.sendTransaction({ to: address, value });
      const record = { txHash: tx.hash, amount: AMOUNT, date: new Date().toISOString() };
      claims.addresses[key] = record;
      claims.ips[ip] = { ...record, address };
      save();
      res.json({ txHash: tx.hash, amount: AMOUNT });
    } catch (err) {
      if (prevAddr) claims.addresses[key] = prevAddr; else delete claims.addresses[key];
      if (prevIp) claims.ips[ip] = prevIp; else delete claims.ips[ip];
      save();
      console.error('Send failed:', err.shortMessage || err.message);
      res.status(500).json({ error: 'Sending failed, try again later' });
    }
  }).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  });
});

app.listen(Number(PORT), () => {
  console.log(`Faucet BSC Testnet on http://localhost:${PORT} - address: ${wallet.address}`);
});
