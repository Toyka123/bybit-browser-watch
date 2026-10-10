// Browser-side Bybit trading: Bybit geo-blocks server IPs, so signed requests are sent from the client.
export type ApiCredentials = { apiKey: string; apiSecret: string };
export type EncryptedCredentials = { v: 1; salt: string; iv: string; data: string };
export type MarketOrderInput = {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  leverage: number;
  takeProfit?: number;
  stopLoss?: number;
};
export type OrderResult = { orderId: string; symbol: string; qty: string };

export const credentialsStorageKey = "bybit-credentials-v1";

const BYBIT = "https://api.bybit.com";
const RECV_WINDOW = "5000";
const PBKDF2_ITERATIONS = 310_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function deriveKey(password: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptCredentials(creds: ApiCredentials, password: string): Promise<EncryptedCredentials> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(creds)));
  return { v: 1, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

export async function decryptCredentials(payload: EncryptedCredentials, password: string): Promise<ApiCredentials> {
  const key = await deriveKey(password, fromB64(payload.salt));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(payload.iv) as BufferSource }, key, fromB64(payload.data) as BufferSource);
  const creds = JSON.parse(dec.decode(plain)) as ApiCredentials;
  if (!creds?.apiKey || !creds?.apiSecret) throw new Error("Повреждённые данные ключей.");
  return creds;
}

async function sign(secret: string, payload: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

type BybitResponse<T> = { retCode: number; retMsg: string; result: T };

async function signedPost<T>(creds: ApiCredentials, path: string, body: Record<string, unknown>) {
  const json = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const signature = await sign(creds.apiSecret, timestamp + creds.apiKey + RECV_WINDOW + json);
  const r = await fetch(`${BYBIT}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": creds.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "X-BAPI-SIGN": signature,
    },
    body: json,
  });
  if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
  return (await r.json()) as BybitResponse<T>;
}

async function fetchLotSize(symbol: string) {
  const r = await fetch(`${BYBIT}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
  if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
  const j = (await r.json()) as BybitResponse<{ list: { lotSizeFilter: { qtyStep: string; minOrderQty: string } }[] }>;
  const f = j.result?.list?.[0]?.lotSizeFilter;
  if (j.retCode !== 0 || !f) throw new Error(`Инструмент ${symbol} не найден: ${j.retMsg}`);
  return { step: f.qtyStep, min: Number(f.minOrderQty) };
}

function roundToStep(qty: number, step: string) {
  const decimals = step.includes(".") ? step.split(".")[1]?.length ?? 0 : 0;
  const s = Number(step);
  return (Math.floor(qty / s + 1e-9) * s).toFixed(decimals);
}

export async function placeLinearMarketOrder(creds: ApiCredentials, input: MarketOrderInput): Promise<OrderResult> {
  const symbol = `${input.symbol}USDT`;
  const { step, min } = await fetchLotSize(symbol);
  const qty = roundToStep(input.qty, step);
  if (Number(qty) < min) throw new Error(`Объём ${qty} меньше минимального (${min}) для ${symbol}.`);

  const lev = String(Math.round(input.leverage));
  const levRes = await signedPost(creds, "/v5/position/set-leverage", { category: "linear", symbol, buyLeverage: lev, sellLeverage: lev });
  // 110043: leverage not modified (already set).
  if (levRes.retCode !== 0 && levRes.retCode !== 110043) throw new Error(`Ошибка установки плеча: ${levRes.retMsg}`);

  const order: Record<string, unknown> & { takeProfit?: string; stopLoss?: string } = {
    category: "linear",
    symbol,
    side: input.side === "LONG" ? "Buy" : "Sell",
    orderType: "Market",
    qty,
  };
  if (input.takeProfit) order.takeProfit = String(input.takeProfit);
  if (input.stopLoss) order.stopLoss = String(input.stopLoss);

  const res = await signedPost<{ orderId: string }>(creds, "/v5/order/create", order);
  if (res.retCode !== 0) throw new Error(`Bybit отклонил ордер: ${res.retMsg}`);
  return { orderId: res.result.orderId, symbol, qty };
}
