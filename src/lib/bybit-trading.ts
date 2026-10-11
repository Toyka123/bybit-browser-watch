// Bybit V5 trading helpers (browser-side: Bybit geo-blocks server IPs).

const BASE = "https://api.bybit.com";
export const credentialsStorageKey = "bybit-encrypted-credentials-v1";

export type ApiCredentials = { apiKey: string; apiSecret: string };
export type EncryptedCredentials = { v: 1; data: string };

async function deriveKey(password: string, salt: Uint8Array, usage: KeyUsage) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export async function encryptData(text: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, "encrypt");
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  const out = new Uint8Array(28 + encrypted.byteLength);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(new Uint8Array(encrypted), 28);
  let bin = "";
  out.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export async function decryptData(b64: string, password: string): Promise<string> {
  const bin = atob(b64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const key = await deriveKey(password, data.slice(0, 16), "decrypt");
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(16, 28) }, key, data.slice(28));
  return new TextDecoder().decode(dec);
}

export async function encryptCredentials(c: ApiCredentials, password: string): Promise<EncryptedCredentials> {
  return { v: 1, data: await encryptData(JSON.stringify(c), password) };
}

export async function decryptCredentials(e: EncryptedCredentials, password: string): Promise<ApiCredentials> {
  const parsed = JSON.parse(await decryptData(e.data, password)) as ApiCredentials;
  if (!parsed?.apiKey || !parsed?.apiSecret) throw new Error("Invalid credentials");
  return parsed;
}

async function sign(secret: string, msg: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function privatePost(c: ApiCredentials, path: string, body: Record<string, unknown>) {
  const ts = Date.now().toString();
  const recv = "5000";
  const raw = JSON.stringify(body);
  const signature = await sign(c.apiSecret, ts + c.apiKey + recv + raw);
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "X-BAPI-API-KEY": c.apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": recv,
      "Content-Type": "application/json",
    },
    body: raw,
  });
  return (await res.json()) as { retCode: number; retMsg: string; result: any };
}

export function normalizeSymbol(sym: string) {
  const s = sym.toUpperCase().replace(/-SWAP$/, "").replace(/-/g, "");
  return s.endsWith("USDT") ? s : s + "USDT";
}

function roundStep(v: number, step: string) {
  const st = Number(step) || 0.001;
  const decimals = (step.split(".")[1] ?? "").replace(/0+$/, "").length;
  return (Math.floor(v / st + 1e-9) * st).toFixed(decimals);
}

export async function placeLinearMarketOrder(
  c: ApiCredentials,
  p: { symbol: string; side: "LONG" | "SHORT"; qty: number; leverage: number; takeProfit?: number; stopLoss?: number },
) {
  const symbol = normalizeSymbol(p.symbol);
  const info = await fetch(`${BASE}/v5/market/instruments-info?category=linear&symbol=${symbol}`).then((r) => r.json());
  const inst = info?.result?.list?.[0];
  if (!inst) throw new Error(`Инструмент ${symbol} не найден на Bybit.`);
  const qty = roundStep(p.qty, inst.lotSizeFilter.qtyStep);
  if (Number(qty) < Number(inst.lotSizeFilter.minOrderQty)) throw new Error(`Количество меньше минимума (${inst.lotSizeFilter.minOrderQty}).`);
  const tick = inst.priceFilter.tickSize as string;

  const lev = String(Math.round(p.leverage));
  const levRes = await privatePost(c, "/v5/position/set-leverage", { category: "linear", symbol, buyLeverage: lev, sellLeverage: lev });
  if (levRes.retCode !== 0 && levRes.retCode !== 110043) throw new Error(`Плечо: ${levRes.retMsg}`);

  const body: Record<string, unknown> = {
    category: "linear",
    symbol,
    side: p.side === "LONG" ? "Buy" : "Sell",
    orderType: "Market",
    qty,
    positionIdx: 0,
  };
  if (p.takeProfit && p.stopLoss) {
    body["takeProfit"] = roundStep(p.takeProfit, tick);
    body["stopLoss"] = roundStep(p.stopLoss, tick);
    body["tpTriggerBy"] = "LastPrice";
    body["slTriggerBy"] = "LastPrice";
  }
  const res = await privatePost(c, "/v5/order/create", body);
  if (res.retCode !== 0) throw new Error(`Bybit: ${res.retMsg} (${res.retCode})`);
  return { symbol, qty, orderId: res.result.orderId as string };
}
