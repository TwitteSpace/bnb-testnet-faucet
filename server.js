import express from 'express';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Constantes de sécurité (volontairement NON configurables via .env) ----
const AMOUNT = '0.3';            // tBNB par requête, maximum
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 claim / 24 h par adresse et par IP
const CHAIN_ID = 97;             // BSC Testnet uniquement
const MAINNET_CHAIN_ID = 56;     // BSC Mainnet, lecture seule : sert à vérifier le solde du demandeur
const MIN_MAINNET_BNB = '0.002'; // le demandeur doit détenir au moins ce montant en vrai BNB
const CLAIMS_FILE = path.join(__dirname, 'data', 'claims.json');

// ---- Config via .env ----
const {
  PRIVATE_KEY,
  RPC_URL = 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  MAINNET_RPC_URL = 'https://bsc-dataseed.bnbchain.org',
  PORT = '3000',
  TRUST_PROXY,
} = process.env;
if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY manquante (voir .env.example)');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
// Mainnet : jamais utilisé pour envoyer, uniquement pour lire le solde du demandeur
const mainnet = new ethers.JsonRpcProvider(MAINNET_RPC_URL);

// Garde-fou : refuse de démarrer si le RPC n'est pas BSC Testnet (évite d'envoyer de vrais BNB)
const network = await provider.getNetwork();
if (network.chainId !== BigInt(CHAIN_ID)) {
  console.error(`Mauvais réseau (chainId ${network.chainId}), attendu ${CHAIN_ID} (BSC Testnet).`);
  process.exit(1);
}

const mainnetNetwork = await mainnet.getNetwork();
if (mainnetNetwork.chainId !== BigInt(MAINNET_CHAIN_ID)) {
  console.error(`MAINNET_RPC_URL pointe vers le mauvais réseau (chainId ${mainnetNetwork.chainId}), attendu ${MAINNET_CHAIN_ID} (BSC Mainnet).`);
  process.exit(1);
}

// ---- Stockage des claims (0.3 tBNB max par adresse ET par IP toutes les 24 h) ----
fs.mkdirSync(path.dirname(CLAIMS_FILE), { recursive: true });
let claims = { addresses: {}, ips: {} };
if (fs.existsSync(CLAIMS_FILE)) claims = JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8'));
const save = () => {
  const tmp = CLAIMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(claims, null, 2));
  fs.renameSync(tmp, CLAIMS_FILE);
};

// Temps restant (ms) avant qu'un enregistrement n'expire (0 si libre)
const remaining = (rec) => (rec?.date ? Math.max(0, Date.parse(rec.date) + COOLDOWN_MS - Date.now()) : 0);

// File d'attente : traite une requête à la fois (pas de race condition, nonce propre)
let queue = Promise.resolve();
const enqueue = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

const app = express();
if (TRUST_PROXY) app.set('trust proxy', Number(TRUST_PROXY)); // ex: 1 derrière nginx/Cloudflare
app.use(express.json({ limit: '1kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/info', async (_req, res) => {
  try {
    const bal = await provider.getBalance(wallet.address);
    res.json({ amount: AMOUNT, minMainnetBnb: MIN_MAINNET_BNB, faucetAddress: wallet.address, balance: ethers.formatEther(bal) });
  } catch {
    res.status(502).json({ error: 'RPC indisponible' });
  }
});

app.post('/api/claim', (req, res) => {
  const raw = req.body?.address;
  if (typeof raw !== 'string' || !ethers.isAddress(raw)) {
    return res.status(400).json({ error: 'Adresse invalide' });
  }
  const address = ethers.getAddress(raw);
  const key = address.toLowerCase();
  const ip = req.ip;

  enqueue(async () => {
    const waitMs = Math.max(remaining(claims.addresses[key]), remaining(claims.ips[ip]));
    if (waitMs > 0) {
      const h = Math.ceil(waitMs / 3600000);
      return res.status(429).json({ error: `Limite atteinte : 0.3 tBNB par 24 h. Réessaie dans ~${h} h.` });
    }
    if (key === wallet.address.toLowerCase()) {
      return res.status(400).json({ error: 'Adresse du faucet interdite' });
    }

    // Anti-farming : le demandeur doit détenir au moins 0.002 BNB réels sur BSC Mainnet
    let mainnetBalance;
    try {
      mainnetBalance = await mainnet.getBalance(address);
    } catch {
      return res.status(502).json({ error: 'Impossible de vérifier ton solde mainnet, réessaie plus tard' });
    }
    if (mainnetBalance < ethers.parseEther(MIN_MAINNET_BNB)) {
      return res.status(403).json({ error: `Il faut détenir au moins ${MIN_MAINNET_BNB} BNB (BSC Mainnet) sur cette adresse.` });
    }

    const value = ethers.parseEther(AMOUNT);
    const balance = await provider.getBalance(wallet.address);
    if (balance < value + ethers.parseEther('0.01')) {
      return res.status(503).json({ error: 'Faucet vide, réessaie plus tard' });
    }

    // On réserve AVANT d'envoyer (anti double-claim), on libère si l'envoi échoue
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
      console.error('Envoi échoué:', err.shortMessage || err.message);
      res.status(500).json({ error: "Échec de l'envoi, réessaie plus tard" });
    }
  }).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur interne' });
  });
});

app.listen(Number(PORT), () => {
  console.log(`Faucet BSC Testnet sur http://localhost:${PORT} — adresse: ${wallet.address}`);
});
