// ── Stats ("Wrapped") panel ────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { BarChart3, ChevronLeft, ChevronRight, Clock, Disc3, Mic2, Music } from "lucide-react";
import {
  earliestBucket, onStatsChange, periodFor, statsFor,
  type PeriodKind, type PeriodStats,
} from "./stats";

interface ProjectLike {
  id: string;
  name: string;
  artist: string;
  coverDataUrl: string | null;
}

const TABS: { kind: PeriodKind; label: string }[] = [
  { kind: "day", label: "Daily" },
  { kind: "week", label: "Weekly" },
  { kind: "month", label: "Monthly" },
  { kind: "year", label: "Yearly" },
];

const RESET_NOTE: Record<PeriodKind, string> = {
  day: "Resets at midnight, your local time",
  week: "Updates Sundays at 9:00 PM, your local time",
  month: "Updates the 1st of each month at 9:00 PM",
  year: "Updates December 31 at 9:00 PM",
};

function fmtMinutes(ms: number): { value: string; unit: string } {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return { value: String(mins), unit: mins === 1 ? "minute" : "minutes" };
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return { value: `${h}h ${m}m`, unit: "listened" };
}

const minsOf = (ms: number) => Math.max(ms >= 30000 ? 1 : 0, Math.round(ms / 60000));

function Rank({ i }: { i: number }) {
  return (
    <span className="w-6 shrink-0 text-center text-sm font-extrabold tabular-nums text-muted-foreground/60">
      {i + 1}
    </span>
  );
}

function Cover({ src, fallback }: { src?: string | null; fallback: React.ReactNode }) {
  return (
    <div className="w-11 h-11 rounded-lg overflow-hidden bg-secondary border border-border shrink-0 flex items-center justify-center">
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : fallback}
    </div>
  );
}

function RankList({ title, icon, rows, empty }: {
  title: string;
  icon: React.ReactNode;
  rows: { key: string; primary: string; secondary?: string; meta: string; cover?: string | null; fallback: React.ReactNode; pct: number }[];
  empty: string;
}) {
  return (
    <section className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground/70 py-4">{empty}</p>
      ) : (
        <ul className="stagger-children space-y-1.5">
          {rows.map((r, i) => (
            <li key={r.key} className="relative flex items-center gap-3 p-2 rounded-lg overflow-hidden">
              <div className="absolute inset-y-0 left-0 bg-primary/10 rounded-lg transition-all duration-500"
                style={{ width: `${Math.max(6, r.pct * 100)}%` }} />
              <Rank i={i} />
              <Cover src={r.cover} fallback={r.fallback} />
              <div className="relative min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{r.primary}</p>
                {r.secondary && <p className="text-xs text-muted-foreground truncate">{r.secondary}</p>}
              </div>
              <span className="relative text-xs font-semibold text-muted-foreground tabular-nums shrink-0">{r.meta}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function StatsPanel({ projects }: { projects: ProjectLike[] }) {
  const [kind, setKind] = useState<PeriodKind>("day");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<PeriodStats | null>(null);
  const [earliest, setEarliest] = useState<Date | null>(null);

  const period = useMemo(() => periodFor(kind, offset), [kind, offset]);

  const load = useCallback(() => {
    let alive = true;
    void statsFor(period).then(d => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [period]);

  useEffect(() => load(), [load]);
  useEffect(() => onStatsChange(() => load()), [load]);
  useEffect(() => { void earliestBucket().then(setEarliest); }, [data]);

  useEffect(() => { setOffset(0); }, [kind]);

  const coverFor = (projectId: string) => projects.find(p => p.id === projectId)?.coverDataUrl ?? null;
  const canGoBack = !earliest || periodFor(kind, offset + 1).end > earliest;

  const total = fmtMinutes(data?.ms ?? 0);
  const songs = (data?.songs ?? []).slice(0, 5);
  const albums = (data?.albums ?? []).slice(0, 5);
  const artists = (data?.artists ?? []).slice(0, 5);
  const maxSong = songs[0] ? Math.max(songs[0].plays, 1) : 1;
  const maxAlbum = albums[0]?.ms || 1;
  const maxArtist = artists[0]?.ms || 1;
  const peakDay = (data?.daily ?? []).reduce((m, d) => (d.ms > (m?.ms ?? 0) ? d : m), null as { date: Date; ms: number } | null);

  return (
    <section className="mb-12">
      <div className="flex items-center gap-2 mb-5">
        <BarChart3 size={13} className="text-muted-foreground" />
        <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Stats</h2>
      </div>

      {/* Period tabs */}
      <div className="flex items-center gap-1 p-1 bg-secondary rounded-full w-fit mb-4">
        {TABS.map(t => (
          <button key={t.kind} onClick={() => setKind(t.kind)}
            className={`relative px-4 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              kind === t.kind ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {kind === t.kind && (
              <motion.span layoutId="stats-tab" className="absolute inset-0 rounded-full bg-primary"
                transition={{ type: "spring", stiffness: 420, damping: 34 }} />
            )}
            <span className="relative">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Summary card */}
      <div className="relative overflow-hidden bg-card border border-border rounded-xl p-5 mb-4">
        <div className="absolute -top-20 -right-16 w-64 h-64 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
        <div className="relative flex items-center justify-between gap-4 mb-4">
          <button onClick={() => canGoBack && setOffset(o => o + 1)} disabled={!canGoBack}
            className="p-2 rounded-full hover:bg-secondary text-muted-foreground disabled:opacity-30"
            aria-label="Previous period">
            <ChevronLeft size={16} />
          </button>
          <div className="text-center min-w-0">
            <p className="text-xs font-semibold text-muted-foreground truncate">{period.label}</p>
            <p className="text-[11px] text-muted-foreground/60 truncate">{RESET_NOTE[kind]}</p>
          </div>
          <button onClick={() => setOffset(o => Math.max(0, o - 1))} disabled={offset === 0}
            className="p-2 rounded-full hover:bg-secondary text-muted-foreground disabled:opacity-30"
            aria-label="Next period">
            <ChevronRight size={16} />
          </button>
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={`${kind}-${offset}`}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="relative text-center">
            <p className="text-5xl font-extrabold tracking-tight tabular-nums">{total.value}</p>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mt-1">{total.unit}</p>
            <div className="flex items-center justify-center gap-5 mt-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><Music size={11} />{data?.songs.reduce((s, x) => s + x.plays, 0) ?? 0} plays</span>
              <span className="flex items-center gap-1.5"><Mic2 size={11} />{artists.length ? `${data?.artists.length} artists` : "0 artists"}</span>
              {kind !== "day" && peakDay && (
                <span className="flex items-center gap-1.5"><Clock size={11} />
                  Peak {peakDay.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {minsOf(peakDay.ms)}m
                </span>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={`lists-${kind}-${offset}`}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="grid gap-4 md:grid-cols-3">
          <RankList title="Top Songs" icon={<Music size={13} />} empty="No songs played yet."
            rows={songs.map(s => ({
              key: s.key,
              primary: s.name,
              secondary: s.artist || "Unknown Artist",
              meta: `${s.plays} ${s.plays === 1 ? "play" : "plays"}`,
              cover: coverFor(s.projectId),
              fallback: <Music size={16} className="text-muted-foreground/40" />,
              pct: s.plays / maxSong,
            }))} />
          <RankList title="Top Albums" icon={<Disc3 size={13} />} empty="No albums played yet."
            rows={albums.map(a => ({
              key: a.id,
              primary: a.name,
              secondary: a.artist || "Unknown Artist",
              meta: `${minsOf(a.ms)} min`,
              cover: coverFor(a.id),
              fallback: <Disc3 size={16} className="text-muted-foreground/40" />,
              pct: a.ms / maxAlbum,
            }))} />
          <RankList title="Top Artists" icon={<Mic2 size={13} />} empty="No artists played yet."
            rows={artists.map(a => ({
              key: a.name,
              primary: a.name,
              meta: `${minsOf(a.ms)} min`,
              cover: projects.find(p => (p.artist || "Unknown Artist") === a.name)?.coverDataUrl ?? null,
              fallback: <Mic2 size={16} className="text-muted-foreground/40" />,
              pct: a.ms / maxArtist,
            }))} />
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
