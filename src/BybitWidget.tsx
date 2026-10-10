import { useEffect, useState } from "react";
import { fmt } from "@/lib/market";
import { credentialsStorageKey, decryptCredentials, encryptCredentials, placeLinearMarketOrder, type ApiCredentials, type EncryptedCredentials } from "@/lib/bybit-trading";

type S = { sym: string; side: "LONG" | "SHORT"; price: number; sl: number; tp2: number; lev: number; atrPct: number };
const ORANGE = "var(--warn)";

export function BybitWidget({ s }: { s: S }) {
  const [margin, setMargin] = useState<"cross" | "iso">("cross");
  const [type, setType] = useState<"market" | "limit">("market");
  const [pct, setPct] = useState(25);
  const [marginAmount, setMarginAmount] = useState("250.00");
  const [tpsl, setTpsl] = useState(true);
  const [postOnly, setPostOnly] = useState(false);
  const [reduce, setReduce] = useState(false);
  const [tp, setTp] = useState(fmt(s.tp2));
  const [sl, setSl] = useState(fmt(s.sl));
  const [lev, setLev] = useState(s.lev);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [storagePassword, setStoragePassword] = useState("");
  const [credentials, setCredentials] = useState<ApiCredentials | null>(null);
  const [hasSavedCredentials, setHasSavedCredentials] = useState(false);
  const [tradeStatus, setTradeStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setHasSavedCredentials(Boolean(localStorage.getItem(credentialsStorageKey)));
  }, []);
  // Auto-fill leverage (and TP/SL) from the signal's volatility each time the active signal changes.
  useEffect(() => {
    setLev(s.lev);
    setTp(fmt(s.tp2));
    setSl(fmt(s.sl));
  }, [s.sym, s.side, s.price, s.lev, s.tp2, s.sl]);
  const balance = 1000;
  const parsedMargin = Number(marginAmount);
  const cost = Number.isFinite(parsedMargin) && parsedMargin > 0 ? parsedMargin : 0;
  const qty = (cost * lev) / s.price;
  const liq = s.side === "LONG" ? s.price * (1 - 1 / lev) : s.price * (1 + 1 / lev);
  const long = s.side === "LONG";

  const saveCredentials = async () => {
    if (!apiKey.trim() || !apiSecret.trim() || storagePassword.length < 12) {
      setTradeStatus("Укажите API Key, API Secret и пароль шифрования не короче 12 символов.");
      return;
    }
    try {
      const encrypted = await encryptCredentials({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() }, storagePassword);
      localStorage.setItem(credentialsStorageKey, JSON.stringify(encrypted));
      setCredentials({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() });
      setHasSavedCredentials(true);
      setApiSecret("");
      setStoragePassword("");
      setTradeStatus("Ключи сохранены в зашифрованном виде и доступны до закрытия или обновления страницы.");
    } catch (error) {
      setTradeStatus(error instanceof Error ? error.message : "Не удалось зашифровать ключи.");
    }
  };

  const unlockCredentials = async () => {
    try {
      const encrypted = JSON.parse(localStorage.getItem(credentialsStorageKey) ?? "null") as EncryptedCredentials | null;
      if (!encrypted) throw new Error("Зашифрованные ключи не найдены.");
      setCredentials(await decryptCredentials(encrypted, storagePassword));
      setStoragePassword("");
      setTradeStatus("Ключи разблокированы до закрытия или обновления страницы.");
    } catch {
      setTradeStatus("Не удалось разблокировать ключи. Проверьте пароль шифрования.");
    }
  };

  const openTrade = async () => {
    if (!credentials) {
      setTradeStatus("Сначала сохраните или разблокируйте API-ключи.");
      return;
    }
    if (cost <= 0 || !Number.isFinite(qty)) {
      setTradeStatus("Введите сумму маржи больше нуля.");
      return;
    }
    const takeProfit = Number(tp);
    const stopLoss = Number(sl);
    if (tpsl && (!Number.isFinite(takeProfit) || !Number.isFinite(stopLoss) || takeProfit <= 0 || stopLoss <= 0 || (long ? takeProfit <= s.price || stopLoss >= s.price : takeProfit >= s.price || stopLoss <= s.price))) {
      setTradeStatus("Проверьте уровни TP/SL: они должны находиться по правильную сторону от цены сигнала.");
      return;
    }
    setBusy(true);
    setTradeStatus("Отправка Market-ордера в Bybit...");
    try {
      const result = await placeLinearMarketOrder(credentials, {
        symbol: s.sym,
        side: s.side,
        qty,
        leverage: lev,
        ...(tpsl ? { takeProfit, stopLoss } : {}),
      });
      setTradeStatus(`Ордер принят: ${result.symbol}, ${result.qty} ${s.sym}. ID: ${result.orderId}`);
    } catch (error) {
      setTradeStatus(error instanceof Error ? error.message : "Не удалось отправить ордер.");
    } finally {
      setBusy(false);
    }
  };

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
        <div title="Режим маржі для розрахунку; API використовує налаштування акаунта Bybit.">
          <Seg v={margin} set={setMargin} opts={[["cross", "Крос · расчет"], ["iso", "Изолированная · расчет"]]} />
          <p className="mt-1 text-[10px] text-muted-foreground">Лише для розрахунку, налаштування Bybit не змінюються.</p>
        </div>
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
        <input type="range" min={0} max={100} step={0.1} value={pct} onChange={(e) => {
          const nextPct = Number(e.target.value);
          setPct(nextPct);
          setMarginAmount(((balance * nextPct) / 100).toFixed(2));
        }} className="w-full" style={{ accentColor: ORANGE }} />
        <div className="flex justify-between text-[10px] text-muted-foreground">{[0, 25, 50, 75, 100].map((x) => <span key={x}>{x}%</span>)}</div>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2 text-sm">
        <label htmlFor="margin-amount" className="text-xs text-muted-foreground">Вартість USDT</label>
        <div className="flex items-center gap-1">
          <input
            id="margin-amount"
            type="number"
            min="0"
            step="any"
            value={marginAmount}
            onChange={(e) => {
              const value = e.target.value;
              setMarginAmount(value);
              const amount = Number(value);
              if (value === "") setPct(0);
              else if (Number.isFinite(amount)) setPct(Math.max(0, Math.min(100, (amount / balance) * 100)));
            }}
            className="w-28 bg-transparent text-right font-mono outline-none"
          />
          <span className="text-xs text-muted-foreground">USDT</span>
        </div>
      </div>
      <p className="-mt-2 text-[10px] text-muted-foreground">Цільова маржа; фактична сума може трохи відрізнятися через крок кількості та ціну виконання Market-ордера.</p>
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
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-semibold">API-ключи Bybit {credentials ? "· разблокированы" : hasSavedCredentials ? "· сохранены" : "· не настроены"}</summary>
        <div className="mt-3 space-y-2">
          {!hasSavedCredentials && <input autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key" className="w-full rounded-md bg-secondary px-3 py-2 text-sm outline-none" />}
          {!hasSavedCredentials && <input type="password" autoComplete="new-password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder="API Secret" className="w-full rounded-md bg-secondary px-3 py-2 text-sm outline-none" />}
          {!credentials && <input type="password" autoComplete="new-password" value={storagePassword} onChange={(e) => setStoragePassword(e.target.value)} placeholder={hasSavedCredentials ? "Пароль шифрования" : "Пароль шифрования (12+ символов)"} className="w-full rounded-md bg-secondary px-3 py-2 text-sm outline-none" />}
          {!credentials && <button onClick={hasSavedCredentials ? unlockCredentials : saveCredentials} className="w-full rounded-md border py-2 text-sm font-semibold">{hasSavedCredentials ? "Разблокировать ключи" : "Зашифровать и сохранить"}</button>}
          {credentials && <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setCredentials(null)} className="rounded-md border py-2 text-sm">Заблокировать</button>
            <button onClick={() => {
              localStorage.removeItem(credentialsStorageKey);
              setCredentials(null);
              setHasSavedCredentials(false);
              setTradeStatus("Збережені ключі видалено з цього браузера.");
            }} className="rounded-md border py-2 text-sm">Удалить ключи</button>
          </div>}
          <p className="text-xs text-muted-foreground">Ключи шифруются паролем в браузере. Используйте API-ключ только с правом торговли, без вывода средств; XSS и расширения браузера всё ещё могут получить разблокированный ключ.</p>
        </div>
      </details>
      <button onClick={openTrade} disabled={busy} className="w-full rounded-lg bg-primary px-3 py-3 text-sm font-bold text-primary-foreground disabled:cursor-wait disabled:opacity-60">
        {busy ? "Отправка ордера..." : "Открыть сделку в 1 клик"}
      </button>
      <p className="text-xs font-semibold text-destructive">Основная сеть Bybit: будет отправлен реальный рыночный ордер.</p>
      <p aria-live="polite" className="break-words text-xs text-muted-foreground">{tradeStatus || "Bybit V5 · Market · линейный USDT-контракт · One-Way · маржа из настроек Bybit"}</p>
    </div>
  );
}
