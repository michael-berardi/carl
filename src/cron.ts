// Five-field cron ("m h dom mon dow") plus "every <n><m|h|d>" and "@daily"/"@hourly", in the host's local time.

export type Schedule =
  | { kind: "cron"; fields: CronFields; source: string }
  | { kind: "every"; ms: number; source: string };

interface CronFields { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

export function parseSchedule(source: string): Schedule {
  const text = source.trim();
  const every = text.match(/^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2][0].toLowerCase();
    const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    if (n <= 0) throw new Error(`schedule "${source}": interval must be positive`);
    return { kind: "every", ms, source };
  }
  const expr = ALIASES[text.toLowerCase()] ?? text;
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) throw new Error(`schedule "${source}": expected 5 cron fields, "every <n>m|h|d", or @hourly/@daily/@weekly/@monthly`);
  const [mi, h, dom, mon, dow] = parts;
  return {
    kind: "cron",
    source,
    fields: {
      minute: field(mi, 0, 59, source, "minute"),
      hour: field(h, 0, 23, source, "hour"),
      dom: field(dom, 1, 31, source, "day of month"),
      month: field(mon, 1, 12, source, "month"),
      dow: new Set([...field(dow, 0, 7, source, "day of week")].map((d) => (d === 7 ? 0 : d))),
      domStar: dom === "*",
      dowStar: dow === "*",
    },
  };
}

function field(text: string, min: number, max: number, source: string, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`schedule "${source}": bad ${name} "${part}"`);
    const step = m[3] ? Number(m[3]) : 1;
    let lo = m[1] === "*" ? min : Number(m[1]);
    let hi = m[2] !== undefined ? Number(m[2]) : m[1] === "*" || m[3] ? max : lo;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`schedule "${source}": ${name} "${part}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Next run strictly after `after` (epoch ms). `anchor` is the last run, for interval schedules. */
export function nextRun(schedule: Schedule, after: number, anchor?: number): number {
  if (schedule.kind === "every") {
    const base = anchor ?? after;
    return base + schedule.ms > after ? base + schedule.ms : after + schedule.ms;
  }
  const f = schedule.fields;
  // Walk forward in absolute time (epoch ms), testing each local wall-clock minute. Stepping the epoch rather
  // than the wall clock keeps DST honest: the repeated autumn hour is visited twice in order, never re-entered
  // from the past, and the result is always strictly after `after`.
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = after + 366 * 86_400_000 * 5;
  while (t <= limit) {
    const d = new Date(t);
    if (!f.month.has(d.getMonth() + 1)) {
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      t = Math.max(next.getTime(), t + 60_000);
      continue;
    }
    const domOk = f.dom.has(d.getDate());
    const dowOk = f.dow.has(d.getDay());
    // Classic cron: when both day fields are restricted, either one matching is enough.
    const dayOk = f.domStar && f.dowStar ? true : f.domStar ? dowOk : f.dowStar ? domOk : domOk || dowOk;
    if (!dayOk) {
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      t = Math.max(next.getTime(), t + 60_000);
      continue;
    }
    if (!f.hour.has(d.getHours())) { t += (60 - d.getMinutes()) * 60_000; continue; }
    if (!f.minute.has(d.getMinutes())) { t += 60_000; continue; }
    if (t > after) return t;
    t += 60_000;
  }
  throw new Error(`schedule "${schedule.source}" never fires`);
}
