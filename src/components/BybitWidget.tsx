import { useEffect, useState } from "react";
import { fmt } from "@/lib/market";

type S = { sym: string; side: "LONG" | "SHORT"; price: number; sl: number; tp2: number; lev: number; atrPct: number };
const ORANGE = "var(--warn)";

export function BybitWidget({ s }: { s: S }) {
  const [margin, setMargin] = useState<"cross" | "iso">("cross");
  const [type, setType] = useState<"market" | "limit">("market");
  const [pct, setPct] = useState(25);
  const [tpsl, setTpsl] = useState(true);
  const [postOnly, setPostOnly] = useState(false);
  const [reduce, setReduce] = useState(false);
  const [tp, setTp] = useState(fmt(s.tp2));
  const [sl, setSl] = useState(fmt(s.sl));
  const [lev, setLev] = useState(s.lev);
  // Auto-fill leverage (and TP/SL) from the signal's volatility each time the active signal changes.
  useEffect(() => {
    setLev(s.lev);
    setTp(fmt(s.tp2));
    setSl(fmt(s.sl));
  }, [s.sym, s.side, s.price, s.lev, s.tp2, s.sl]);
  const balance = 1000;
  const cost = (balance * pct) / 100;
  const qty = (cost * lev) / s.price;
  const liq = s.side === "LONG" ? s.price * (1 - 1 / lev) : s.price * (1 + 1 / lev);
  const long = s.side === "LONG";

  const Seg = <T extends string>({ v, set, opts }: { v: T; set: (x: T) => void; opts: [T, string][] }) => (
    <div className="flex rounded-lg bg-secondary p-0.5 text-xs">
      {opts.map(([k, l]) => (
        <button key={k} onClick={() => set(k)} className={`flex-1 rounded-md px-2 py-1.5 ${v === k ? "bg-card font-semibold" : "text-muted-foreground"}`}>{l}</button>
      ))}
    </div>
  );
  const Check = ({ on, set, l }: { on: boolean; set: (v: boolean) => void; l: string }) => (
    <label className="flex cursor-pointer items-center gap-2 text-xs">
      <span onClick={() => set(!on)} className="grid h-4 w-4 place-items-center rounded border" style={on ? { background: ORANGE, borderColor: ORANGE } : {}}>{on && <span className="text-[10px] text-background">✓</span>}</span>
      <span onClick={() => set(!on)}>{l}</span>
    </label>
  );
  const Field = ({ l, v, set, unit }: { l: string; v: string; set?: (v: string) => void; unit: string }) => (
    <div className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2 text-sm">
      <span className="text-xs text-muted-foreground">{l}</span>
      <div className="flex items-center gap-1">
        <input value={v} readOnly={!set} onChange={(e) => set?.(e.target.value)} className="w-28 bg-transparent text-right font-mono outline-none" />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );

  return (
    <div className="w-full max-w-sm space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="font-semibold">{s.sym}USDT <span className="text-xs text-muted-foreground">Безстроковий</span></div>
        <span className="text-xs text-muted-foreground">ATR {s.atrPct.toFixed(2)}%</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Seg v={margin} set={setMargin} opts={[["cross", "Крос"], ["iso", "Ізольована"]]} />
        <div className="flex items-center justify-center gap-1 rounded-lg bg-secondary py-1.5 text-xs font-semibold" title={`Авто за волатильністю (ATR ${s.atrPct.toFixed(2)}%)`}>
          <input
            type="number" min={1} max={100} value={lev}
            onChange={(e) => setLev(Math.max(1, Math.min(100, +e.target.value || 1)))}
            className="w-10 bg-transparent text-center font-mono outline-none"
          />
          <span className="text-muted-foreground">x</span>
        </div>
      </div>
      <Seg v={type} set={setType} opts={[["market", "Ринковий"], ["limit", "Лімітний"]]} />
      <Field l="Ціна" v={type === "market" ? "Остання" : fmt(s.price)} unit="USDT" />
      <Field l="Кількість" v={qty.toFixed(4)} unit={s.sym} />
      <div className="px-1">
        <input type="range" min={0} max={100} step={25} value={pct} onChange={(e) => setPct(+e.target.value)} className="w-full" style={{ accentColor: ORANGE }} />
        <div className="flex justify-between text-[10px] text-muted-foreground">{[0, 25, 50, 75, 100].map((x) => <span key={x}>{x}%</span>)}</div>
      </div>
      <div className="flex justify-between text-xs"><span className="text-muted-foreground">Вартість USDT</span><span className="font-mono">{cost.toFixed(2)}</span></div>
      <Check on={tpsl} set={setTpsl} l="TP/SL" />
      {tpsl && (
        <div className="space-y-2">
          <Field l="Тейк-профіт" v={tp} set={setTp} unit="USDT" />
          <Field l="Стоп-лосс" v={sl} set={setSl} unit="USDT" />
        </div>
      )}
      <div className="flex gap-4">
        <Check on={postOnly} set={setPostOnly} l="Тільки розміщення" />
        <Check on={reduce} set={setReduce} l="Скорочення позиції" />
      </div>
      <div className="flex justify-between text-xs"><span className="text-muted-foreground">Ціна лікв.</span><span className="font-mono">{fmt(liq)}</span></div>
      <div className="grid grid-cols-2 gap-2">
        <button className={`rounded-lg py-2.5 font-semibold ${long ? "bg-long text-primary-foreground ring-2 ring-long" : "bg-long/20 text-long"}`}>Лонг</button>
        <button className={`rounded-lg py-2.5 font-semibold ${!long ? "bg-short text-foreground ring-2 ring-short" : "bg-short/20 text-short"}`}>Шорт</button>
      </div>
    </div>
  );
}
