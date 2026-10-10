
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

// Отправка рыночного ордера на Bybit API V5
export async function placeBybitOrder(params: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: string;
  takeProfit?: string;
  stopLoss?: string;
}) {
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  
  // Убираем префикс -SWAP для совместимости с Bybit API (например, SOL-USDT-SWAP -> SOLUSDT)
  const cleanSymbol = params.symbol.replace('-SWAP', '').replace('-', '');

  const body = {
    category: 'linear',
    symbol: cleanSymbol,
    side: params.side,
    orderType: 'Market',
    qty: params.qty,
    timeInForce: 'GTC',
    takeProfit: params.takeProfit,
    stopLoss: params.stopLoss,
    tpTriggerBy: 'LastPrice',
    slTriggerBy: 'LastPrice'
  };

  const reqBody = JSON.stringify(body);
  const paramStr = timestamp + params.apiKey + recvWindow + reqBody;

  // Генерация подписи HMAC_SHA256 для Bybit V5
  const cryptoObj = window.crypto;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(params.apiSecret);
  const messageData = encoder.encode(paramStr);

  const cryptoKey = await cryptoObj.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signatureBuffer = await cryptoObj.subtle.sign('HMAC', cryptoKey, messageData);
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  // Отправляем запрос напрямую на официальный эндпоинт Bybit V5
  const response = await fetch('https://api.bybit.com/v5/order/create', {
    method: 'POST',
    headers: {
      'X-BAPI-API-KEY': params.apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'Content-Type': 'application/json'
    },
    body: reqBody
  });

  return await response.json();
}

export const credentialsStorageKey = 'bybit-encrypted-credentials';

export type ApiCredentials = { apiKey: string; apiSecret: string };
export type EncryptedCredentials = { version: 1; data: string };

export async function encryptCredentials(creds: ApiCredentials, password: string): Promise<EncryptedCredentials> {
  return { version: 1, data: await encryptData(JSON.stringify(creds), password) };
}

export async function decryptCredentials(encrypted: EncryptedCredentials, password: string): Promise<ApiCredentials> {
  const parsed = JSON.parse(await decryptData(encrypted.data, password)) as ApiCredentials;
  if (!parsed?.apiKey || !parsed?.apiSecret) throw new Error('Invalid credentials');
  return parsed;
}

async function signedPost(creds: ApiCredentials, path: string, body: Record<string, unknown>) {
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const reqBody = JSON.stringify(body);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(creds.apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(timestamp + creds.apiKey + recvWindow + reqBody));
  const signature = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const res = await fetch(`https://api.bybit.com${path}`, {
    method: 'POST',
    headers: {
      'X-BAPI-API-KEY': creds.apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'Content-Type': 'application/json',
    },
    body: reqBody,
  });
  return (await res.json()) as { retCode: number; retMsg: string; result: any };
}

// Рыночный ордер по линейному USDT-контракту (Bybit V5, One-Way)
export async function placeLinearMarketOrder(
  creds: ApiCredentials,
  p: { symbol: string; side: 'LONG' | 'SHORT'; qty: number; leverage: number; takeProfit?: number; stopLoss?: number },
): Promise<{ symbol: string; qty: string; orderId: string }> {
  const symbol = p.symbol.toUpperCase().replace(/-SWAP$/, '').replace(/-/g, '').replace(/USDT$/, '') + 'USDT';

  const info = await fetch(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${symbol}`).then((r) => r.json());
  const lot = info?.result?.list?.[0]?.lotSizeFilter;
  if (!lot) throw new Error(`Инструмент ${symbol} не найден на Bybit.`);
  const step = Number(lot.qtyStep);
  const decimals = (lot.qtyStep.split('.')[1] ?? '').length;
  const qty = (Math.floor(p.qty / step) * step).toFixed(decimals);
  if (Number(qty) < Number(lot.minOrderQty)) throw new Error(`Количество меньше минимального (${lot.minOrderQty}).`);

  const lev = await signedPost(creds, '/v5/position/set-leverage', {
    category: 'linear', symbol, buyLeverage: String(p.leverage), sellLeverage: String(p.leverage),
  });
  // 110043 = плечо уже установлено
  if (lev.retCode !== 0 && lev.retCode !== 110043) throw new Error(`Bybit: ${lev.retMsg}`);

  const order = await signedPost(creds, '/v5/order/create', {
    category: 'linear',
    symbol,
    side: p.side === 'LONG' ? 'Buy' : 'Sell',
    orderType: 'Market',
    qty,
    ...(p.takeProfit ? { takeProfit: String(p.takeProfit), tpTriggerBy: 'LastPrice' } : {}),
    ...(p.stopLoss ? { stopLoss: String(p.stopLoss), slTriggerBy: 'LastPrice' } : {}),
  });
  if (order.retCode !== 0) throw new Error(`Bybit: ${order.retMsg}`);
  return { symbol, qty, orderId: order.result.orderId };
}
