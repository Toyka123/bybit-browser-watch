export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type Ticker = { last: number; bid: number; ask: number };
export type Mode = "demo" | "live";

export const SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LINK", "AVAX", "DOT", "LTC", "ATOM", "BNB", "TRX", "NEAR", "SUI"];
export const TIMEFRAMES: Record<string, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240" };
const TF_MS: Record<string, number> = { "1m": 6e4, "5m": 3e5, "15m": 9e5, "1h": 36e5, "4h": 144e5 };
const BYBIT = "https://api.bybit.com";

export const pair = (s: string) => `${s}-USDT-SWAP`;

// Called from the browser: Bybit geo-blocks many server IPs.
export async function checkBybit(): Promise<number> {
  const t0 = performance.now();
  const r = await fetch(`${BYBIT}/v5/market/time`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg || "Bybit error");
  await fetchTicker("live", "BTC");
  return Math.round(performance.now() - t0);
}

export async function fetchCandles(mode: Mode, sym: string, tf: string, limit = 200): Promise<Candle[]> {
  if (mode === "demo") return demoCandles(sym, tf, limit);
  const r = await fetch(`${BYBIT}/v5/market/kline?category=linear&symbol=${sym}USDT&interval=${TIMEFRAMES[tf]}&limit=${limit}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg);
  return (j.result.list as string[][])
    .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }))
    .reverse();
}

export async function fetchTicker(mode: Mode, sym: string): Promise<Ticker> {
  if (mode === "demo") {
    const c = demoCandles(sym, "1m", 2).at(-1)!.c;
    return { last: c, bid: c * 0.9998, ask: c * 1.0002 };
  }
  const r = await fetch(`${BYBIT}/v5/market/tickers?category=linear&symbol=${sym}USDT`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg);
  const t = j.result.list[0];
  return { last: +t.lastPrice, bid: +t.bid1Price, ask: +t.ask1Price };
}

const BASE: Record<string, number> = { BTC: 62000, ETH: 2500, SOL: 145, XRP: 0.55, DOGE: 0.12, ADA: 0.36, LINK: 11, AVAX: 27, DOT: 4.3, LTC: 66, ATOM: 4.5, BNB: 570, TRX: 0.16, NEAR: 4.8, SUI: 1.9 };

function hash(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function demoCandles(sym: string, tf: string, limit: number): Candle[] {
  const step = TF_MS[tf];
  const now = Math.floor(Date.now() / step) * step;
  const seed = sym.split("").reduce((a, ch) => a + ch.charCodeAt(0) * 31, 0);
  const out: Candle[] = [];
  let p = BASE[sym] ?? 10;
  for (let i = limit - 1; i >= 0; i--) {
    const t = now - i * step;
    const k = t / step + seed;
    const drift = Math.sin(k / 23) * 0.002 + (hash(k) - 0.5) * 0.006;
    const o = p;
    const c = o * (1 + drift);
    out.push({ t, o, c, h: Math.max(o, c) * (1 + hash(k + 1) * 0.002), l: Math.min(o, c) * (1 - hash(k + 2) * 0.002) });
    p = c;
  }
  return out;
}

export function ema(v: number[], n: number) {
  const k = 2 / (n + 1);
  const out: number[] = [];
  v.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)));
  return out;
}

export function rsi(v: number[], n: number) {
  let g = 0, l = 0;
  for (let i = v.length - n; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

export function atr(c: Candle[], n = 14) {
  let s = 0;
  for (let i = c.length - n; i < c.length; i++) s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  return s / n;
}

export type Params = { risk: number; leverage: number; ema1: number; ema2: number; rsi: number };

export function analyze(c: Candle[], p: Params) {
  const closes = c.map((x) => x.c);
  const f = ema(closes, p.ema1), s = ema(closes, p.ema2);
  const r = rsi(closes, p.rsi);
  const last = closes.at(-1)!, ef = f.at(-1)!, es = s.at(-1)!;
  const a = atr(c);
  let side: "LONG" | "SHORT" | null = null;
  if (ef > es && last > ef && r > 50 && r < 70) side = "LONG";
  if (ef < es && last < ef && r < 50 && r > 30) side = "SHORT";
  const dir = side === "SHORT" ? -1 : 1;
  const risk = a * 1.5;
  return {
    side, rsi: r, emaF: f, emaS: s,
    trend: ef > es ? "Тренд вверх" : "Тренд вниз",
    entry: last, sl: last - dir * risk, tp1: last + dir * risk * 1.5, tp2: last + dir * risk * 3,
  };
}

export const fmt = (n: number) => {
  const a = Math.abs(n);
  return n.toFixed(a >= 1000 ? 1 : a >= 10 ? 3 : a >= 1 ? 5 : 6);
};
