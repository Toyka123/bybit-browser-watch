import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { analyze, atr, checkBybit, fetchCandles, fetchTicker, fmt, pair, SYMBOLS, TIMEFRAMES, type Candle, type Mode, type Params } from "@/lib/market";
import { BybitWidget } from "@/components/BybitWidget";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Сигнальный бот · Bybit Live" },
      { name: "description", content: "Сканер крипторынка по EMA/RSI с живыми свечами Bybit, сигналами и контролем SL/TP." },
      { property: "og:title", content: "Сигнальный бот · Bybit Live" },
      { property: "og:description", content: "Сканер крипторынка с живыми данными Bybit." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Status = "open" | "tp1" | "tp2" | "sl";
type Signal = { id: string; sym: string; side: "LONG" | "SHORT"; tf: string; entry: number; sl: number; tp1: number; tp2: number; price: number; spread: number; time: number; trend: string; status: Status; candles: Candle[]; exchange: string; lev: number; atrPct: number };
type Conn = { status: "idle" | "checking" | "ok" | "error"; latency?: number; error?: string };

const field = "h-11 w-full rounded-lg border border-input bg-muted px-4 font-mono text-foreground outline-none focus:border-primary";
const label = "mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground";
const SIGNAL_TTL = 40000;
const tfMs = (tf: string) => (Number(TIMEFRAMES[tf]) || 5) * 60000;
const fmtLeft = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}м`;
  return `${Math.floor(m / 60)}ч ${m % 60}м`;
};

function Index() {
  const [mode, setMode] = useState<Mode>("demo");
  const [conn, setConn] = useState<Conn>({ status: "idle" });
  const [asset, setAsset] = useState("BTC");
  const [tf, setTf] = useState("5m");
  const [autoPick, setAutoPick] = useState(true);
  const [autoTf, setAutoTf] = useState(true);
  const [autoMon, setAutoMon] = useState(true);
  const [p, setP] = useState<Params>({ risk: 1, leverage: 5, ema1: 9, ema2: 21, rsi: 14 });
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [found, setFound] = useState(0);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [sls, setSls] = useState<number[]>([]);
  const [log, setLog] = useState<string>("");

  const st = useRef({ mode, tf, p, autoPick, autoTf, asset, signals, sls });
  st.current = { mode, tf, p, autoPick, autoTf, asset, signals, sls };
  const exchange = mode === "live" ? "BYBIT" : "DEMO";
  const sl24 = sls.filter((t) => Date.now() - t < 864e5).length;

  async function enableLive() {
    setConn({ status: "checking" });
    try {
      const latency = await checkBybit();
      setConn({ status: "ok", latency });
      setMode("live");
      setSignals([]);
    } catch (e) {
      setConn({ status: "error", error: e instanceof Error ? e.message : "нет ответа" });
      setMode("demo");
    }
  }

  async function scan() {
    const s = st.current;
    if (s.sls.filter((t) => Date.now() - t < 864e5).length >= 3) { setLog("Лимит стоп-лоссов за 24ч достигнут — сканирование приостановлено"); return; }
    setBusy(true);
    const list = s.autoPick ? SYMBOLS : [s.asset];
    let n = 0, f = 0;
    const fresh: Signal[] = [];
    await Promise.all(list.map(async (sym) => {
      try {
        if (s.signals.some((x) => x.sym === sym && (x.status === "open" || x.status === "tp1"))) return;
        n++;
        const tfs = s.autoTf ? Object.keys(TIMEFRAMES) : [s.tf];
        let best: { a: ReturnType<typeof analyze>; tf: string; c: Candle[]; score: number } | null = null;
        for (const tf of tfs) {
          const c = await fetchCandles(s.mode, sym, tf);
          const a = analyze(c, s.p);
          if (!a.side) continue;
          const score = Math.abs(a.rsi - 50) + Math.abs(a.emaF.at(-1)! - a.emaS.at(-1)!) / (atr(c) || 1);
          if (!best || score > best.score) best = { a, tf, c, score };
        }
        if (!best) return;
        const t = await fetchTicker(s.mode, sym);
        const spread = ((t.ask - t.bid) / t.last) * 100;
        if (spread > 0.1) return;
        f++;
        fresh.push({ id: `${sym}-${Date.now()}`, sym, side: best.a.side!, tf: best.tf, entry: best.a.entry, sl: best.a.sl, tp1: best.a.tp1, tp2: best.a.tp2, price: t.last, spread, time: Date.now(), trend: best.a.trend, status: "open", candles: best.c, exchange: s.mode === "live" ? "BYBIT" : "DEMO", lev: best.a.leverage, atrPct: best.a.atrPct });
      } catch { /* skip symbol */ }
    }));
    setScanned(n);
    setFound((x) => x + f);
    if (fresh.length) { setSignals((x) => [...x, ...fresh]); setSel((cur) => cur ?? fresh[0]!.id); }
    setLog(`Скан ${new Date().toLocaleTimeString("ru")}: ${n} монет, ${f} новых сигналов (${s.mode === "live" ? "Bybit" : "демо"})`);
    setBusy(false);
  }

  async function monitor() {
    const s = st.current;
    const open = s.signals.filter((x) => x.status === "open" || x.status === "tp1");
    if (!open.length) return;
    const updates = await Promise.all(open.map(async (x) => {
      try {
        const t = await fetchTicker(s.mode, x.sym);
        const c = await fetchCandles(s.mode, x.sym, x.tf, 120);
        return { id: x.id, price: t.last, candles: c };
      } catch { return null; }
    }));
    let newSl = 0;
    setSignals((list) => list.map((x) => {
      const u = updates.find((v) => v?.id === x.id);
      if (!u) return x;
      const long = x.side === "LONG";
      let { status, sl } = x;
      if (long ? u.price <= sl : u.price >= sl) { if (status === "open") newSl++; status = status === "tp1" ? "tp2" : "sl"; }
      else if (long ? u.price >= x.tp2 : u.price <= x.tp2) status = "tp2";
      else if (status === "open" && (long ? u.price >= x.tp1 : u.price <= x.tp1)) { status = "tp1"; sl = x.entry; }
      return { ...x, price: u.price, candles: u.candles, status, sl };
    }));
    if (newSl) setSls((v) => [...v, ...Array(newSl).fill(Date.now())]);
  }

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setSignals((list) => list.filter((x) => now - x.time < SIGNAL_TTL + tfMs(x.tf)));
    }, 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!running) return;
    scan();
    if (!autoMon) { setRunning(false); return; }
    const a = setInterval(scan, 60000);
    const b = setInterval(monitor, 10000);
    return () => { clearInterval(a); clearInterval(b); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, autoMon, mode]);

  const active = signals.filter((x) => x.status === "open" || x.status === "tp1");
  const cur = signals.find((x) => x.id === sel) ?? signals.at(-1);

  return (
    <div className="min-h-screen px-4 py-6 md:px-10">
      <header className="mx-auto mb-6 flex max-w-7xl items-center justify-between border-b pb-4">
        <h1 className="font-mono text-lg font-bold tracking-tight">SIGNAL<span className="text-primary">·</span>BOT</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className={`h-2 w-2 rounded-full ${mode === "live" ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
          <span className="font-mono font-semibold">{mode === "live" ? "Bybit · Live" : "Демо-данные"}</span>
          {mode === "live" && conn.latency != null && <span className="text-muted-foreground">{conn.latency} мс</span>}
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5">
        <section className="rounded-xl border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-5">
            <span className={label + " mb-0"}>Источник данных</span>
            <div className="flex flex-wrap items-center gap-3">
              {conn.status === "checking" && <span className="rounded-md border border-warn/40 px-3 py-1 text-xs text-warn">Проверка подключения к Bybit…</span>}
              {conn.status === "error" && <span className="rounded-md border border-destructive/40 px-3 py-1 text-xs text-destructive">Bybit недоступен ({conn.error}) — остаёмся в демо</span>}
              {mode === "live" && <span className="rounded-md border border-primary/40 px-3 py-1 text-xs text-primary">Bybit · реальные цены · ключи API не нужны для мониторинга</span>}
              <div className="flex rounded-lg border bg-muted p-1 text-sm">
                <button onClick={() => { setMode("demo"); setConn({ status: "idle" }); setSignals([]); }} className={`rounded-md px-4 py-1.5 ${mode === "demo" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>Демо</button>
                <button disabled={conn.status === "checking"} onClick={enableLive} className={`rounded-md px-4 py-1.5 ${mode === "live" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>Bybit · Live</button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 border-b py-5 md:grid-cols-[1.2fr_1fr_1fr_1fr_1fr_auto]">
            <div>
              <div className={label}>Актив</div>
              {autoPick ? (
                <div className="rounded-lg border border-primary/50 bg-primary/10 px-4 py-2.5">
                  <div className="font-semibold text-primary">Авто-выбор</div>
                  <div className="text-xs text-muted-foreground">Сканируется {SYMBOLS.length} ликвидных монет</div>
                </div>
              ) : (
                <select className={field} value={asset} onChange={(e) => setAsset(e.target.value)}>
                  {SYMBOLS.map((s) => <option key={s} value={s}>{pair(s)}</option>)}
                </select>
              )}
            </div>
            <div>
              <div className={label}>Таймфрейм</div>
              {autoTf ? (
                <div className="rounded-lg border border-primary/50 bg-primary/10 px-4 py-2.5">
                  <div className="font-semibold text-primary">Авто-выбор</div>
                  <div className="text-xs text-muted-foreground">Проверяются {Object.keys(TIMEFRAMES).length} таймфреймов, берётся самый сильный сигнал</div>
                </div>
              ) : (
                <select className={field} value={tf} onChange={(e) => setTf(e.target.value)}>
                  {Object.keys(TIMEFRAMES).map((t) => <option key={t}>{t}</option>)}
                </select>
              )}
            </div>
            <Toggle title="Авто-выбор актива" on={autoPick} set={setAutoPick} />
            <Toggle title="Авто-таймфрейм" on={autoTf} set={setAutoTf} />
            <Toggle title="Авто-мониторинг" on={autoMon} set={setAutoMon} />
            <div className="flex items-end gap-3">
              <button disabled={busy} onClick={() => setRunning(true)} className="h-11 whitespace-nowrap rounded-lg bg-primary px-5 font-semibold text-primary-foreground disabled:opacity-60">
                {busy ? "Сканирую…" : running ? "◉ Работает" : "◎ Сканировать рынок"}
              </button>
              <button onClick={() => setRunning(false)} className="h-11 rounded-lg border border-destructive/50 bg-destructive/10 px-5 font-semibold text-destructive">▢ Стоп</button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-5 md:grid-cols-5">
            {([["risk", "Риск, %"], ["leverage", "Плечо"], ["ema1", "EMA 1"], ["ema2", "EMA 2"], ["rsi", "RSI период"]] as const).map(([k, l]) => (
              <div key={k}>
                <div className={label}>{l}</div>
                <input type="number" className={field} value={p[k]} onChange={(e) => setP({ ...p, [k]: Number(e.target.value) || 1 })} />
              </div>
            ))}
          </div>
          {log && <p className="mt-4 font-mono text-xs text-muted-foreground">{log}</p>}
        </section>

        <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat l="Отсканировано" v={scanned} />
          <Stat l="Сигналов найдено" v={found} c="text-primary" />
          <Stat l="Активных позиций" v={active.length} c="text-info" />
          <Stat l="Стоп-лоссов за 24ч" v={`${sl24}/3`} c={sl24 >= 3 ? "text-destructive" : "text-muted-foreground"} />
        </section>

        {signals.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {signals.map((x) => {
              const elapsed = Date.now() - x.time;
              const eLeft = SIGNAL_TTL - elapsed;
              const closed = x.status === "sl" || x.status === "tp2";
              return (
                <button key={x.id} onClick={() => setSel(x.id)} className={`flex items-center gap-2 rounded-lg border bg-card px-3 py-2 font-mono text-xs font-semibold ${cur?.id === x.id ? "border-primary/60" : ""} ${closed ? "opacity-50" : ""}`}>
                  {pair(x.sym)}
                  <span className={`rounded px-1.5 py-0.5 ${x.side === "LONG" ? "bg-long/15 text-long" : "bg-short/15 text-short"}`}>{x.side}</span>
                  <span className="text-muted-foreground">{x.tf}</span>
                  <span className={`rounded px-1.5 py-0.5 font-mono ${eLeft > 0 && !closed ? (eLeft <= 10000 ? "bg-destructive/15 text-destructive" : "bg-warn/15 text-warn") : closed ? "bg-muted text-muted-foreground" : "bg-info/15 text-info"}`}>
                    {eLeft > 0 && !closed ? `⏱ ${Math.ceil(eLeft / 1000)}с` : closed ? x.status.toUpperCase() : `◧ ${fmtLeft(SIGNAL_TTL + tfMs(x.tf) - elapsed)}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {cur ? (
          <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-[1.1fr_1.2fr_minmax(320px,360px)]">
            <Detail s={cur} />
            <Chart s={cur} p={p} />
            <BybitWidget key={cur.id} s={cur} />
          </div>
        ) : (
          <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">Нажмите «Сканировать рынок», чтобы найти сигналы{mode === "live" ? " по живым данным Bybit" : ""}.</div>
        )}
      </main>
    </div>
  );
}

function Toggle({ title, on, set }: { title: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted px-4 py-3">
      <span className="text-sm font-semibold">{title}</span>
      <button onClick={() => set(!on)} className="flex items-center gap-2 text-xs">
        <span className={on ? "text-primary" : "text-muted-foreground"}>{on ? "Вкл" : "Выкл"}</span>
        <span className={`flex h-6 w-11 items-center rounded-full p-0.5 transition ${on ? "bg-primary" : "bg-secondary"}`}>
          <span className={`h-5 w-5 rounded-full bg-foreground transition ${on ? "translate-x-5" : ""}`} />
        </span>
      </button>
    </div>
  );
}

function Stat({ l, v, c = "" }: { l: string; v: string | number; c?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{l}</div>
      <div className={`mt-2 font-mono text-xl font-bold ${c}`}>{v}</div>
    </div>
  );
}

function Detail({ s }: { s: Signal }) {
  const pts = [s.tp2, s.tp1, s.price, s.entry, s.sl];
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const pos = (v: number) => {
    const r = (v - lo) / (hi - lo || 1);
    return (s.side === "SHORT" ? 1 - r : r) * 100;
  };
  const leftToRight = s.side === "SHORT" ? [...pts] : [...pts].reverse();
  void leftToRight;
  const elapsed = Date.now() - s.time;
  const leftMs = SIGNAL_TTL - elapsed;
  const leftSec = Math.max(0, Math.ceil(leftMs / 1000));
  const lifeLeft = fmtLeft(SIGNAL_TTL + tfMs(s.tf) - elapsed);
  const mins = Math.round(elapsed / 60000);
  const statusText = { open: "Открыта", tp1: "TP1 взят · SL в безубыток", tp2: "TP2 взят · закрыта", sl: "Стоп-лосс · закрыта" }[s.status];
  const marks: [string, number, string][] = [["TP2", s.tp2, "text-long"], ["TP1", s.tp1, "text-long"], ["Цена", s.price, "text-info"], ["Вход", s.entry, "text-foreground"], ["SL", s.sl, "text-short"]];
  return (
    <div className="rounded-xl border bg-card p-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-xl font-bold">{pair(s.sym)}</h2>
            <span className={`rounded px-2 py-0.5 font-mono text-sm font-bold ${s.side === "LONG" ? "bg-long/15 text-long" : "bg-short/15 text-short"}`}>{s.side}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="rounded bg-muted px-2 py-0.5 font-mono">{s.tf}</span>
            <span>{new Date(s.time).toLocaleString("ru", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
            <span>· {mins} мин назад · {s.trend}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{s.exchange} · спред {s.spread.toFixed(3)}% · {statusText}</div>
          <div className="mt-2 flex items-center gap-2">
            {leftMs > 0 ? (
              <>
                <span className={`rounded-md px-2.5 py-1 font-mono text-sm font-bold ${leftSec <= 10 ? "bg-destructive/15 text-destructive" : "bg-warn/15 text-warn"}`}>⏱ {leftSec}с</span>
                <span className="text-xs text-muted-foreground">на вход в сделку</span>
              </>
            ) : (
              <>
                <span className="rounded-md px-2.5 py-1 font-mono text-sm font-bold bg-info/15 text-info">◧ {lifeLeft}</span>
                <span className="text-xs text-muted-foreground">сигнал живёт выбранный таймфрейм ({s.tf}), потом исчезнет</span>
              </>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase text-muted-foreground">Текущая цена</div>
          <div className="font-mono text-xl font-bold">{fmt(s.price)}</div>
        </div>
      </div>

      <div className="relative mt-10 mb-10 h-2 rounded-full" style={{ background: "linear-gradient(90deg, var(--primary), var(--secondary) 60%, var(--destructive))" }}>
        {marks.map(([n, v, c]) => (
          <div key={n} className="absolute -translate-x-1/2" style={{ left: `${pos(v)}%`, top: -24 }}>
            <div className="text-center text-[10px] text-muted-foreground">{n}</div>
            <div className={`mx-auto mt-1 ${n === "Цена" ? "h-3 w-3 rounded-full border-2 border-foreground bg-info" : "h-3 w-0.5 bg-current"} ${c}`} />
            <div className={`mt-3 text-center font-mono text-[10px] ${c}`}>{fmt(v)}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat l="Зона входа" v={fmt(s.entry)} />
        <Stat l="Stop-loss" v={fmt(s.sl)} c="text-short" />
        <Stat l="Take-profit 1" v={fmt(s.tp1)} c="text-long" />
        <Stat l="Take-profit 2" v={fmt(s.tp2)} c="text-long" />
      </div>
    </div>
  );
}

function Chart({ s, p }: { s: Signal; p: Params }) {
  const c = s.candles;
  const a = analyze(c, p);
  const N = Math.min(100, c.length);
  const cl = c.slice(-N).map((x) => x.c), f = a.emaF.slice(-N), sl = a.emaS.slice(-N);
  const all = [...cl, ...f, ...sl];
  const lo = Math.min(...all), hi = Math.max(...all);
  const W = 600, H = 300, L = 60;
  const x = (i: number) => L + (i / (N - 1)) * (W - L - 10);
  const y = (v: number) => 10 + (1 - (v - lo) / (hi - lo || 1)) * (H - 30);
  const path = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * i) / 3);
  const lines: [number, string][] = [[s.entry, "var(--foreground)"], [s.sl, "var(--destructive)"], [s.tp1, "var(--primary)"], [s.tp2, "var(--primary)"]];
  return (
    <div className="rounded-xl border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold">{pair(s.sym)}</span>
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{s.tf}</span>
          <span className="rounded bg-primary/15 px-2 py-0.5 font-mono text-xs font-bold text-primary">{s.exchange}</span>
        </div>
        <div className="flex gap-3 text-xs">
          <span className="text-info">● Цена</span><span className="text-warn">● EMA {p.ema1}</span><span className="text-violet">● EMA {p.ema2}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--muted-foreground)">{fmt(t)}</text>
          </g>
        ))}
        {lines.map(([v, col], i) => v >= lo && v <= hi && <line key={i} x1={L} x2={W} y1={y(v)} y2={y(v)} stroke={col} strokeDasharray="4 4" opacity="0.6" />)}
        <path d={path(sl)} fill="none" stroke="var(--violet)" strokeWidth="1.5" />
        <path d={path(f)} fill="none" stroke="var(--warn)" strokeWidth="1.5" />
        <path d={path(cl)} fill="none" stroke="var(--info)" strokeWidth="1.8" />
      </svg>
    </div>
  );
}
