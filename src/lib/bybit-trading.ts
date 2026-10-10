// Функция для безопасного шифрования ключей в браузере (AES-GCM)
export async function encryptData(text: string, password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encoder.encode(text)
  );

  const result = new Uint8Array( salt.length + iv.length + encrypted.byteLength );
  result.set(salt, 0);
  result.set(iv, salt.length);
  result.set(new Uint8Array(encrypted), salt.length + iv.length);
  
  return btoa(String.fromCharCode(...result));
}

// Функция для расшифровки ключей
export async function decryptData(encryptedBase64: string, password: string): Promise<string> {
  const binaryString = atob(encryptedBase64);
  const data = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    data[i] = binaryString.charCodeAt(i);
  }

  const salt = data.slice(0, 16);
  const iv = data.slice(16, 28);
  const encrypted = data.slice(28);

  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encrypted
  );

  return new TextDecoder().decode(decrypted);
}

const BYBIT = 'https://api.bybit.com';
const RECV_WINDOW = '5000';

export const credentialsStorageKey = 'bybit-trading-credentials';

export type ApiCredentials = { apiKey: string; apiSecret: string };
export type EncryptedCredentials = { v: 1; data: string };

export async function encryptCredentials(creds: ApiCredentials, password: string): Promise<EncryptedCredentials> {
  return { v: 1, data: await encryptData(JSON.stringify(creds), password) };
}

export async function decryptCredentials(encrypted: EncryptedCredentials, password: string): Promise<ApiCredentials> {
  const parsed = JSON.parse(await decryptData(encrypted.data, password)) as Partial<ApiCredentials>;
  if (typeof parsed.apiKey !== 'string' || typeof parsed.apiSecret !== 'string') throw new Error('Повреждённые данные ключей.');
  return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

type BybitResponse<T> = { retCode: number; retMsg: string; result: T };

// Подписанный POST-запрос к Bybit API V5 (HMAC_SHA256)
async function signedPost<T>(creds: ApiCredentials, path: string, body: Record<string, unknown>): Promise<BybitResponse<T>> {
  const timestamp = Date.now().toString();
  const reqBody = JSON.stringify(body);
  const signature = await hmacHex(creds.apiSecret, timestamp + creds.apiKey + RECV_WINDOW + reqBody);
  const response = await fetch(`${BYBIT}${path}`, {
    method: 'POST',
    headers: {
      'X-BAPI-API-KEY': creds.apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      'Content-Type': 'application/json'
    },
    body: reqBody
  });
  if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`);
  return await response.json();
}

// BTC -> BTCUSDT, SOL-USDT-SWAP -> SOLUSDT
function toLinearSymbol(symbol: string): string {
  const clean = symbol.replace('-SWAP', '').replace(/-/g, '').toUpperCase();
  return clean.endsWith('USDT') ? clean : `${clean}USDT`;
}

function decimals(step: string): number {
  const i = step.indexOf('.');
  return i < 0 ? 0 : step.length - i - 1;
}

// Округление количества и цен под шаги инструмента
async function fetchInstrument(symbol: string) {
  const r = await fetch(`${BYBIT}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
  const j = await r.json();
  const info = j?.result?.list?.[0];
  if (!info) throw new Error(`Инструмент ${symbol} не найден на Bybit.`);
  return {
    qtyStep: String(info.lotSizeFilter.qtyStep),
    minQty: Number(info.lotSizeFilter.minOrderQty),
    tickSize: String(info.priceFilter.tickSize),
  };
}

function roundToStep(value: number, step: string, mode: 'floor' | 'round' = 'round'): string {
  const s = Number(step);
  const n = (mode === 'floor' ? Math.floor(value / s + 1e-9) : Math.round(value / s)) * s;
  return n.toFixed(decimals(step));
}

export async function placeLinearMarketOrder(
  creds: ApiCredentials,
  params: { symbol: string; side: 'LONG' | 'SHORT'; qty: number; leverage: number; takeProfit?: number; stopLoss?: number }
): Promise<{ orderId: string; symbol: string; qty: string }> {
  const symbol = toLinearSymbol(params.symbol);
  const inst = await fetchInstrument(symbol);
  const qty = roundToStep(params.qty, inst.qtyStep, 'floor');
  if (Number(qty) < inst.minQty) throw new Error(`Количество меньше минимального для ${symbol} (${inst.minQty}).`);

  const lev = String(Math.max(1, Math.round(params.leverage)));
  const levRes = await signedPost(creds, '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: lev, sellLeverage: lev });
  // 110043: плечо уже установлено
  if (levRes.retCode !== 0 && levRes.retCode !== 110043) throw new Error(`Bybit: ${levRes.retMsg}`);

  const body = {
    category: 'linear',
    symbol,
    side: params.side === 'LONG' ? 'Buy' : 'Sell',
    orderType: 'Market',
    qty,
    ...(params.takeProfit !== undefined ? { takeProfit: roundToStep(params.takeProfit, inst.tickSize), tpTriggerBy: 'LastPrice' } : {}),
    ...(params.stopLoss !== undefined ? { stopLoss: roundToStep(params.stopLoss, inst.tickSize), slTriggerBy: 'LastPrice' } : {}),
  };

  const res = await signedPost<{ orderId: string }>(creds, '/v5/order/create', body);
  if (res.retCode !== 0) throw new Error(`Bybit: ${res.retMsg}`);
  return { orderId: res.result.orderId, symbol, qty };
}
