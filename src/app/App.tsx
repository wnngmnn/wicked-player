import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  Plus, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  Share2, Upload, Edit2, Trash2, Check, X, ChevronLeft,
  Music, Shuffle, ImagePlus, Link2, ListMusic,
  Library, User, Settings, PanelLeftClose, PanelLeftOpen, Home,
  Search, GripVertical, LayoutList, Maximize2, ChevronDown, ArrowUpDown,
  Heart, Star, Globe, Lock, Unlock, Calendar
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

interface Track {
  id: string;
  name: string;
  audioKey: string;
  duration: number;
}

interface Project {
  id: string;
  name: string;
  artist: string;
  coverDataUrl: string | null;
  tracks: Track[];
  createdAt: number;
  isSingle?: boolean;
  isPublic?: boolean;
}

interface QueueItem {
  projectId: string;
  trackIndex: number;
}

interface PlaylistItem {
  projectId: string;
  trackId: string;
  addedAt: number;
}

interface Playlist {
  id: string;
  name: string;
  coverDataUrl: string | null;
  items: PlaylistItem[];
  createdAt: number;
  isPublic?: boolean;
}

interface LikedSong { projectId: string; trackId: string; likedAt: number; }
interface FavoriteItem { type: "album" | "playlist"; id: string; savedAt: number; }

interface Folder {
  id: string;
  name: string;
  projectIds: string[];
  createdAt: number;
}

// Module-level drag store — avoids React state lag during drag events
const _drag = {
  type: null as "project" | null,
  projectId: "" as string,
  fromFolderId: null as string | null,
};

// Apple Music-style double-triangle previous / next icons
function IconPrev({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M20 7 Q20 5 18 6 L14 11 Q13 12 14 13 L18 18 Q20 19 20 17 Z M13 7 Q13 5 11 6 L7 11 Q6 12 7 13 L11 18 Q13 19 13 17 Z" />
    </svg>
  );
}
function IconNext({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M4 7 Q4 5 6 6 L10 11 Q11 12 10 13 L6 18 Q4 19 4 17 Z M11 7 Q11 5 13 6 L17 11 Q18 12 17 13 L13 18 Q11 19 11 17 Z" />
    </svg>
  );
}

// ── Custom Theme & Visualizer types ────────────────────────────────────────
type FontOption = "system" | "inter" | "roboto" | "poppins" | "space-grotesk" | "dm-sans" | "nunito" | "jetbrains-mono";

interface CustomThemeConfig {
  backgroundUrl: string | null;
  backgroundBlur: number;    // 0-60
  backgroundOpacity: number; // 0-100
  glassBlur: number;         // 10-80
  fontFamily: FontOption;
}

interface SavedCustomTheme {
  id: string;
  name: string;
  accent: string;
  mode: "dark" | "light";
  config: CustomThemeConfig;
  createdAt: number;
}

interface VisualizerConfig {
  enabled: boolean;
  style: "bars" | "waveform" | "circular" | "dots" | "theme";
  intensity: number; // 0-100
  opacity: number;   // 10-100
}

interface PlayerState {
  projectId: string | null;
  trackIndex: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  queue: QueueItem[];
  queuePos: number;
}

type SidebarTab = "home" | "library" | "playlists" | "liked" | "favorites" | "profile" | "settings";

// ── IndexedDB ──────────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("melodia_v1", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("audio"))
        req.result.createObjectStore("audio");
    };
    req.onsuccess = () => { _db = req.result; resolve(_db!); };
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key: string, val: Blob): Promise<void> {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("audio", "readwrite");
    tx.objectStore("audio").put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function dbGet(key: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("audio", "readonly");
    const req = tx.objectStore("audio").get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror = () => rej(req.error);
  });
}

async function dbDel(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("audio", "readwrite");
    tx.objectStore("audio").delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ── Utils ──────────────────────────────────────────────────────────────────

const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// Shuffle helper — never picks the same position as current
function shuffleNext(queue: QueueItem[], currentPos: number): number {
  if (queue.length <= 1) return 0;
  let idx: number;
  let tries = 0;
  do { idx = Math.floor(Math.random() * queue.length); tries++; }
  while (idx === currentPos && tries < 20);
  return idx;
}

const fmt = (s: number) => {
  if (!isFinite(s) || isNaN(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

function loadProjects(): Project[] {
  try { return JSON.parse(localStorage.getItem("melodia_projects") || "[]"); }
  catch { return []; }
}
function safeSetItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.error("localStorage write failed", err);
    if (typeof window !== "undefined") {
      const msg = (err as { name?: string })?.name === "QuotaExceededError"
        ? "Storage is full. Try using a smaller cover image or removing unused projects."
        : "Failed to save changes to browser storage.";
      // Fire once, non-blocking
      queueMicrotask(() => { try { window.alert(msg); } catch {} });
    }
  }
}
function saveProjects(p: Project[]) {
  safeSetItem("melodia_projects", JSON.stringify(p));
}

function loadPlaylists(): Playlist[] {
  try { return JSON.parse(localStorage.getItem("melodia_playlists") || "[]"); }
  catch { return []; }
}
function savePlaylists(p: Playlist[]) {
  safeSetItem("melodia_playlists", JSON.stringify(p));
}

function loadLikedSongs(): LikedSong[] { try { return JSON.parse(localStorage.getItem("melodia_liked") || "[]"); } catch { return []; } }
function saveLikedSongs(s: LikedSong[]) { safeSetItem("melodia_liked", JSON.stringify(s)); }
function loadFavorites(): FavoriteItem[] { try { return JSON.parse(localStorage.getItem("melodia_favorites") || "[]"); } catch { return []; } }
function saveFavorites(f: FavoriteItem[]) { safeSetItem("melodia_favorites", JSON.stringify(f)); }
function loadFolders(): Folder[] { try { return JSON.parse(localStorage.getItem("melodia_folders") || "[]"); } catch { return []; } }
function saveFolders(f: Folder[]) { safeSetItem("melodia_folders", JSON.stringify(f)); }


function parseRoute() {
  const h = window.location.hash.slice(1) || "/";
  if (h.startsWith("/share/")) return { page: "share" as const, id: h.slice(7) };
  if (h.startsWith("/project/")) return { page: "project" as const, id: h.slice(9) };
  return { page: "home" as const, id: undefined };
}

const MAX_COVER_INPUT_BYTES = 40 * 1024 * 1024; // 40MB hard cap
const MAX_GIF_STORED_BYTES = 6 * 1024 * 1024; // GIFs are stored as-is; keep small

async function decodeImage(file: File): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number) => void; close: () => void }> {
  // Prefer createImageBitmap (streams, handles huge files, off main thread)
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, dx, dy, dw, dh) => ctx.drawImage(bitmap, dx, dy, dw, dh),
        close: () => { try { bitmap.close(); } catch {} },
      };
    } catch (err) {
      console.warn("createImageBitmap failed, falling back to <img>", err);
    }
  }
  // Fallback: <img> + object URL
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Image failed to decode (unsupported format?)"));
      el.src = url;
    });
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      draw: (ctx, dx, dy, dw, dh) => ctx.drawImage(img, dx, dy, dw, dh),
      close: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

async function resizeCover(file: File): Promise<string> {
  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("Empty image dimensions");
    // Target square size: scale down when source is small; cap at 1400.
    const target = Math.min(1400, Math.max(decoded.width, decoded.height));
    const canvas = document.createElement("canvas");
    canvas.width = target; canvas.height = target;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const r = Math.max(target / decoded.width, target / decoded.height);
    const w = decoded.width * r, h = decoded.height * r;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, target, target);
    decoded.draw(ctx, (target - w) / 2, (target - h) / 2, w, h);
    // Progressive quality: shrink until under ~600KB to keep localStorage happy
    let quality = 0.92;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > 800_000 && quality > 0.5) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    if (!dataUrl || dataUrl === "data:,") throw new Error("Canvas export failed");
    return dataUrl;
  } finally {
    decoded.close();
  }
}

async function processCover(file: File): Promise<string> {
  if (file.size > MAX_COVER_INPUT_BYTES) {
    window.alert(`That image is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Please pick one under 40 MB.`);
    return "";
  }
  try {
    if (file.type === "image/gif") {
      if (file.size > MAX_GIF_STORED_BYTES) {
        window.alert(`This GIF is ${(file.size / 1024 / 1024).toFixed(1)} MB — too large to store. Please use one under 6 MB, or convert to a static image.`);
        return "";
      }
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read GIF"));
        reader.readAsDataURL(file);
      });
    }
    return await resizeCover(file);
  } catch (err) {
    console.error("Cover upload failed", err);
    const msg = (err as Error)?.message || "Unknown error";
    window.alert(`Couldn't use that image: ${msg}. Try a different file (JPG or PNG under 40 MB).`);
    return "";
  }
}

function getAudioDuration(file: File): Promise<number> {
  return new Promise(resolve => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(isFinite(a.duration) ? a.duration : 0); };
    a.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    a.src = url;
  });
}


async function sampleCoverColor(dataUrl: string): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = 8;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 8, 8);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      let r=0,g=0,b=0,count=0;
      for (let i=0;i<d.length;i+=4) {
        const lum=(d[i]+d[i+1]+d[i+2])/3;
        if(lum>30&&lum<230){r+=d[i];g+=d[i+1];b+=d[i+2];count++;}
      }
      resolve(count>0?`${Math.round(r/count)},${Math.round(g/count)},${Math.round(b/count)}`:"20,20,40");
    };
    img.onerror=()=>resolve("20,20,40");
    img.src=dataUrl;
  });
}

// ── Theme system ───────────────────────────────────────────────────────────

interface GradientStop {
  color: string;
  position: number; // 0-100
}

type LayoutTheme = "default" | "modern" | "classic" | "unique";

// Fullscreen background animation config
type FsBgMode = "movement" | "visualizer" | "custom";

interface FsBgConfig {
  enabled: boolean;
  mode: FsBgMode;
  customUrl: string | null;       // user-uploaded image/GIF
  customFit: "fill" | "fit" | "center" | "stretch";
  customBlur: number;             // 0-80 blur for custom bg
  intensity: number;              // 0-100, movement speed or visualizer intensity
}

const DEFAULT_FS_BG: FsBgConfig = {
  enabled: false,
  mode: "movement",
  customUrl: null,
  customFit: "fill",
  customBlur: 0,
  intensity: 50,
};

interface AppTheme {
  mode: "dark" | "light";
  accent: string;
  layoutTheme: LayoutTheme;
  gradient: { enabled: boolean; stops: GradientStop[]; angle: number; };
  custom: CustomThemeConfig;
  visualizer: VisualizerConfig;
  fsBg: FsBgConfig;
  colorOverrides: Record<string, string>; // persistent per-variable color overrides
}

const FONT_MAP: Record<FontOption, { label: string; css: string; googleUrl?: string }> = {
  "system":        { label: "System Default",   css: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif" },
  "inter":         { label: "Inter",             css: "'Inter', sans-serif",          googleUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" },
  "roboto":        { label: "Roboto",            css: "'Roboto', sans-serif",         googleUrl: "https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" },
  "poppins":       { label: "Poppins",           css: "'Poppins', sans-serif",        googleUrl: "https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" },
  "space-grotesk": { label: "Space Grotesk",     css: "'Space Grotesk', sans-serif",  googleUrl: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" },
  "dm-sans":       { label: "DM Sans",           css: "'DM Sans', sans-serif",        googleUrl: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap" },
  "nunito":        { label: "Nunito",            css: "'Nunito', sans-serif",         googleUrl: "https://fonts.googleapis.com/css2?family=Nunito:wght@300;400;500;600;700;800&display=swap" },
  "jetbrains-mono":{ label: "JetBrains Mono",   css: "'JetBrains Mono', monospace",  googleUrl: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap" },
};

const DEFAULT_CUSTOM_CONFIG: CustomThemeConfig = {
  backgroundUrl: null,
  backgroundBlur: 0,
  backgroundOpacity: 60,
  glassBlur: 40,
  fontFamily: "system",
};

const DEFAULT_VISUALIZER: VisualizerConfig = {
  enabled: false,
  style: "bars",
  intensity: 70,
  opacity: 65,
};

function loadSavedCustomThemes(): SavedCustomTheme[] {
  try { return JSON.parse(localStorage.getItem("melodia_saved_themes") || "[]"); }
  catch { return []; }
}
function saveSavedCustomThemes(t: SavedCustomTheme[]) {
  localStorage.setItem("melodia_saved_themes", JSON.stringify(t));
}
function loadVisualizerConfig(): VisualizerConfig {
  try { return { ...DEFAULT_VISUALIZER, ...JSON.parse(localStorage.getItem("melodia_visualizer") || "null") }; }
  catch { return DEFAULT_VISUALIZER; }
}
function saveVisualizerConfig(v: VisualizerConfig) {
  localStorage.setItem("melodia_visualizer", JSON.stringify(v));
}

function applyCustomThemeConfig(config: CustomThemeConfig, accent: string) {
  const root = document.documentElement;
  // Font
  const fontInfo = FONT_MAP[config.fontFamily] ?? FONT_MAP["system"];
  root.style.setProperty("--custom-font", fontInfo.css);
  if (fontInfo.googleUrl) {
    let link = document.getElementById("melodia-gfont") as HTMLLinkElement | null;
    if (!link) { link = document.createElement("link"); link.id = "melodia-gfont"; link.rel = "stylesheet"; document.head.appendChild(link); }
    link.href = fontInfo.googleUrl;
  }
  // Glass blur
  root.style.setProperty("--custom-glass-blur", `${config.glassBlur}px`);
  root.style.setProperty("--custom-bg-blur", `${config.backgroundBlur}px`);
  root.style.setProperty("--custom-bg-opacity", `${1 - config.backgroundOpacity / 100}`);
  // Inject custom-specific CSS overrides
  let el = document.getElementById("melodia-custom-css") as HTMLStyleElement | null;
  if (!el) { el = document.createElement("style"); el.id = "melodia-custom-css"; document.head.appendChild(el); }
  const hasBackground = !!config.backgroundUrl;
  el.textContent = `
    :root { font-family: var(--custom-font, system-ui) !important; }
    body { font-family: var(--custom-font, system-ui) !important; }
    ${hasBackground ? `
    .melodia-bg-layer::before {
      content:''; position:fixed; inset:0; z-index:-1;
      background-image:url('${config.backgroundUrl}');
      background-size:cover; background-position:center;
      filter:blur(var(--custom-bg-blur,0px));
      transform:scale(1.1);
    }
    .melodia-bg-layer::after {
      content:''; position:fixed; inset:0; z-index:-1;
      background:rgba(0,0,0,var(--custom-bg-opacity,0.6));
    }
    ` : ""}
  `;
}

// ── Layout theme CSS ───────────────────────────────────────────────────────

const LAYOUT_THEME_CSS: Record<LayoutTheme, string> = {
  default: `
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 9999px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
  `,

  modern: `
    /* ══════════════════════════════════════════════════════════════
       LIQUID GLASS — iOS 26 / visionOS refractive glass
    ══════════════════════════════════════════════════════════════ */
    :root { --radius: 1.75rem; }

    @keyframes lgFloat {
      0%,100% { transform: translate3d(0,0,0) scale(1); }
      50%     { transform: translate3d(2%,-1%,0) scale(1.05); }
    }
    @keyframes lgShimmer {
      0%   { background-position: 0% 50%; }
      100% { background-position: 200% 50%; }
    }

    /* Ambient chromatic aurora — visible in dark mode, dialed way back in light */
    body {
      position: relative;
    }
    body::before {
      content: '';
      position: fixed; inset: -20%;
      pointer-events: none; z-index: 0;
      background:
        radial-gradient(40% 55% at 12% 18%, color-mix(in srgb,var(--primary) 32%,transparent) 0%, transparent 70%),
        radial-gradient(35% 50% at 88% 82%, rgba(120,180,255,0.25) 0%, transparent 70%),
        radial-gradient(45% 45% at 60% 5%,  rgba(255,140,220,0.18) 0%, transparent 70%),
        radial-gradient(50% 40% at 5% 95%,  rgba(120,255,220,0.14) 0%, transparent 70%);
      filter: blur(80px) saturate(140%);
      animation: lgFloat 24s ease-in-out infinite;
    }
    [data-mode="light"] body::before {
      opacity: 0.55;
      filter: blur(90px) saturate(120%);
    }

    .bg-background {
      background: transparent !important;
    }
    :root { background: #030308; }
    [data-mode="light"]:root { background: #eef1f6; }

    /* Core glass surface */
    .bg-card {
      background: color-mix(in srgb, var(--card) 42%, transparent) !important;
      backdrop-filter: blur(56px) saturate(220%) brightness(1.06) !important;
      -webkit-backdrop-filter: blur(56px) saturate(220%) brightness(1.06) !important;
      border: 1px solid color-mix(in srgb, var(--foreground) 12%, transparent) !important;
      box-shadow:
        0 1px 0 0 color-mix(in srgb, var(--foreground) 18%, transparent) inset,
        0 -1px 0 0 color-mix(in srgb, var(--background) 40%, transparent) inset,
        0 20px 60px -20px rgba(0,0,0,0.55),
        0 8px 24px -12px rgba(0,0,0,0.4) !important;
      position: relative !important;
    }
    /* Specular sheen along the top edge — signature liquid-glass tell */
    .bg-card::before {
      content: '';
      position: absolute; inset: 0;
      border-radius: inherit;
      pointer-events: none;
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--foreground) 14%, transparent) 0%,
        transparent 22%,
        transparent 78%,
        color-mix(in srgb, var(--background) 30%, transparent) 100%);
      mix-blend-mode: overlay;
      opacity: 0.9;
    }
    [data-mode="light"] .bg-card {
      background: rgba(255,255,255,0.55) !important;
      border-color: rgba(255,255,255,0.9) !important;
      box-shadow:
        0 1px 0 0 rgba(255,255,255,0.9) inset,
        0 -1px 0 0 rgba(0,0,0,0.05) inset,
        0 22px 60px -24px rgba(30,50,90,0.25),
        0 10px 24px -14px rgba(30,50,90,0.18) !important;
    }

    .bg-popover, [class*="bg-popover"] {
      background: color-mix(in srgb, var(--popover) 55%, transparent) !important;
      backdrop-filter: blur(88px) saturate(260%) !important;
      -webkit-backdrop-filter: blur(88px) saturate(260%) !important;
      border: 1px solid color-mix(in srgb, var(--foreground) 14%, transparent) !important;
      box-shadow:
        0 1px 0 color-mix(in srgb, var(--foreground) 20%, transparent) inset,
        0 40px 100px -20px rgba(0,0,0,0.55) !important;
    }

    .bg-sidebar {
      background: color-mix(in srgb, var(--sidebar) 40%, transparent) !important;
      backdrop-filter: blur(96px) saturate(240%) !important;
      -webkit-backdrop-filter: blur(96px) saturate(240%) !important;
      border-right: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent) !important;
      position: relative !important;
    }
    .bg-sidebar::after {
      content: '';
      position: absolute; top: 0; right: 0; bottom: 0; width: 1px;
      background: linear-gradient(180deg, transparent, color-mix(in srgb,var(--foreground) 18%, transparent), transparent);
      pointer-events: none;
    }

    .bg-secondary {
      background: color-mix(in srgb, var(--foreground) 7%, transparent) !important;
      backdrop-filter: blur(32px) !important;
      -webkit-backdrop-filter: blur(32px) !important;
      border: 1px solid color-mix(in srgb, var(--foreground) 10%, transparent) !important;
    }
    .bg-muted { background: color-mix(in srgb, var(--foreground) 4%, transparent) !important; }
    .border-border, .divide-border>*+* { border-color: color-mix(in srgb, var(--foreground) 12%, transparent) !important; }

    .sticky {
      background: color-mix(in srgb, var(--background) 45%, transparent) !important;
      backdrop-filter: blur(72px) saturate(220%) !important;
      -webkit-backdrop-filter: blur(72px) saturate(220%) !important;
      border-bottom: 1px solid color-mix(in srgb, var(--foreground) 9%, transparent) !important;
    }

    /* Continuous, softer radii — signature */
    .rounded-sm  { border-radius: 0.875rem !important; }
    .rounded-md  { border-radius: 1.25rem  !important; }
    .rounded-lg  { border-radius: 1.75rem  !important; }
    .rounded-xl  { border-radius: 2.25rem  !important; }
    .rounded-2xl { border-radius: 2.75rem  !important; }
    .rounded-3xl { border-radius: 3.5rem   !important; }

    /* Primary action = pill of glass with iridescent shimmer */
    .bg-primary:not([class*="bg-primary/"]):not(.text-primary) {
      border-radius: 9999px !important;
      background:
        linear-gradient(135deg,
          color-mix(in srgb,var(--primary) 95%,#fff) 0%,
          var(--primary) 45%,
          color-mix(in srgb,var(--primary) 82%,#000) 100%) !important;
      background-size: 200% 100% !important;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.5) inset,
        0 -6px 12px -6px rgba(0,0,0,0.35) inset,
        0 12px 32px -8px color-mix(in srgb,var(--primary) 55%,transparent),
        0 4px 12px -4px rgba(0,0,0,0.35) !important;
      border: 1px solid color-mix(in srgb,var(--primary) 75%,#fff) !important;
      transition: background-position 0.6s ease, transform 0.15s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease !important;
    }
    .bg-primary:not([class*="bg-primary/"]):not(.text-primary):hover {
      background-position: 100% 50% !important;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.6) inset,
        0 -6px 12px -6px rgba(0,0,0,0.4) inset,
        0 18px 44px -8px color-mix(in srgb,var(--primary) 70%,transparent),
        0 6px 16px -4px rgba(0,0,0,0.4) !important;
    }

    /* Ghost / secondary tinted glass chips */
    .bg-primary\\/15 {
      background: color-mix(in srgb, var(--primary) 18%, transparent) !important;
      backdrop-filter: blur(18px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(18px) saturate(180%) !important;
      border: 1px solid color-mix(in srgb, var(--primary) 32%, transparent) !important;
      box-shadow: 0 1px 0 rgba(255,255,255,0.15) inset, 0 6px 18px -8px color-mix(in srgb,var(--primary) 45%,transparent) !important;
    }
    .bg-primary\\/8, .bg-primary\\/10 {
      background: color-mix(in srgb, var(--primary) 10%, transparent) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
    }

    .hover\\:bg-card:hover     { background: color-mix(in srgb, var(--foreground) 8%, transparent) !important; backdrop-filter: blur(40px) !important; }
    .hover\\:bg-secondary:hover{ background: color-mix(in srgb, var(--foreground) 10%, transparent) !important; }

    .shadow-md  { box-shadow: 0 10px 30px -12px rgba(0,0,0,0.45) !important; }
    .shadow-lg  { box-shadow: 0 20px 50px -18px rgba(0,0,0,0.5), 0 0 0 1px color-mix(in srgb,var(--foreground) 8%,transparent) !important; }
    .shadow-xl  { box-shadow: 0 28px 70px -20px rgba(0,0,0,0.55), 0 0 0 1px color-mix(in srgb,var(--foreground) 9%,transparent) !important; }
    .shadow-2xl { box-shadow: 0 44px 100px -24px rgba(0,0,0,0.65), 0 0 0 1px color-mix(in srgb,var(--foreground) 10%,transparent) !important; }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--foreground) 18%, transparent);
      border-radius: 9999px;
      backdrop-filter: blur(8px);
    }
    ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--foreground) 30%, transparent); }

    input:not([type=range]):not([type=color]):not([type=file]) {
      background: color-mix(in srgb, var(--foreground) 6%, transparent) !important;
      backdrop-filter: blur(20px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
      border: 1px solid color-mix(in srgb, var(--foreground) 12%, transparent) !important;
      border-radius: 1.5rem !important;
      box-shadow: 0 1px 0 color-mix(in srgb,var(--foreground) 15%,transparent) inset !important;
    }
    input:not([type=range]):not([type=color]):not([type=file]):focus {
      border-color: color-mix(in srgb, var(--primary) 55%, transparent) !important;
      box-shadow: 0 0 0 4px color-mix(in srgb,var(--primary) 18%,transparent), 0 1px 0 rgba(255,255,255,0.2) inset !important;
    }

    h1, h2 { font-weight: 700 !important; letter-spacing: -0.035em !important; }
  `,

  classic: `
    /* ══════════════════════════════════════════════════════════════
       FRUTIGER AERO — Windows 7 Aero glass, straight from 2007-2010
       Sky, water, bubbles, chrome, and glossy blue orbs
    ══════════════════════════════════════════════════════════════ */

    :root {
      --radius: 6px;
      --aero-cyan: #00c8ff;
      --aero-blue: #0a7dd8;
      --aero-deep: #003a7a;
      --aero-glow: rgba(0,180,255,0.55);
    }

    /* Segoe UI — the Frutiger Aero typeface */
    *, *::before, *::after {
      font-family: 'Segoe UI', 'Segoe UI Variable', Frutiger, Tahoma, system-ui, sans-serif !important;
    }

    /* ── Animations ── */
    @keyframes aeroBubble {
      0%   { transform: translateY(0)     translateX(0)   scale(1);   opacity: 0.55; }
      50%  { transform: translateY(-60vh) translateX(20px) scale(1.15); opacity: 0.8; }
      100% { transform: translateY(-120vh) translateX(-10px) scale(0.9); opacity: 0; }
    }
    @keyframes aeroShine {
      0%   { transform: translateX(-120%) skewX(-25deg); }
      100% { transform: translateX(320%)  skewX(-25deg); }
    }
    @keyframes aeroPulseGlow {
      0%,100% { box-shadow: 0 0 12px var(--aero-glow), 0 0 24px color-mix(in srgb,var(--aero-cyan) 30%,transparent); }
      50%     { box-shadow: 0 0 22px var(--aero-glow), 0 0 44px color-mix(in srgb,var(--aero-cyan) 45%,transparent); }
    }
    @keyframes aeroWindowOpen {
      0%   { opacity: 0; transform: scale(0.94) translateY(6px); }
      100% { opacity: 1; transform: scale(1)    translateY(0); }
    }

    /* ── Sky/water background with floating bubbles ── */
    .bg-background {
      background:
        radial-gradient(ellipse at 20% 100%, rgba(0,200,255,0.18) 0%, transparent 55%),
        radial-gradient(ellipse at 85% 15%, rgba(120,220,255,0.14) 0%, transparent 50%),
        linear-gradient(180deg, #041830 0%, #062248 35%, #0a3468 70%, #0e4088 100%) !important;
      position: relative !important;
      overflow-x: hidden !important;
    }
    [data-mode="light"] .bg-background {
      background:
        radial-gradient(ellipse at 20% 100%, rgba(255,255,255,0.6) 0%, transparent 55%),
        radial-gradient(ellipse at 85% 15%, rgba(160,220,255,0.5) 0%, transparent 50%),
        linear-gradient(180deg, #c8e8ff 0%, #96c8ff 40%, #6aa8ee 100%) !important;
    }
    /* Rising bubbles */
    .bg-background::before,
    .bg-background::after {
      content: '';
      position: fixed;
      left: 0; right: 0; bottom: -20vh;
      height: 140vh;
      pointer-events: none;
      background-image:
        radial-gradient(circle at 15% 90%,  rgba(180,240,255,0.35) 0 6px, transparent 7px),
        radial-gradient(circle at 82% 70%,  rgba(200,245,255,0.30) 0 4px, transparent 5px),
        radial-gradient(circle at 45% 50%,  rgba(150,220,255,0.25) 0 9px, transparent 10px),
        radial-gradient(circle at 70% 20%,  rgba(210,250,255,0.28) 0 5px, transparent 6px),
        radial-gradient(circle at 25% 30%,  rgba(180,240,255,0.20) 0 7px, transparent 8px),
        radial-gradient(circle at 90% 40%,  rgba(200,245,255,0.22) 0 3px, transparent 4px),
        radial-gradient(circle at 55% 85%,  rgba(160,225,255,0.30) 0 8px, transparent 9px);
      animation: aeroBubble 22s linear infinite;
    }
    .bg-background::after { animation-duration: 34s; animation-delay: -12s; opacity: 0.6; }

    /* ── Aero Glass cards — the signature translucent frost ── */
    .bg-card {
      background: linear-gradient(180deg,
        rgba(180,220,255,0.20) 0%,
        rgba(120,180,240,0.12) 45%,
        rgba(80,140,220,0.14) 100%) !important;
      backdrop-filter: blur(28px) saturate(180%) brightness(1.05) !important;
      -webkit-backdrop-filter: blur(28px) saturate(180%) brightness(1.05) !important;
      border: 1px solid rgba(180,225,255,0.35) !important;
      border-top: 1px solid rgba(220,245,255,0.55) !important;
      border-radius: 8px !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.35),
        inset 0 -1px 0 rgba(0,60,120,0.25),
        0 8px 24px rgba(0,30,80,0.5),
        0 2px 6px rgba(0,60,120,0.35) !important;
      position: relative !important;
      overflow: hidden !important;
      animation: aeroWindowOpen 0.22s cubic-bezier(0.2,0.9,0.35,1.15) !important;
    }
    /* Top glossy sheen on every card */
    .bg-card::before {
      content: '';
      position: absolute; top: 0; left: 0; right: 0; height: 42%;
      background: linear-gradient(180deg,
        rgba(255,255,255,0.28) 0%,
        rgba(255,255,255,0.08) 60%,
        transparent 100%);
      border-radius: 8px 8px 40% 40% / 8px 8px 100% 100%;
      pointer-events: none;
    }
    [data-mode="light"] .bg-card {
      background: linear-gradient(180deg,
        rgba(255,255,255,0.72) 0%,
        rgba(220,240,255,0.55) 45%,
        rgba(180,220,250,0.55) 100%) !important;
      border: 1px solid rgba(255,255,255,0.9) !important;
      border-top: 1px solid rgba(255,255,255,1) !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,1),
        inset 0 -1px 0 rgba(80,140,200,0.25),
        0 8px 22px rgba(30,80,140,0.20),
        0 2px 6px rgba(30,80,140,0.15) !important;
    }
    [data-mode="light"] .bg-card::before {
      background: linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.15) 60%, transparent 100%);
    }

    /* ── Popover / dialog: Aero glass window ── */
    .bg-popover, [class*="bg-popover"] {
      background: linear-gradient(180deg,
        rgba(30,80,160,0.85) 0%,
        rgba(10,40,90,0.90) 100%) !important;
      backdrop-filter: blur(36px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(36px) saturate(180%) !important;
      border: 1px solid rgba(180,225,255,0.5) !important;
      border-top: 1px solid rgba(220,245,255,0.75) !important;
      border-radius: 8px !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.4),
        0 20px 60px rgba(0,20,60,0.7),
        0 0 0 1px rgba(0,180,255,0.15) !important;
    }
    [data-mode="light"] .bg-popover, [data-mode="light"] [class*="bg-popover"] {
      background: linear-gradient(180deg, rgba(255,255,255,0.92) 0%, rgba(220,240,255,0.88) 100%) !important;
      border: 1px solid rgba(120,180,230,0.55) !important;
      border-top: 1px solid rgba(255,255,255,1) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,1), 0 20px 60px rgba(30,80,140,0.35) !important;
    }

    /* ── Sidebar: Aero Peek / Vista Sidebar Gadget dock ── */
    .bg-sidebar {
      background: linear-gradient(180deg,
        rgba(20,50,100,0.55) 0%,
        rgba(10,30,70,0.70) 100%) !important;
      backdrop-filter: blur(40px) saturate(200%) !important;
      -webkit-backdrop-filter: blur(40px) saturate(200%) !important;
      border-right: 1px solid rgba(180,225,255,0.35) !important;
      box-shadow: inset -1px 0 0 rgba(255,255,255,0.08), 3px 0 20px rgba(0,20,60,0.5) !important;
      position: relative !important;
      overflow: hidden !important;
    }
    /* Cyan glow strip on sidebar right edge */
    .bg-sidebar::after {
      content: '';
      position: absolute; top: 10%; right: 0; bottom: 10%; width: 1px;
      background: linear-gradient(180deg,
        transparent 0%,
        var(--aero-cyan) 30%,
        rgba(0,140,220,0.6) 70%,
        transparent 100%);
      box-shadow: 0 0 8px var(--aero-cyan);
    }
    [data-mode="light"] .bg-sidebar {
      background: linear-gradient(180deg, rgba(220,240,255,0.75) 0%, rgba(180,215,245,0.80) 100%) !important;
      border-right: 1px solid rgba(120,170,220,0.4) !important;
      box-shadow: inset -1px 0 0 rgba(255,255,255,0.6), 3px 0 16px rgba(30,80,140,0.15) !important;
    }

    /* ── Active sidebar item: Aero selected item — cyan glow rail ── */
    .bg-primary\\/15 {
      background: linear-gradient(90deg,
        rgba(0,180,255,0.30) 0%,
        rgba(0,140,240,0.18) 60%,
        rgba(0,120,220,0.05) 100%) !important;
      border-left: 3px solid var(--aero-cyan) !important;
      border-radius: 0 6px 6px 0 !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.20),
        inset 0 -1px 0 rgba(0,60,120,0.20),
        0 0 14px rgba(0,180,255,0.35) !important;
    }
    [data-mode="light"] .bg-primary\\/15 {
      background: linear-gradient(90deg, rgba(0,140,240,0.22) 0%, rgba(0,180,255,0.10) 100%) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 0 12px rgba(0,180,255,0.25) !important;
    }

    /* ── Sticky headers: Aero title bar (translucent gloss) ── */
    .sticky {
      background: linear-gradient(180deg,
        rgba(120,190,255,0.45) 0%,
        rgba(30,110,220,0.55) 55%,
        rgba(10,80,190,0.65) 100%) !important;
      backdrop-filter: blur(24px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
      border-bottom: 1px solid rgba(180,225,255,0.35) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 3px 12px rgba(0,30,80,0.35) !important;
      position: relative !important;
      overflow: hidden !important;
    }
    .sticky::before {
      content: '';
      position: absolute; top: 0; left: 0; right: 0; height: 50%;
      background: linear-gradient(180deg, rgba(255,255,255,0.28) 0%, transparent 100%);
      pointer-events: none;
    }
    .sticky h1, .sticky p.text-xs, .sticky .text-muted-foreground { color: rgba(255,255,255,0.95) !important; text-shadow: 0 1px 2px rgba(0,20,60,0.5) !important; }
    .sticky button { color: rgba(255,255,255,0.9) !important; }
    [data-mode="light"] .sticky {
      background: linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(200,225,250,0.80) 100%) !important;
      border-bottom: 1px solid rgba(120,180,230,0.4) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,1), 0 2px 8px rgba(30,80,140,0.12) !important;
    }
    [data-mode="light"] .sticky h1, [data-mode="light"] .sticky p.text-xs, [data-mode="light"] .sticky .text-muted-foreground {
      color: #062a5a !important; text-shadow: 0 1px 0 rgba(255,255,255,0.7) !important;
    }
    [data-mode="light"] .sticky button { color: #0a3a7a !important; }

    /* ── Primary buttons: Aero glossy blue orb pill (the Start button vibe) ── */
    .bg-primary:not([class*="bg-primary/"]):not(.text-primary) {
      background:
        linear-gradient(180deg,
          rgba(180,230,255,0.85) 0%,
          rgba(80,180,240,0.95) 45%,
          rgba(20,110,210,1)    46%,
          rgba(10,80,180,1)    100%) !important;
      border: 1px solid rgba(0,50,140,0.9) !important;
      border-top: 1px solid rgba(180,230,255,0.9) !important;
      border-radius: 20px !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.8),
        inset 0 -1px 0 rgba(0,40,100,0.5),
        inset 0 0 12px rgba(180,230,255,0.35),
        0 2px 6px rgba(0,40,120,0.55),
        0 0 0 1px rgba(0,180,255,0.15),
        0 6px 18px -6px rgba(0,150,255,0.5) !important;
      color: #ffffff !important;
      font-weight: 600 !important;
      text-shadow: 0 -1px 0 rgba(0,30,80,0.6), 0 1px 2px rgba(0,40,120,0.3) !important;
      letter-spacing: 0.01em !important;
      position: relative !important;
      overflow: hidden !important;
    }
    .bg-primary:not([class*="bg-primary/"]):not(.text-primary)::after {
      content: '';
      position: absolute; top: 0; left: 0; right: 0; height: 50%;
      background: linear-gradient(180deg, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0.05) 100%);
      border-radius: 20px 20px 40% 40% / 20px 20px 100% 100%;
      pointer-events: none;
    }
    .bg-primary:not([class*="bg-primary/"]):not(.text-primary):hover {
      filter: brightness(1.12) saturate(1.1) !important;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.9),
        inset 0 -1px 0 rgba(0,40,100,0.5),
        inset 0 0 16px rgba(180,240,255,0.5),
        0 3px 8px rgba(0,40,120,0.6),
        0 0 20px rgba(0,200,255,0.55),
        0 8px 22px -6px rgba(0,180,255,0.7) !important;
    }
    .bg-primary:not([class*="bg-primary/"]):not(.text-primary):active {
      background: linear-gradient(180deg,
        rgba(10,80,180,1)    0%,
        rgba(20,110,210,1)   45%,
        rgba(80,180,240,0.9) 100%) !important;
      box-shadow: inset 0 2px 4px rgba(0,20,60,0.55), inset 0 0 12px rgba(0,60,140,0.4) !important;
      transform: translateY(1px) !important;
    }

    /* ── Secondary surfaces ── */
    .bg-secondary {
      background: linear-gradient(180deg, rgba(180,220,255,0.14) 0%, rgba(80,140,220,0.10) 100%) !important;
      border: 1px solid rgba(180,225,255,0.22) !important;
      backdrop-filter: blur(16px) !important;
      -webkit-backdrop-filter: blur(16px) !important;
    }
    .bg-muted { background: rgba(30,60,120,0.20) !important; backdrop-filter: blur(12px) !important; -webkit-backdrop-filter: blur(12px) !important; }
    [data-mode="light"] .bg-secondary { background: linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(220,240,255,0.7) 100%) !important; border: 1px solid rgba(150,200,240,0.5) !important; }
    [data-mode="light"] .bg-muted { background: rgba(220,235,250,0.7) !important; }

    /* ── Settings tab bar (no bubble animation behind) ── */
    .settings-tabs {
      background: rgba(8,28,58,0.85) !important;
      border: 1px solid rgba(180,225,255,0.25) !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.12) !important;
    }
    [data-mode="light"] .settings-tabs {
      background: linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(220,240,255,0.85) 100%) !important;
      border: 1px solid rgba(150,200,240,0.5) !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.9) !important;
    }


    /* ── Borders ── */
    .border-border, .divide-border>*+* { border-color: rgba(180,225,255,0.25) !important; }
    [data-mode="light"] .border-border, [data-mode="light"] .divide-border>*+* { border-color: rgba(120,170,220,0.35) !important; }

    /* ── Active track row highlight ── */
    .bg-primary\\/8, .bg-primary\\/10 {
      background: linear-gradient(90deg, rgba(0,180,255,0.15) 0%, rgba(0,140,240,0.05) 100%) !important;
      border-left: 2px solid var(--aero-cyan) !important;
      box-shadow: inset 0 0 12px rgba(0,180,255,0.08) !important;
    }

    /* ── Typography ── */
    .text-primary { color: #7cd6ff !important; text-shadow: 0 0 12px rgba(0,180,255,0.4) !important; }
    [data-mode="light"] .text-primary { color: #0665c8 !important; text-shadow: none !important; }
    .text-muted-foreground { color: rgba(200,225,255,0.7) !important; }
    [data-mode="light"] .text-muted-foreground { color: rgba(20,60,110,0.68) !important; }
    h1, h2 { color: #f0f8ff !important; font-weight: 700 !important; text-shadow: 0 1px 2px rgba(0,20,60,0.4) !important; letter-spacing: -0.005em !important; }
    [data-mode="light"] h1, [data-mode="light"] h2 { color: #062a5a !important; text-shadow: 0 1px 0 rgba(255,255,255,0.5) !important; }
    .tracking-widest, .uppercase.text-xs { color: rgba(150,220,255,0.85) !important; letter-spacing: 0.18em !important; }
    [data-mode="light"] .tracking-widest, [data-mode="light"] .uppercase.text-xs { color: rgba(10,80,160,0.85) !important; }

    /* ── Inputs: Aero glass field ── */
    input:not([type=range]):not([type=color]):not([type=file]) {
      background: linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.06) 100%) !important;
      border: 1px solid rgba(180,225,255,0.35) !important;
      border-top: 1px solid rgba(200,235,255,0.5) !important;
      border-radius: 6px !important;
      box-shadow: inset 0 1px 2px rgba(0,20,60,0.35), inset 0 -1px 0 rgba(255,255,255,0.10) !important;
      color: #eaf4ff !important;
      backdrop-filter: blur(10px) !important;
      -webkit-backdrop-filter: blur(10px) !important;
    }
    input:not([type=range]):not([type=color]):not([type=file]):focus {
      border-color: var(--aero-cyan) !important;
      box-shadow:
        inset 0 1px 2px rgba(0,20,60,0.35),
        0 0 0 3px rgba(0,180,255,0.28),
        0 0 12px rgba(0,180,255,0.35) !important;
    }
    [data-mode="light"] input:not([type=range]):not([type=color]):not([type=file]) {
      background: linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(240,248,255,0.9) 100%) !important;
      border: 1px solid rgba(120,170,220,0.55) !important;
      color: #062a5a !important;
      box-shadow: inset 0 1px 2px rgba(30,80,140,0.15) !important;
    }

    /* ── Shadows ── */
    .shadow-md, .shadow-lg { box-shadow: 0 8px 26px rgba(0,20,60,0.55), inset 0 1px 0 rgba(255,255,255,0.18) !important; }
    .shadow-xl, .shadow-2xl { box-shadow: 0 20px 60px rgba(0,20,60,0.65), inset 0 1px 0 rgba(255,255,255,0.22), 0 0 0 1px rgba(0,180,255,0.15) !important; }
    [data-mode="light"] .shadow-md, [data-mode="light"] .shadow-lg { box-shadow: 0 8px 24px rgba(30,80,140,0.20), inset 0 1px 0 rgba(255,255,255,0.9) !important; }
    [data-mode="light"] .shadow-xl, [data-mode="light"] .shadow-2xl { box-shadow: 0 20px 50px rgba(30,80,140,0.30), inset 0 1px 0 rgba(255,255,255,1) !important; }

    /* ── Hover states ── */
    .hover\\:bg-card:hover { background: linear-gradient(180deg, rgba(200,235,255,0.25) 0%, rgba(120,180,240,0.18) 100%) !important; border-color: rgba(0,200,255,0.4) !important; box-shadow: 0 0 20px rgba(0,180,255,0.25), inset 0 1px 0 rgba(255,255,255,0.3) !important; }
    .hover\\:bg-secondary:hover { background: rgba(180,225,255,0.14) !important; }
    .group:hover .bg-card { border-color: rgba(0,200,255,0.45) !important; box-shadow: 0 10px 28px rgba(0,30,90,0.6), 0 0 22px rgba(0,180,255,0.3), inset 0 1px 0 rgba(255,255,255,0.28) !important; }
    [data-mode="light"] .group:hover .bg-card { box-shadow: 0 12px 30px rgba(30,80,140,0.25), 0 0 20px rgba(0,180,255,0.20), inset 0 1px 0 rgba(255,255,255,1) !important; }

    /* ── Modal: Aero window ── */
    [class*="max-w-md"], [class*="max-w-sm"], [class*="max-w-lg"] {
      border: 1px solid rgba(180,225,255,0.45) !important;
      border-top: 1px solid rgba(220,245,255,0.7) !important;
      border-radius: 8px !important;
      box-shadow: 0 30px 80px rgba(0,20,60,0.85), 0 0 0 1px rgba(0,180,255,0.2), inset 0 1px 0 rgba(255,255,255,0.35) !important;
      animation: aeroWindowOpen 0.22s cubic-bezier(0.2,0.9,0.35,1.15) !important;
    }

    /* ── Scrollbar: Aero glass ── */
    ::-webkit-scrollbar { width: 14px !important; }
    ::-webkit-scrollbar-track {
      background: linear-gradient(90deg, rgba(0,20,60,0.4), rgba(0,10,40,0.5)) !important;
      border-left: 1px solid rgba(180,225,255,0.15) !important;
    }
    ::-webkit-scrollbar-thumb {
      background: linear-gradient(90deg, rgba(120,200,255,0.6) 0%, rgba(30,120,230,0.85) 50%, rgba(10,80,180,0.9) 100%) !important;
      border: 1px solid rgba(200,235,255,0.4) !important;
      border-radius: 7px !important;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), 0 0 6px rgba(0,180,255,0.3) !important;
    }
    ::-webkit-scrollbar-thumb:hover { filter: brightness(1.15); }
    [data-mode="light"] ::-webkit-scrollbar-track { background: linear-gradient(90deg, rgba(220,235,250,0.7), rgba(200,225,245,0.8)) !important; border-left-color: rgba(120,180,230,0.3) !important; }

    /* ── Images ── */
    img { box-shadow: 0 4px 14px rgba(0,20,60,0.5), 0 0 0 1px rgba(180,225,255,0.25) !important; }
    [data-mode="light"] img { box-shadow: 0 4px 14px rgba(30,80,140,0.20), 0 0 0 1px rgba(120,170,220,0.35) !important; }

    /* ── Rounded (era-accurate, gentle radii) ── */
    .rounded-md  { border-radius: 6px !important; }
    .rounded-lg  { border-radius: 8px !important; }
    .rounded-xl  { border-radius: 10px !important; }
    .rounded-2xl { border-radius: 12px !important; }
    .rounded-3xl { border-radius: 14px !important; }
  `,


  unique: `
    /* Synthwave Brutalism */
    :root { --radius: 0px; }
    *, *::before, *::after { border-radius: 0 !important; }
    body::before {
      content: '';
      position: fixed; inset: 0;
      background: repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.04) 3px, rgba(0,0,0,0.04) 4px);
      pointer-events: none; z-index: 9997;
    }
    .bg-background {
      background-image: linear-gradient(rgba(252,60,68,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(252,60,68,0.035) 1px, transparent 1px) !important;
      background-size: 48px 48px !important;
    }
    .bg-card {
      background: rgba(0,0,0,0.7) !important;
      border: 1px solid rgba(255,255,255,0.1) !important;
      border-left: 3px solid var(--primary) !important;
      box-shadow: 6px 6px 0 rgba(0,0,0,0.9) !important;
    }
    .bg-primary:not([class*="bg-primary/"]):not(.text-primary) {
      background: transparent !important;
      border: 2px solid var(--primary) !important;
      box-shadow: 0 0 16px var(--primary), 4px 4px 0 var(--primary) !important;
      font-family: 'SF Mono','Fira Code',monospace !important;
      text-transform: uppercase !important;
      letter-spacing: 0.1em !important;
      font-size: 0.72rem !important;
      animation: neonPulse 3s ease-in-out infinite !important;
    }
    .bg-primary:not([class*="bg-primary/"]):not(.text-primary) * { color: var(--primary) !important; }
    .bg-primary:not([class*="bg-primary/"]):not(.text-primary):hover { background: color-mix(in srgb,var(--primary) 12%,transparent) !important; box-shadow: 0 0 28px var(--primary), 4px 4px 0 var(--primary) !important; }
    @keyframes neonPulse {
      0%,90%,100% { box-shadow: 0 0 16px var(--primary), 4px 4px 0 var(--primary); }
      95% { box-shadow: 0 0 6px var(--primary), 4px 4px 0 var(--primary); opacity:0.85; }
    }
    .bg-sidebar {
      background: repeating-linear-gradient(-45deg,#010108,#010108 14px,#02020c 14px,#02020c 28px) !important;
      border-right: 2px solid var(--primary) !important;
      box-shadow: 4px 0 20px color-mix(in srgb,var(--primary) 30%,transparent) !important;
    }
    .bg-primary\/15 { background: color-mix(in srgb,var(--primary) 18%,transparent) !important; border-left: 3px solid var(--primary) !important; }
    .sticky {
      background: rgba(0,0,0,0.94) !important;
      border-bottom: 2px solid var(--primary) !important;
      box-shadow: 0 4px 24px color-mix(in srgb,var(--primary) 20%,transparent) !important;
      position: relative !important;
      overflow: hidden !important;
    }
    .sticky::after {
      content:''; position:absolute; bottom:0; left:-100%; width:100%; height:2px;
      background: linear-gradient(90deg, transparent, var(--primary), transparent);
      animation: headerSweep 3s linear infinite;
    }
    @keyframes headerSweep { to { left: 100%; } }
    h1, h2 {
      background: linear-gradient(90deg,#fff 0%,var(--primary) 100%);
      -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
      font-family:'SF Mono','Fira Code',monospace !important;
    }
    .text-xs.uppercase, .uppercase.tracking-widest { font-family:'SF Mono','Fira Code',monospace !important; letter-spacing:0.22em !important; }
    .text-primary { text-shadow: 0 0 10px var(--primary) !important; }
    [class*="bg-popover"] { background: rgba(0,0,0,0.97) !important; border-top: 2px solid var(--primary) !important; box-shadow: 0 -4px 32px color-mix(in srgb,var(--primary) 20%,transparent) !important; }
    .bg-secondary { background: rgba(255,255,255,0.03) !important; border: 1px solid rgba(255,255,255,0.07) !important; }
    .border-border, .divide-border>*+* { border-color: rgba(255,255,255,0.12) !important; }
    .bg-primary\/8, .bg-primary\/10 { background: color-mix(in srgb,var(--primary) 10%,transparent) !important; border-left: 3px solid var(--primary) !important; }
    input:not([type=range]):not([type=color]):not([type=file]) { background: rgba(0,0,0,0.5) !important; border: 1px solid rgba(255,255,255,0.12) !important; border-left: 2px solid var(--primary) !important; }
    input:not([type=range]):not([type=color]):not([type=file]):focus { border-color: var(--primary) !important; box-shadow: 0 0 16px color-mix(in srgb,var(--primary) 40%,transparent) !important; }
    ::-webkit-scrollbar { width: 4px !important; }
    ::-webkit-scrollbar-track { background: #010108 !important; }
    ::-webkit-scrollbar-thumb { background: var(--primary) !important; box-shadow: 0 0 8px var(--primary) !important; }
    .group:hover .bg-card { border-color: color-mix(in srgb,var(--primary) 50%,rgba(255,255,255,0.12)) !important; }
    .shadow-lg, .shadow-xl, .shadow-2xl { box-shadow: 8px 8px 0 rgba(0,0,0,0.9) !important; }
  `,
};

const GRADIENT_PRESETS: Array<{ label: string; stops: GradientStop[]; angle: number }> = [
  { label: "Abyss",    stops: [{ color: "#0f0c29", position: 0 }, { color: "#302b63", position: 50 }, { color: "#24243e", position: 100 }], angle: 135 },
  { label: "Ocean",    stops: [{ color: "#0f2027", position: 0 }, { color: "#203a43", position: 50 }, { color: "#2c5364", position: 100 }], angle: 160 },
  { label: "Ember",    stops: [{ color: "#1a0505", position: 0 }, { color: "#2d0b0b", position: 100 }], angle: 145 },
  { label: "Forest",   stops: [{ color: "#0a0f0a", position: 0 }, { color: "#0d2210", position: 100 }], angle: 135 },
  { label: "Dusk",     stops: [{ color: "#1a1a2e", position: 0 }, { color: "#0f3460", position: 100 }], angle: 160 },
  { label: "Aurora",   stops: [{ color: "#001f3f", position: 0 }, { color: "#003366", position: 50 }, { color: "#00b4d8", position: 100 }], angle: 120 },
  { label: "Nebula",   stops: [{ color: "#200122", position: 0 }, { color: "#6f0000", position: 100 }], angle: 135 },
  { label: "Frost",    stops: [{ color: "#e0eafc", position: 0 }, { color: "#cfdef3", position: 100 }], angle: 135 },
  { label: "Peach",    stops: [{ color: "#ffecd2", position: 0 }, { color: "#fcb69f", position: 100 }], angle: 135 },
  { label: "Cotton",   stops: [{ color: "#fbc2eb", position: 0 }, { color: "#a6c1ee", position: 100 }], angle: 135 },
  { label: "Citrus",   stops: [{ color: "#f7971e", position: 0 }, { color: "#ffd200", position: 100 }], angle: 135 },
  { label: "Neon",     stops: [{ color: "#0d0d0d", position: 0 }, { color: "#1a0030", position: 50 }, { color: "#00ff88", position: 100 }], angle: 135 },
];

const ACCENT_PRESETS = [
  { label: "Red",    value: "#fc3c44" },
  { label: "Pink",   value: "#ff375f" },
  { label: "Orange", value: "#ff6b00" },
  { label: "Amber",  value: "#f5a623" },
  { label: "Yellow", value: "#ffd60a" },
  { label: "Green",  value: "#30d158" },
  { label: "Teal",   value: "#32ade6" },
  { label: "Blue",   value: "#0a84ff" },
  { label: "Indigo", value: "#5e5ce6" },
  { label: "Purple", value: "#bf5af2" },
  { label: "Rose",   value: "#ff6e79" },
  { label: "Slate",  value: "#98989d" },
];

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const lin = (c: number) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function isLightColor(hex: string): boolean {
  return relativeLuminance(hex) > 0.35;
}

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const DEFAULT_THEME: AppTheme = {
  mode: "dark",
  accent: "#fc3c44",
  layoutTheme: "default",
  gradient: { enabled: false, stops: [{ color: "#0f0c29", position: 0 }, { color: "#24243e", position: 100 }], angle: 135 },
  custom: DEFAULT_CUSTOM_CONFIG,
  visualizer: DEFAULT_VISUALIZER,
  fsBg: DEFAULT_FS_BG,
  colorOverrides: {},
};

function loadTheme(): AppTheme {
  try {
    const saved = JSON.parse(localStorage.getItem("melodia_theme") || "null");
    if (!saved) return DEFAULT_THEME;
    return {
      ...DEFAULT_THEME, ...saved,
      gradient: { ...DEFAULT_THEME.gradient, ...(saved.gradient ?? {}) },
      custom: { ...DEFAULT_CUSTOM_CONFIG, ...(saved.custom ?? {}) },
      visualizer: { ...DEFAULT_VISUALIZER, ...(saved.visualizer ?? {}) },
      fsBg: { ...DEFAULT_FS_BG, ...(saved.fsBg ?? {}) },
      colorOverrides: { ...(saved.colorOverrides ?? {}) },
    };
  } catch { return DEFAULT_THEME; }
}

function applyLayoutTheme(lt: LayoutTheme) {
  // Inject/replace the layout theme stylesheet
  let el = document.getElementById("melodia-layout-theme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "melodia-layout-theme";
    document.head.appendChild(el);
  }
  el.textContent = LAYOUT_THEME_CSS[lt] ?? "";
  document.documentElement.setAttribute("data-layout-theme", lt);
}

function buildGradientCss(stops: GradientStop[], angle: number): string {
  const s = stops.map(s => `${s.color} ${s.position}%`).join(", ");
  return `linear-gradient(${angle}deg, ${s})`;
}

function saveTheme(t: AppTheme) {
  localStorage.setItem("melodia_theme", JSON.stringify(t));
}

function applyTheme(t: AppTheme) {
  const root = document.documentElement;
  const dark = t.mode === "dark";
  const accentLight = isLightColor(t.accent);
  const primaryFg = accentLight ? "#111111" : "#ffffff";

  const vars: Record<string, string> = dark
    ? {
        "--background":          "#0c0c10",
        "--foreground":          "#f2f2f7",
        "--card":                "#161619",
        "--card-foreground":     "#f2f2f7",
        "--popover":             "#1c1c20",
        "--popover-foreground":  "#f2f2f7",
        "--secondary":           "#1e1e24",
        "--secondary-foreground":"#f2f2f7",
        "--muted":               "#1a1a1f",
        "--muted-foreground":    "#86868b",
        "--border":              "rgba(255,255,255,0.08)",
        "--input-background":    "#1e1e24",
        "--sidebar":             "#111114",
        "--sidebar-foreground":  "#f2f2f7",
        "--sidebar-accent":      "#1e1e24",
        "--sidebar-accent-foreground": "#f2f2f7",
        "--sidebar-border":      "rgba(255,255,255,0.08)",
        "--destructive":         "#ff453a",
        "--destructive-foreground": "#ffffff",
        "--switch-background":   "#3a3a40",
      }
    : {
        "--background":          "#f0f2f6",
        "--foreground":          "#16191f",
        "--card":                "#ffffff",
        "--card-foreground":     "#16191f",
        "--popover":             "#ffffff",
        "--popover-foreground":  "#16191f",
        "--secondary":           "#e8eaef",
        "--secondary-foreground":"#16191f",
        "--muted":               "#ebedf2",
        "--muted-foreground":    "#64748b",
        "--border":              "rgba(0,0,0,0.09)",
        "--input-background":    "#f5f6fa",
        "--sidebar":             "#e4e6ed",
        "--sidebar-foreground":  "#16191f",
        "--sidebar-accent":      "#dcdee6",
        "--sidebar-accent-foreground": "#16191f",
        "--sidebar-border":      "rgba(0,0,0,0.07)",
        "--destructive":         "#dc2626",
        "--destructive-foreground": "#ffffff",
        "--switch-background":   "#c8cad0",
      };

  vars["--primary"]            = t.accent;
  vars["--primary-foreground"] = primaryFg;
  vars["--accent"]             = t.accent;
  vars["--accent-foreground"]  = primaryFg;
  vars["--ring"]               = hexToRgba(t.accent, 0.5);
  vars["--sidebar-primary"]    = t.accent;
  vars["--sidebar-primary-foreground"] = primaryFg;

  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
  root.setAttribute("data-mode", t.mode);
  applyLayoutTheme(t.layoutTheme ?? "default");
  applyCustomThemeConfig(t.custom ?? DEFAULT_CUSTOM_CONFIG, t.accent);

  // Apply user color overrides LAST — they win over everything including layout themes
  const overrides = t.colorOverrides ?? {};
  for (const [cssVar, value] of Object.entries(overrides)) {
    if (value) root.style.setProperty(cssVar, value);
  }
}

// ── Cassette logo SVG ──────────────────────────────────────────────────────

function CassetteLogo({ size = 32 }: { size?: number }) {
  const h = Math.round(size * 0.65);
  return (
    <svg width={size} height={h} viewBox="0 0 40 26" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Wicked">
      {/* Body */}
      <rect x="0.75" y="0.75" width="38.5" height="24.5" rx="2.25" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.5" />
      {/* Tape window */}
      <rect x="8" y="5.5" width="24" height="15" rx="1.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
      {/* Left reel outer */}
      <circle cx="15" cy="13" r="4" stroke="currentColor" strokeWidth="1.4" />
      {/* Left reel hub */}
      <circle cx="15" cy="13" r="1.4" fill="currentColor" />
      {/* Right reel outer */}
      <circle cx="25" cy="13" r="4" stroke="currentColor" strokeWidth="1.4" />
      {/* Right reel hub */}
      <circle cx="25" cy="13" r="1.4" fill="currentColor" />
      {/* Tape path – bottom of window */}
      <path d="M9 20 C9 20 12 16.5 15 16.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M31 20 C31 20 28 16.5 25 16.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      {/* Corner screws */}
      <circle cx="4.5" cy="4.5" r="1.3" fill="currentColor" fillOpacity="0.35" />
      <circle cx="35.5" cy="4.5" r="1.3" fill="currentColor" fillOpacity="0.35" />
      <circle cx="4.5" cy="21.5" r="1.3" fill="currentColor" fillOpacity="0.35" />
      <circle cx="35.5" cy="21.5" r="1.3" fill="currentColor" fillOpacity="0.35" />
      {/* Counter window – small rect top center */}
      <rect x="17" y="2.5" width="6" height="2.5" rx="0.5" fill="currentColor" fillOpacity="0.25" />
    </svg>
  );
}

// ── App root ───────────────────────────────────────────────────────────────

export default function App() {
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [playlists, setPlaylists] = useState<Playlist[]>(loadPlaylists);
  const [route, setRoute] = useState(parseRoute);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("home");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(loadTheme);
  const [savedCustomThemes, setSavedCustomThemes] = useState<SavedCustomTheme[]>(loadSavedCustomThemes);
  const [visualizer, setVisualizer] = useState<VisualizerConfig>(() => loadTheme().visualizer);
  const [player, setPlayer] = useState<PlayerState>({
    projectId: null, trackIndex: 0, isPlaying: false,
    currentTime: 0, duration: 0, volume: 0.8, shuffle: false,
    queue: [], queuePos: 0,
  });
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showNextUp, setShowNextUp] = useState(false);
  const [nextUpPreview, setNextUpPreview] = useState(false);
  const [likedSongs, setLikedSongs] = useState<LikedSong[]>(loadLikedSongs);
  const [favorites, setFavorites] = useState<FavoriteItem[]>(loadFavorites);
  const [folders, setFolders] = useState<Folder[]>(loadFolders);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const blobRef = useRef<string | null>(null);
  const playerRef = useRef(player);
  const projectsRef = useRef(projects);
  const playTrackRef = useRef<(pid: string, idx: number, queue?: QueueItem[], queuePos?: number) => Promise<void>>(() => Promise.resolve());

  useEffect(() => { playerRef.current = player; }, [player]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);

  // Apply theme whenever it changes, with a brief transition class for smoothness
  useEffect(() => {
    document.documentElement.classList.add("theme-transitioning");
    applyTheme(theme);
    saveTheme(theme);
    const t = setTimeout(() => document.documentElement.classList.remove("theme-transitioning"), 400);
    return () => clearTimeout(t);
  }, [theme]);

  useEffect(() => {
    const audio = new Audio();
    audio.volume = 0.8;
    audioRef.current = audio;

    // Wire up Web Audio API analyser on first play (browsers require user gesture)
    const initAnalyser = () => {
      if (analyserRef.current) return;
      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
        const src = ctx.createMediaElementSource(audio);
        src.connect(analyser);
        analyser.connect(ctx.destination);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
      } catch (e) { console.warn("AudioContext failed:", e); }
    };
    audio.addEventListener("play", initAnalyser, { once: true });

    return () => { audio.pause(); audio.src = ""; audioCtxRef.current?.close(); };
  }, []);

  useEffect(() => {
    const handle = () => setRoute(parseRoute());
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);

  useEffect(() => { saveProjects(projects); }, [projects]);
  useEffect(() => { savePlaylists(playlists); }, [playlists]);
  useEffect(() => { saveSavedCustomThemes(savedCustomThemes); }, [savedCustomThemes]);
  useEffect(() => { saveVisualizerConfig(visualizer); setTheme(prev => ({ ...prev, visualizer })); }, [visualizer]);

  // Show "Next Up" preview in the last 20 s of a track (only when queue panel is closed)
  useEffect(() => {
    const { currentTime, duration, isPlaying, queue, queuePos } = player;
    const timeLeft = duration - currentTime;
    const hasNext = queue.length > queuePos + 1;
    if (isPlaying && hasNext && duration > 0 && timeLeft <= 20 && timeLeft > 0 && !showNextUp && !isFullscreen) {
      setNextUpPreview(true);
    } else {
      setNextUpPreview(false);
    }
  }, [player.currentTime, player.duration, player.isPlaying, player.queuePos, player.queue, showNextUp, isFullscreen]);
  useEffect(() => { saveLikedSongs(likedSongs); }, [likedSongs]);
  useEffect(() => { saveFavorites(favorites); }, [favorites]);
  useEffect(() => { saveFolders(folders); }, [folders]);

  const showToast = useCallback((msg: string) => {
    const id = Date.now();
    setToast({ msg, id });
    setTimeout(() => setToast(t => t?.id === id ? null : t), 2800);
  }, []);

  // ── Queue management ───────────────────────────────────────────────────
  const addToFront = useCallback((projectId: string, trackIndex: number) => {
    setPlayer(prev => {
      if (!prev.projectId) return prev; // nothing playing yet
      const item: QueueItem = { projectId, trackIndex };
      const insertAt = prev.queuePos + 1;
      const newQueue = [...prev.queue.slice(0, insertAt), item, ...prev.queue.slice(insertAt)];
      return { ...prev, queue: newQueue };
    });
    showToast("Added to front of queue");
  }, [showToast]);

  const addToBack = useCallback((projectId: string, trackIndex: number) => {
    setPlayer(prev => {
      if (!prev.projectId) return prev;
      return { ...prev, queue: [...prev.queue, { projectId, trackIndex }] };
    });
    showToast("Added to queue");
  }, [showToast]);

  const removeFromQueue = useCallback((queueIndex: number) => {
    setPlayer(prev => ({
      ...prev,
      queue: prev.queue.filter((_, i) => i !== queueIndex),
      queuePos: queueIndex < prev.queuePos ? prev.queuePos - 1 : prev.queuePos,
    }));
  }, []);

  const toggleLike = useCallback((projectId: string, trackId: string) => {
    setLikedSongs(prev => {
      const exists = prev.some(s => s.projectId === projectId && s.trackId === trackId);
      return exists ? prev.filter(s => !(s.projectId === projectId && s.trackId === trackId))
        : [...prev, { projectId, trackId, likedAt: Date.now() }];
    });
  }, []);

  const isLiked = useCallback((projectId: string, trackId: string) =>
    likedSongs.some(s => s.projectId === projectId && s.trackId === trackId),
  [likedSongs]);

  const toggleFavorite = useCallback((type: "album" | "playlist", id: string) => {
    setFavorites(prev => {
      const exists = prev.some(f => f.type === type && f.id === id);
      return exists ? prev.filter(f => !(f.type === type && f.id === id))
        : [...prev, { type, id, savedAt: Date.now() }];
    });
  }, []);

  const isFavorited = useCallback((type: "album" | "playlist", id: string) =>
    favorites.some(f => f.type === type && f.id === id),
  [favorites]);

  const playTrack = useCallback(async (
    projectId: string,
    trackIndex: number,
    queue?: QueueItem[],
    queuePos?: number,
  ) => {
    const proj = projectsRef.current.find(p => p.id === projectId);
    if (!proj?.tracks[trackIndex]) return;
    const track = proj.tracks[trackIndex];
    const audio = audioRef.current!;

    audio.pause();
    if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null; }

    const blob = await dbGet(track.audioKey);
    if (!blob) { showToast("Audio file not found"); return; }

    blobRef.current = URL.createObjectURL(blob);
    audio.src = blobRef.current;
    audio.volume = playerRef.current.volume;
    try {
      await audio.play();
      setPlayer(p => ({
        ...p,
        projectId,
        trackIndex,
        isPlaying: true,
        currentTime: 0,
        queue: queue ?? p.queue,
        queuePos: queuePos ?? p.queuePos,
      }));
    } catch (e) {
      console.error("Playback error", e);
    }
  }, [showToast]);

  useEffect(() => { playTrackRef.current = playTrack; }, [playTrack]);

  useEffect(() => {
    const audio = audioRef.current!;
    if (!audio) return;
    const onTime = () => setPlayer(p => ({ ...p, currentTime: audio.currentTime }));
    const onDur = () => setPlayer(p => ({ ...p, duration: isFinite(audio.duration) ? audio.duration : 0 }));
    const onEnded = () => {
      const p = playerRef.current;
      const { queue, queuePos, shuffle } = p;
      if (queue.length === 0) { setPlayer(prev => ({ ...prev, isPlaying: false })); return; }
      const nextPos = shuffle
        ? shuffleNext(queue, queuePos)
        : queuePos + 1;
      if (!shuffle && nextPos >= queue.length) {
        setPlayer(prev => ({ ...prev, isPlaying: false }));
        return;
      }
      const next = queue[nextPos];
      playTrackRef.current(next.projectId, next.trackIndex, queue, nextPos);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onDur);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onDur);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current!;
    if (playerRef.current.isPlaying) {
      audio.pause();
      setPlayer(p => ({ ...p, isPlaying: false }));
    } else if (audio.src) {
      audio.play().then(() => setPlayer(p => ({ ...p, isPlaying: true }))).catch(console.error);
    }
  }, []);

  const nav = (hash: string) => {
    window.location.hash = hash;
    setSidebarTab("home");
  };

  const currentProject = player.projectId
    ? projects.find(p => p.id === player.projectId) ?? null
    : null;
  const currentTrack = currentProject?.tracks[player.trackIndex] ?? null;

  const shared = { projects, setProjects, player, setPlayer, playTrack, nav, showToast };

  const gradientBg = theme.gradient.enabled
    ? buildGradientCss(theme.gradient.stops, theme.gradient.angle)
    : undefined;

  const customFont = FONT_MAP[theme.custom?.fontFamily ?? "system"]?.css
    ?? "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif";

  // Unique key per visible "page" — drives AnimatePresence transitions
  const pageKey =
    sidebarTab !== "home"
      ? sidebarTab
      : route.page === "project"
        ? `project-${route.id}`
        : route.page === "share"
          ? `share-${route.id}`
          : "home";

  return (
    <div
      className={`flex h-screen text-foreground overflow-hidden relative${theme.custom?.backgroundUrl ? " melodia-bg-layer" : ""}`}
      style={{ fontFamily: customFont }}
    >
      {/* Background layer — solid color or gradient */}
      <div
        className="absolute inset-0 -z-10 transition-all duration-700"
        style={{ background: gradientBg ?? "var(--background)" }}
      />

      {/* Sidebar */}
      <div
        className="shrink-0 overflow-hidden border-r border-border bg-sidebar flex flex-col transition-all duration-200"
        style={{ width: sidebarOpen ? 220 : 0 }}
      >
        {/* Always render so transition works smoothly */}
        <div className="w-[220px] flex flex-col h-full">
          {/* Logo + collapse */}
          <div className="flex items-center justify-between px-4 pt-5 pb-3">
            <button
              onClick={() => { setSidebarTab("home"); window.location.hash = "/"; }}
              className="text-foreground hover:text-primary transition-colors"
              title="Home"
            >
              <CassetteLogo size={34} />
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              title="Close sidebar"
            >
              <PanelLeftClose size={15} />
            </button>
          </div>

          {/* Nav */}
          <nav className="flex-1 px-2 pt-3 space-y-0.5">
            <SidebarItem
              icon={<Home size={16} />}
              label="Home"
              active={sidebarTab === "home"}
              onClick={() => { setSidebarTab("home"); window.location.hash = "/"; }}
            />
            <SidebarItem
              icon={<Library size={16} />}
              label="Library"
              active={sidebarTab === "library"}
              onClick={() => setSidebarTab("library")}
            />
            <SidebarItem
              icon={<LayoutList size={16} />}
              label="Playlists"
              active={sidebarTab === "playlists"}
              onClick={() => setSidebarTab("playlists")}
            />
            <SidebarItem
              icon={<Heart size={16} />}
              label="Liked Songs"
              active={sidebarTab === "liked"}
              onClick={() => setSidebarTab("liked")}
            />
            <SidebarItem
              icon={<Star size={16} />}
              label="Favorites"
              active={sidebarTab === "favorites"}
              onClick={() => setSidebarTab("favorites")}
            />
            <SidebarItem
              icon={<User size={16} />}
              label="Profile"
              active={sidebarTab === "profile"}
              onClick={() => setSidebarTab("profile")}
            />
            <SidebarItem
              icon={<Settings size={16} />}
              label="Settings"
              active={sidebarTab === "settings"}
              onClick={() => setSidebarTab("settings")}
            />
          </nav>

          {/* New Project */}
          <div className="px-3 py-4 border-t border-border">
            <button
              onClick={() => setShowCreate(true)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-primary hover:bg-primary/85 text-white rounded-md text-sm font-semibold transition-all active:scale-95 shadow-md shadow-primary/20"
            >
              <Plus size={15} strokeWidth={2.5} />
              New Project
            </button>
          </div>
        </div>
      </div>

      {/* Main area — flex ROW so queue can push content */}
      <div className="flex flex-row flex-1 overflow-hidden min-w-0">
        {/* Content column */}
        <div className="flex flex-col flex-1 overflow-hidden min-w-0 relative">
          {/* Sidebar-open toggle */}
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="absolute top-4 left-3 z-30 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-card border border-border transition-colors"
              title="Open sidebar"
            >
              <PanelLeftOpen size={15} />
            </button>
          )}

          <div className="flex-1 overflow-hidden relative">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={pageKey}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                className="absolute inset-0 overflow-y-auto scrollbar-hide"
              >
                {sidebarTab === "home" && (
                  <>
                    {route.page === "home" && (
                      <HomeView
                        {...shared}
                        showCreate={showCreate}
                        setShowCreate={setShowCreate}
                        sidebarOpen={sidebarOpen}
                        toggleFavorite={toggleFavorite}
                        isFavorited={isFavorited}
                        folders={folders}
                        setFolders={setFolders}
                        layoutTheme={theme.layoutTheme}
                      />
                    )}
                    {route.page === "project" && (
                      <ProjectView {...shared} projectId={route.id!} sidebarOpen={sidebarOpen} toggleLike={toggleLike} isLiked={isLiked} toggleFavorite={toggleFavorite} isFavorited={isFavorited} addToFront={addToFront} addToBack={addToBack} />
                    )}
                    {route.page === "share" && (
                      <ShareView {...shared} projectId={route.id!} />
                    )}
                  </>
                )}
                {sidebarTab === "library" && (
                  <AllTracksView {...shared} sidebarOpen={sidebarOpen} toggleLike={toggleLike} isLiked={isLiked} toggleFavorite={toggleFavorite} isFavorited={isFavorited} addToFront={addToFront} addToBack={addToBack} />
                )}
                {sidebarTab === "playlists" && (
                  <PlaylistsView
                    playlists={playlists}
                    setPlaylists={setPlaylists}
                    projects={projects}
                    player={player}
                    playTrack={playTrack}
                    setPlayer={setPlayer}
                    showToast={showToast}
                    sidebarOpen={sidebarOpen}
                    toggleFavorite={toggleFavorite}
                    isFavorited={isFavorited}
                    toggleLike={toggleLike}
                    isLiked={isLiked}
                  />
                )}
                {sidebarTab === "liked" && (
                  <LikedSongsView
                    likedSongs={likedSongs}
                    projects={projects}
                    player={player}
                    playTrack={playTrack}
                    toggleLike={toggleLike}
                    sidebarOpen={sidebarOpen}
                  />
                )}
                {sidebarTab === "favorites" && (
                  <FavoritesView
                    favorites={favorites}
                    projects={projects}
                    playlists={playlists}
                    player={player}
                    playTrack={playTrack}
                    toggleFavorite={toggleFavorite}
                    nav={nav}
                    setSidebarTab={setSidebarTab}
                    sidebarOpen={sidebarOpen}
                  />
                )}
                {sidebarTab === "profile" && (
                  <ProfileView
                    projects={projects.filter(p => !p.isSingle)}
                    playlists={playlists}
                    likedSongs={likedSongs}
                    favorites={favorites}
                    nav={nav}
                    setSidebarTab={setSidebarTab}
                    player={player}
                    playTrack={playTrack}
                  />
                )}
                {sidebarTab === "settings" && (
                  <SettingsView
                    projects={projects}
                    setProjects={setProjects}
                    showToast={showToast}
                    player={player}
                    setPlayer={setPlayer}
                    audioRef={audioRef}
                    theme={theme}
                    setTheme={setTheme}
                    visualizer={visualizer}
                    setVisualizer={setVisualizer}
                    savedCustomThemes={savedCustomThemes}
                    setSavedCustomThemes={setSavedCustomThemes}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Next Up preview — ABOVE the player bar, slide up from bottom */}

          {/* Audio Visualizer */}
          {visualizer.enabled && currentTrack && (
            <div className="relative shrink-0" style={{ height: visualizer.style === "circular" ? 160 : 80, overflow: "hidden" }}>
              <AudioVisualizer
                analyserRef={analyserRef}
                config={visualizer}
                isPlaying={player.isPlaying}
                layoutTheme={theme.layoutTheme}
                accent={theme.accent}
              />
            </div>
          )}

          {/* Next Up preview — shrink-0 slot above player, right-aligned */}
          <AnimatePresence>
            {nextUpPreview && (
              <motion.div
                key="next-up-slot"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                className="shrink-0 overflow-hidden"
              >
                <NextUpPreview
                  player={player}
                  projects={projects}
                  nextUpPreview={nextUpPreview}
                  onDismiss={() => setNextUpPreview(false)}
                  onSkip={() => {
                    const { queue, queuePos, shuffle } = player;
                    if (!queue.length) return;
                    const nextPos = shuffle ? shuffleNext(queue, queuePos) : queuePos + 1;
                    if (nextPos < queue.length) {
                      const item = queue[nextPos];
                      playTrack(item.projectId, item.trackIndex, queue, nextPos);
                    }
                    setNextUpPreview(false);
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {currentTrack && (
            <PlayerBar
              project={currentProject!}
              track={currentTrack}
              player={player}
              onTogglePlay={togglePlay}
              onSeek={t => { audioRef.current!.currentTime = t; setPlayer(p => ({ ...p, currentTime: t })); }}
              onVolume={v => { if (audioRef.current) audioRef.current.volume = v; setPlayer(p => ({ ...p, volume: v })); }}
              onPrev={() => {
                const prevPos = player.queuePos - 1;
                if (prevPos >= 0) {
                  const item = player.queue[prevPos];
                  if (item) playTrack(item.projectId, item.trackIndex, player.queue, prevPos);
                }
              }}
              onNext={() => {
                const { queue, queuePos, shuffle } = player;
                if (!queue.length) return;
                const nextPos = shuffle
                  ? shuffleNext(queue, queuePos)
                  : queuePos + 1;
                if (nextPos < queue.length) {
                  const item = queue[nextPos];
                  playTrack(item.projectId, item.trackIndex, queue, nextPos);
                }
              }}
              onShuffle={() => setPlayer(p => ({ ...p, shuffle: !p.shuffle }))}
              onExpand={() => setIsFullscreen(true)}
              onToggleNextUp={() => setShowNextUp(v => !v)}
              showNextUp={showNextUp}
              nav={nav}
              layoutTheme={theme.layoutTheme}
            />
          )}

          <AnimatePresence>
            {isFullscreen && currentTrack && (
              <motion.div
                key="fullscreen"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
                style={{ position: "fixed", inset: 0, zIndex: 200 }}
              >
                <FullscreenPlayer
                  project={currentProject!}
                  track={currentTrack}
                  player={player}
                  onTogglePlay={togglePlay}
                  onSeek={t => { audioRef.current!.currentTime = t; setPlayer(p => ({ ...p, currentTime: t })); }}
                  onVolume={v => { if (audioRef.current) audioRef.current.volume = v; setPlayer(p => ({ ...p, volume: v })); }}
                  onPrev={() => {
                    const prevPos = player.queuePos - 1;
                    if (prevPos >= 0) {
                      const item = player.queue[prevPos];
                      if (item) playTrack(item.projectId, item.trackIndex, player.queue, prevPos);
                    }
                  }}
                  onNext={() => {
                    const { queue, queuePos, shuffle } = player;
                    if (!queue.length) return;
                    const nextPos = shuffle
                      ? shuffleNext(queue, queuePos)
                      : queuePos + 1;
                    if (nextPos < queue.length) {
                      const item = queue[nextPos];
                      playTrack(item.projectId, item.trackIndex, queue, nextPos);
                    }
                  }}
                  onShuffle={() => setPlayer(p => ({ ...p, shuffle: !p.shuffle }))}
                  onClose={() => setIsFullscreen(false)}
                  toggleLike={toggleLike}
                  isLiked={isLiked}
                  layoutTheme={theme.layoutTheme}
                  fsBg={theme.fsBg}
                  analyserRef={analyserRef}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Queue push-sidebar — animates in/out, pushes content */}
        <AnimatePresence>
          {showNextUp && !isFullscreen && currentTrack && (
            <motion.div
              key="queue-sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="shrink-0 overflow-hidden border-l border-border flex flex-col"
              style={{ background: "var(--popover)", backdropFilter: "blur(40px)", WebkitBackdropFilter: "blur(40px)" }}
            >
              <div style={{ width: 320 }} className="flex flex-col h-full">
                <NextUpPanel
                  queue={player.queue}
                  queuePos={player.queuePos}
                  projects={projects}
                  onClose={() => setShowNextUp(false)}
                  onPlayAt={(pos) => {
                    const item = player.queue[pos];
                    if (item) playTrack(item.projectId, item.trackIndex, player.queue, pos);
                  }}
                  onRemove={removeFromQueue}
                  layoutTheme={theme.layoutTheme}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {showCreate && (
        <NewItemModal
          onClose={() => setShowCreate(false)}
          onCreateAlbum={proj => {
            setProjects(prev => [proj, ...prev]);
            setShowCreate(false);
            setSidebarTab("home");
            nav(`/project/${proj.id}`);
          }}
          onCreateSingle={proj => {
            setProjects(prev => [proj, ...prev]);
            setShowCreate(false);
            setSidebarTab("library");
          }}
        />
      )}

      {toast && (
        <div
          key={toast.id}
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 bg-popover border border-border rounded-lg px-5 py-2.5 text-sm font-semibold shadow-2xl pointer-events-none animate-fade-in"
        >
          <Check size={14} className="text-primary shrink-0" />
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── SidebarItem ────────────────────────────────────────────────────────────

function SidebarItem({ icon, label, active, onClick }: {
  icon: React.ReactNode; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all text-left ${
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary"
      }`}
    >
      <span className={active ? "text-primary" : ""}>{icon}</span>
      {label}
    </button>
  );
}

// ── HomeView ───────────────────────────────────────────────────────────────

interface SharedProps {
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  player: PlayerState;
  setPlayer: React.Dispatch<React.SetStateAction<PlayerState>>;
  playTrack: (pid: string, idx: number, queue?: QueueItem[], queuePos?: number) => Promise<void>;
  nav: (hash: string) => void;
  showToast: (msg: string) => void;
}

// ── Folder SVG icon (theme-aware) ─────────────────────────────────────────

function FolderIcon({ layoutTheme, size = 40 }: { layoutTheme?: LayoutTheme; size?: number }) {
  if (layoutTheme === "classic") {
    // Windows XP-style folder: yellow bevel
    return (
      <svg width={size} height={size * 0.8} viewBox="0 0 48 38" fill="none">
        <rect x="1" y="8" width="46" height="29" rx="2" fill="#f0a500" stroke="#c07800" strokeWidth="1.5"/>
        <rect x="1" y="8" width="46" height="29" rx="2" fill="url(#fg)" />
        <path d="M1 14 H47" stroke="#c07800" strokeWidth="1"/>
        <rect x="1" y="8" width="16" height="7" rx="1" fill="#f5b820" stroke="#c07800" strokeWidth="1"/>
        <defs>
          <linearGradient id="fg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.35)"/>
            <stop offset="100%" stopColor="rgba(0,0,0,0.1)"/>
          </linearGradient>
        </defs>
      </svg>
    );
  }
  if (layoutTheme === "unique") {
    // Neon wire-frame folder
    return (
      <svg width={size} height={size * 0.8} viewBox="0 0 48 38" fill="none">
        <rect x="1" y="8" width="46" height="29" rx="0" stroke="var(--primary)" strokeWidth="2" fill="none"/>
        <path d="M1 14 H47" stroke="var(--primary)" strokeWidth="1.5" opacity="0.6"/>
        <rect x="1" y="8" width="14" height="6" rx="0" stroke="var(--primary)" strokeWidth="2" fill="none"/>
        <line x1="0" y1="8" x2="6" y2="2" stroke="var(--primary)" strokeWidth="2" opacity="0.5"/>
        <line x1="14" y1="8" x2="20" y2="2" stroke="var(--primary)" strokeWidth="2" opacity="0.5"/>
      </svg>
    );
  }
  if (layoutTheme === "modern") {
    // Rounded glass folder
    return (
      <svg width={size} height={size * 0.8} viewBox="0 0 48 38" fill="none">
        <rect x="1" y="8" width="46" height="29" rx="6" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5"/>
        <path d="M1 15 H47" stroke="rgba(255,255,255,0.2)" strokeWidth="1"/>
        <rect x="1" y="8" width="16" height="8" rx="5" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5"/>
        <rect x="4" y="19" width="40" height="14" rx="3" fill="rgba(255,255,255,0.06)"/>
      </svg>
    );
  }
  // Default: clean minimal
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 48 38" fill="none">
      <rect x="1" y="8" width="46" height="29" rx="3" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5"/>
      <path d="M1 15 H47" stroke="rgba(255,255,255,0.12)" strokeWidth="1"/>
      <rect x="1" y="8" width="15" height="8" rx="2" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5"/>
    </svg>
  );
}

// ── FolderCard ─────────────────────────────────────────────────────────────

function FolderCard({
  folder, projects, isDragOver, layoutTheme, onClick,
  onRename, onDelete,
  onDragOver, onDragLeave, onDrop,
}: {
  folder: Folder; projects: Project[]; isDragOver: boolean;
  layoutTheme?: LayoutTheme;
  onClick: () => void; onRename: (name: string) => void; onDelete: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(folder.name);
  const covers = folder.projectIds
    .map(id => projects.find(p => p.id === id)?.coverDataUrl)
    .filter(Boolean)
    .slice(0, 4) as string[];

  const isUnique = layoutTheme === "unique";
  const isModern = layoutTheme === "modern";
  const isClassic = layoutTheme === "classic";

  const borderClass = isDragOver
    ? isUnique ? "ring-2 ring-primary scale-105 shadow-[0_0_24px_var(--primary)]"
      : isModern ? "ring-2 ring-white/60 scale-105 shadow-[0_0_32px_rgba(255,255,255,0.2)]"
      : "ring-2 ring-primary scale-105 shadow-xl shadow-primary/30"
    : "";

  return (
    <div
      className={`group cursor-pointer select-none transition-all duration-200 ${borderClass}`}
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Visual */}
      <div
        className={`relative aspect-square mb-3 overflow-hidden ${
          isClassic ? "border-2 border-[var(--border)] shadow-[inset_1px_1px_0_rgba(255,255,255,0.2),inset_-1px_-1px_0_rgba(0,0,0,0.35),2px_2px_4px_rgba(0,0,0,0.3)]"
          : isUnique ? "border-2 border-primary shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
          : isModern ? "rounded-3xl border border-white/12 bg-white/5 backdrop-blur"
          : "rounded-lg border border-border bg-card shadow-lg"
        }`}
        style={{ borderRadius: isClassic ? 2 : isModern ? undefined : undefined }}
      >
        {/* 2×2 mosaic of covers or placeholder */}
        {covers.length >= 2 ? (
          <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
            {[0, 1, 2, 3].map(i => (
              covers[i]
                ? <img key={i} src={covers[i]} alt="" className="w-full h-full object-cover" />
                : <div key={i} className="w-full h-full bg-muted" />
            ))}
            {/* Folder icon overlay */}
            <div className="absolute inset-0 flex items-end justify-start p-3 bg-gradient-to-t from-black/60 via-transparent to-transparent">
              <FolderIcon layoutTheme={layoutTheme} size={28} />
            </div>
          </div>
        ) : covers.length === 1 ? (
          <>
            <img src={covers[0]} alt="" className="absolute inset-0 w-full h-full object-cover opacity-70" />
            <div className="absolute inset-0 flex items-center justify-center bg-black/30">
              <FolderIcon layoutTheme={layoutTheme} size={40} />
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <FolderIcon layoutTheme={layoutTheme} size={44} />
          </div>
        )}

        {/* Drop hint */}
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-primary/20 backdrop-blur-sm">
            <p className="text-white text-xs font-bold uppercase tracking-widest">Drop to add</p>
          </div>
        )}
      </div>

      {/* Name */}
      {editingName ? (
        <div onClick={e => e.stopPropagation()} className="mb-1">
          <input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { onRename(nameDraft.trim() || folder.name); setEditingName(false); }
              if (e.key === "Escape") setEditingName(false);
            }}
            onBlur={() => { onRename(nameDraft.trim() || folder.name); setEditingName(false); }}
            className="w-full bg-secondary border border-primary/50 rounded-md px-2 py-1 text-sm font-semibold outline-none"
          />
        </div>
      ) : (
        <p
          className="font-semibold text-sm truncate leading-tight"
          onDoubleClick={e => { e.stopPropagation(); setNameDraft(folder.name); setEditingName(true); }}
        >
          {folder.name}
        </p>
      )}
      <p className="text-xs text-muted-foreground mt-0.5">{folder.projectIds.length} album{folder.projectIds.length !== 1 ? "s" : ""}</p>

      {/* Context actions */}
      <div className="flex items-center gap-1.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={e => { e.stopPropagation(); setNameDraft(folder.name); setEditingName(true); }} className="text-xs text-muted-foreground hover:text-primary transition-colors">Rename</button>
        <span className="text-muted-foreground/30 text-xs">·</span>
        <button onClick={e => { e.stopPropagation(); onDelete(); }} className="text-xs text-muted-foreground hover:text-destructive transition-colors">Delete</button>
      </div>
    </div>
  );
}

// ── HomeView ───────────────────────────────────────────────────────────────

function HomeView({
  projects, setProjects, player, playTrack, nav,
  showCreate, setShowCreate, sidebarOpen, toggleFavorite, isFavorited,
  folders, setFolders, layoutTheme,
}: SharedProps & {
  showCreate: boolean; setShowCreate: (v: boolean) => void; sidebarOpen: boolean;
  toggleFavorite: (type: "album"|"playlist", id: string) => void;
  isFavorited: (type: "album"|"playlist", id: string) => boolean;
  folders: Folder[]; setFolders: React.Dispatch<React.SetStateAction<Folder[]>>;
  layoutTheme?: LayoutTheme;
}) {
  const [query, setQuery] = useState("");
  const [albumSort, setAlbumSort] = useState<AlbumSort>("default");
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverType, setDragOverType] = useState<"project" | "folder" | "home" | null>(null);
  const [homeDropActive, setHomeDropActive] = useState(false);

  const albums = projects.filter(p => !p.isSingle);
  const currentFolder = currentFolderId ? folders.find(f => f.id === currentFolderId) ?? null : null;
  const folderedIds = new Set(folders.flatMap(f => f.projectIds));

  const visibleProjects = currentFolder
    ? albums.filter(p => currentFolder.projectIds.includes(p.id))
    : albums.filter(p => !folderedIds.has(p.id));

  const visibleFolders = currentFolder ? [] : folders;

  // Sort + filter projects
  const sortProjects = (list: Project[]) => {
    const sorted = [...list];
    switch (albumSort) {
      case "alpha-asc":   return sorted.sort((a,b) => a.name.localeCompare(b.name));
      case "alpha-desc":  return sorted.sort((a,b) => b.name.localeCompare(a.name));
      case "artist-asc":  return sorted.sort((a,b) => (a.artist||"").localeCompare(b.artist||""));
      case "artist-desc": return sorted.sort((a,b) => (b.artist||"").localeCompare(a.artist||""));
      case "newest":      return sorted.sort((a,b) => b.createdAt - a.createdAt);
      case "oldest":      return sorted.sort((a,b) => a.createdAt - b.createdAt);
      case "favorited":   return sorted.sort((a,_b) => isFavorited("album", a.id) ? -1 : 1);
      default:            return sorted;
    }
  };

  const filteredProjects = sortProjects(
    query.trim()
      ? visibleProjects.filter(p =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.artist.toLowerCase().includes(query.toLowerCase())
        )
      : visibleProjects
  );

  const filteredFolders = query.trim()
    ? visibleFolders.filter(f => f.name.toLowerCase().includes(query.toLowerCase()))
    : visibleFolders;

  // ── Drag handlers ────────────────────────────────────────────────────────

  const handleProjectDragStart = (e: React.DragEvent, projectId: string) => {
    _drag.type = "project";
    _drag.projectId = projectId;
    _drag.fromFolderId = currentFolderId;
    e.dataTransfer.effectAllowed = "move";
    // Create a custom drag image
    const el = e.currentTarget as HTMLElement;
    e.dataTransfer.setDragImage(el, el.offsetWidth / 2, el.offsetHeight / 2);
  };

  const handleProjectDragOver = (e: React.DragEvent, targetProjectId: string) => {
    if (_drag.type !== "project" || _drag.projectId === targetProjectId) return;
    e.preventDefault();
    setDragOverId(targetProjectId);
    setDragOverType("project");
  };

  const handleFolderDragOver = (e: React.DragEvent, folderId: string) => {
    if (_drag.type !== "project") return;
    e.preventDefault();
    setDragOverId(folderId);
    setDragOverType("folder");
  };

  const clearDragOver = () => { setDragOverId(null); setDragOverType(null); };

  const handleProjectDrop = (e: React.DragEvent, targetProjectId: string) => {
    e.preventDefault();
    clearDragOver();
    if (_drag.type !== "project" || _drag.projectId === targetProjectId) return;

    // Create a new folder with both projects
    const newFolder: Folder = {
      id: genId(),
      name: "New Folder",
      projectIds: [_drag.projectId, targetProjectId],
      createdAt: Date.now(),
    };
    // Remove both from any existing folders
    setFolders(prev => [
      ...prev.map(f => ({ ...f, projectIds: f.projectIds.filter(id => id !== _drag.projectId && id !== targetProjectId) })).filter(f => f.projectIds.length > 0),
      newFolder,
    ]);
    _drag.type = null;
  };

  const handleFolderDrop = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    clearDragOver();
    if (_drag.type !== "project") return;
    const pid = _drag.projectId;
    setFolders(prev => prev.map(f => {
      if (f.id === folderId) {
        // Add to this folder (avoid duplicates)
        return f.projectIds.includes(pid) ? f : { ...f, projectIds: [...f.projectIds, pid] };
      }
      // Remove from any other folder it was in
      return { ...f, projectIds: f.projectIds.filter(id => id !== pid) };
    }).filter(f => f.projectIds.length > 0));
    _drag.type = null;
  };

  const handleHomeDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setHomeDropActive(false);
    if (_drag.type !== "project") return;
    const pid = _drag.projectId;
    // Remove from all folders
    setFolders(prev => prev.map(f => ({ ...f, projectIds: f.projectIds.filter(id => id !== pid) })).filter(f => f.projectIds.length > 0));
    setCurrentFolderId(null);
    _drag.type = null;
  };

  const handleFolderRename = (folderId: string, name: string) =>
    setFolders(prev => prev.map(f => f.id === folderId ? { ...f, name } : f));

  const handleFolderDelete = (folderId: string) =>
    setFolders(prev => prev.filter(f => f.id !== folderId));

  const totalItems = filteredFolders.length + filteredProjects.length;
  const hasContent = albums.length > 0 || folders.length > 0;

  return (
    <div className="min-h-full pb-4">
      <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-3xl border-b border-border">
        <div className="px-6 py-4 flex items-center gap-3 flex-wrap" style={{ paddingLeft: !sidebarOpen ? 48 : 24 }}>
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              className={`text-sm font-bold transition-colors ${currentFolder ? "text-muted-foreground hover:text-foreground" : "text-foreground"}`}
              onClick={() => setCurrentFolderId(null)}
              onDragOver={e => { e.preventDefault(); setHomeDropActive(true); }}
              onDragLeave={() => setHomeDropActive(false)}
              onDrop={handleHomeDrop}
              style={homeDropActive ? { color: "var(--primary)", textShadow: "0 0 8px var(--primary)" } : {}}
            >
              Home
            </button>
            {currentFolder && (
              <>
                <ChevronLeft size={14} className="text-muted-foreground rotate-180" />
                <span className="text-sm font-bold truncate max-w-32">{currentFolder.name}</span>
              </>
            )}
          </div>

          {/* Search + Sort */}
          {hasContent && (
            <>
              <div className="flex-1 min-w-[140px] max-w-xs relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search…"
                  className="w-full bg-secondary border border-border rounded-md pl-8 pr-3 py-2 text-sm outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50" />
                {query && <button onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X size={13} /></button>}
              </div>
              <SortDropdown<AlbumSort>
                value={albumSort}
                onChange={setAlbumSort}
                options={ALBUM_SORT_OPTIONS}
              />
            </>
          )}

          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-primary hover:bg-primary/85 text-white px-4 py-2 rounded-md text-sm font-semibold transition-all active:scale-95 shadow-md shadow-primary/20 ml-auto shrink-0">
            <Plus size={14} strokeWidth={2.5} />
            New Project
          </button>
        </div>

        {/* Home drop zone hint (when dragging from inside a folder) */}
        {homeDropActive && (
          <div className="px-6 pb-3">
            <div className="border-2 border-dashed border-primary/60 rounded-lg py-2 text-center text-xs font-semibold text-primary animate-pulse">
              Drop here to move to Home
            </div>
          </div>
        )}
      </header>

      <main className="px-6 pt-8 pb-10">
        {!hasContent ? (
          <EmptyState onCreate={() => setShowCreate(true)} />
        ) : totalItems === 0 && query ? (
          <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-center">
            <Search size={36} className="text-muted-foreground/25" />
            <p className="font-semibold text-muted-foreground">Nothing matches "{query}"</p>
            <button onClick={() => setQuery("")} className="text-primary text-sm font-medium">Clear search</button>
          </div>
        ) : (
          <section>
            <div className="flex items-end justify-between mb-7">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1">
                  {currentFolder ? `Inside "${currentFolder.name}"` : query ? `Results for "${query}"` : "All Projects"}
                </p>
                <h2 className="text-2xl font-bold tracking-tight">{currentFolder ? currentFolder.name : "Projects"}</h2>
              </div>
              <p className="text-sm text-muted-foreground">{totalItems} item{totalItems !== 1 ? "s" : ""}</p>
            </div>

            {/* Tip for first use */}
            {!currentFolder && albums.length >= 2 && folders.length === 0 && !query && (
              <p className="text-xs text-muted-foreground/50 mb-5 italic">Tip: drag one album on top of another to create a folder</p>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
              {/* Folders first */}
              {filteredFolders.map(folder => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  projects={projects}
                  isDragOver={dragOverId === folder.id && dragOverType === "folder"}
                  layoutTheme={layoutTheme}
                  onClick={() => { setCurrentFolderId(folder.id); setQuery(""); }}
                  onRename={name => handleFolderRename(folder.id, name)}
                  onDelete={() => handleFolderDelete(folder.id)}
                  onDragOver={e => handleFolderDragOver(e, folder.id)}
                  onDragLeave={clearDragOver}
                  onDrop={e => handleFolderDrop(e, folder.id)}
                />
              ))}

              {/* Albums */}
              {filteredProjects.map(proj => (
                <ProjectCard
                  key={proj.id}
                  project={proj}
                  isActive={player.projectId === proj.id}
                  isPlaying={player.projectId === proj.id && player.isPlaying}
                  isDragOver={dragOverId === proj.id && dragOverType === "project"}
                  onOpen={() => nav(`/project/${proj.id}`)}
                  onPlay={() => {
                    if (!proj.tracks.length) return;
                    const q = proj.tracks.map((_, i) => ({ projectId: proj.id, trackIndex: i }));
                    playTrack(proj.id, 0, q, 0);
                  }}
                  favorited={isFavorited("album", proj.id)}
                  onToggleFavorite={e => { e.stopPropagation(); toggleFavorite("album", proj.id); }}
                  onDragStart={e => handleProjectDragStart(e, proj.id)}
                  onDragOver={e => handleProjectDragOver(e, proj.id)}
                  onDragLeave={clearDragOver}
                  onDrop={e => handleProjectDrop(e, proj.id)}
                />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center px-4">
      <div className="text-muted-foreground/30"><CassetteLogo size={64} /></div>
      <div>
        <h2 className="text-2xl font-bold mb-2">Your library is empty</h2>
        <p className="text-muted-foreground max-w-xs">Create a project to organize your music. Add tracks, a cover, and share it with anyone.</p>
      </div>
      <button onClick={onCreate} className="flex items-center gap-2 bg-primary text-white px-6 py-3 rounded-md font-semibold hover:bg-primary/85 transition-all active:scale-95 shadow-md shadow-primary/20">
        <Plus size={16} />
        Create your first project
      </button>
    </div>
  );
}

function ProjectCard({
  project, isActive, isPlaying, isDragOver, onOpen, onPlay, favorited, onToggleFavorite,
  onDragStart, onDragOver, onDragLeave, onDrop,
}: {
  project: Project; isActive: boolean; isPlaying: boolean; isDragOver?: boolean;
  onOpen: () => void; onPlay: () => void;
  favorited?: boolean; onToggleFavorite?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  return (
    <div
      className={`group cursor-pointer select-none transition-all duration-200 ${isDragOver ? "scale-105 ring-2 ring-primary shadow-xl shadow-primary/30" : ""}`}
      draggable={!!onDragStart}
      onClick={onOpen}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="relative aspect-square rounded-lg overflow-hidden bg-card border border-border mb-3 shadow-lg transition-transform duration-200 group-hover:-translate-y-1">
        {project.coverDataUrl ? (
          <img src={project.coverDataUrl} alt={project.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-card">
            <Music size={36} className="text-muted-foreground/30" />
          </div>
        )}
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-primary/20 backdrop-blur-sm">
            <p className="text-white text-xs font-bold uppercase tracking-widest">Create folder</p>
          </div>
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-200 flex items-end justify-end p-3">
          <button onClick={e => { e.stopPropagation(); onPlay(); }}
            className="opacity-0 group-hover:opacity-100 transition-all duration-200 w-11 h-11 bg-primary rounded-md flex items-center justify-center shadow-xl scale-75 group-hover:scale-100">
            {isPlaying ? <Pause size={18} className="text-white" /> : <Play size={18} className="text-white ml-0.5" />}
          </button>
        </div>
        {onToggleFavorite && (
          <button onClick={onToggleFavorite}
            className={`absolute top-2 left-2 p-1.5 rounded-md bg-black/40 transition-all opacity-0 group-hover:opacity-100 ${favorited ? "text-yellow-400" : "text-white/70 hover:text-yellow-400"}`}>
            <Star size={13} fill={favorited ? "currentColor" : "none"} strokeWidth={favorited ? 0 : 1.5} />
          </button>
        )}
        {isActive && !isPlaying && <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-primary shadow-lg shadow-primary/50" />}
        {isPlaying && <div className="absolute top-2 right-2"><NowPlayingDots /></div>}
      </div>
      <p className="font-semibold text-sm truncate leading-tight">{project.name}</p>
      <p className="text-xs text-muted-foreground truncate mt-0.5">{project.artist || "Unknown Artist"}</p>
      <p className="text-xs text-muted-foreground/50 mt-0.5">{project.tracks.length} track{project.tracks.length !== 1 ? "s" : ""}</p>
    </div>
  );
}

// ── Sort types & SortDropdown component ───────────────────────────────────

type AlbumSort = "default" | "alpha-asc" | "alpha-desc" | "artist-asc" | "artist-desc" | "newest" | "oldest" | "favorited";
type TrackSort = "default" | "alpha-asc" | "alpha-desc" | "artist-asc" | "artist-desc" | "liked-first" | "album-asc";

const ALBUM_SORT_OPTIONS: { value: AlbumSort; label: string }[] = [
  { value: "default",    label: "Date added" },
  { value: "newest",     label: "Newest first" },
  { value: "oldest",     label: "Oldest first" },
  { value: "alpha-asc",  label: "A → Z" },
  { value: "alpha-desc", label: "Z → A" },
  { value: "artist-asc", label: "Artist A → Z" },
  { value: "artist-desc",label: "Artist Z → A" },
  { value: "favorited",  label: "Favorites first" },
];

const TRACK_SORT_OPTIONS: { value: TrackSort; label: string }[] = [
  { value: "default",    label: "Album order" },
  { value: "liked-first",label: "Liked first" },
  { value: "alpha-asc",  label: "A → Z" },
  { value: "alpha-desc", label: "Z → A" },
  { value: "artist-asc", label: "Artist A → Z" },
  { value: "artist-desc",label: "Artist Z → A" },
  { value: "album-asc",  label: "Album A → Z" },
];

function SortDropdown<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-md border text-sm font-medium transition-all ${
          open || value !== options[0].value
            ? "border-primary/40 text-primary bg-primary/8"
            : "border-border text-muted-foreground hover:text-foreground hover:border-border/60"
        }`}
      >
        <ArrowUpDown size={13} />
        <span className="max-w-[100px] truncate">{selected?.label ?? "Sort"}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="animate-pop-in absolute right-0 top-full mt-1.5 z-50 bg-popover border border-border rounded-lg shadow-2xl overflow-hidden min-w-[168px]">
          {options.map(opt => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`w-full flex items-center justify-between px-4 py-2.5 text-sm text-left transition-colors hover:bg-secondary ${
                opt.value === value ? "text-primary font-semibold" : "text-foreground"
              }`}
            >
              {opt.label}
              {opt.value === value && <Check size={13} className="text-primary shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NowPlayingDots() {
  return (
    <div className="flex items-end gap-0.5 h-4">
      {[0, 1, 2].map(i => (
        <div key={i} className="w-1 bg-primary rounded-full"
          style={{ animation: `equalizerBounce 0.9s ease-in-out ${i * 0.15}s infinite alternate`, height: "100%" }} />
      ))}
      <style>{`@keyframes equalizerBounce { from { height: 30%; } to { height: 100%; } }`}</style>
    </div>
  );
}

// ── ProjectView ────────────────────────────────────────────────────────────

function ProjectView({ projects, setProjects, player, playTrack, nav, showToast, projectId, sidebarOpen, toggleLike, isLiked, toggleFavorite, isFavorited, addToFront, addToBack }: SharedProps & { projectId: string; sidebarOpen: boolean; toggleLike: (pid: string, tid: string) => void; isLiked: (pid: string, tid: string) => boolean; toggleFavorite: (type: "album"|"playlist", id: string) => void; isFavorited: (type: "album"|"playlist", id: string) => boolean; addToFront?: (pid: string, tidx: number) => void; addToBack?: (pid: string, tidx: number) => void; }) {
  const project = projects.find(p => p.id === projectId) ?? null;
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showEdit, setShowEdit] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-32">
        <Music size={48} className="text-muted-foreground/30" />
        <p className="text-muted-foreground">Project not found</p>
        <button onClick={() => nav("/")} className="text-primary text-sm font-semibold">← Back to Library</button>
      </div>
    );
  }

  const update = (u: Partial<Project>) =>
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, ...u } : p));

  const handleAddTracks = async (files: FileList) => {
    setUploading(true);
    const newTracks: Track[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.includes("audio") && !file.name.match(/\.(mp3|wav|ogg|flac|aac|m4a)$/i)) continue;
      const id = genId();
      const audioKey = `audio_${id}`;
      await dbPut(audioKey, file);
      const duration = await getAudioDuration(file);
      const name = file.name.replace(/\.[^.]+$/, "");
      newTracks.push({ id, name, audioKey, duration });
    }
    update({ tracks: [...project.tracks, ...newTracks] });
    setUploading(false);
    if (newTracks.length > 0) showToast(`${newTracks.length} track${newTracks.length > 1 ? "s" : ""} added`);
  };

  const handleDeleteTrack = async (track: Track) => {
    await dbDel(track.audioKey);
    update({ tracks: project.tracks.filter(t => t.id !== track.id) });
    showToast("Track removed");
  };

  const handleRename = (trackId: string, name: string) => {
    update({ tracks: project.tracks.map(t => t.id === trackId ? { ...t, name } : t) });
    setEditingTrackId(null);
  };

  const handleShare = () => {
    const url = `${window.location.origin}${window.location.pathname}#/share/${projectId}`;
    navigator.clipboard.writeText(url).then(() => showToast("Share link copied!")).catch(() => { prompt("Copy this link:", url); });
  };

  const handleDeleteProject = async () => {
    if (!window.confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
    for (const t of project.tracks) await dbDel(t.audioKey);
    setProjects(prev => prev.filter(p => p.id !== projectId));
    nav("/");
  };

  const totalDuration = project.tracks.reduce((s, t) => s + t.duration, 0);

  // File drop handlers — let users drag MP3s directly onto the page
  const handlePageDragOver = (e: React.DragEvent) => {
    if ([...e.dataTransfer.items].some(item => item.kind === "file")) {
      e.preventDefault();
      setFileDragOver(true);
    }
  };
  const handlePageDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileDragOver(false);
  };
  const handlePageDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setFileDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length) handleAddTracks(files);
  };

  return (
    <div
      className="min-h-full pb-4 relative"
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
    >
      {/* File-drop overlay */}
      {fileDragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/85 backdrop-blur-md border-4 border-dashed border-primary/60 pointer-events-none">
          <Upload size={48} className="text-primary animate-bounce" />
          <p className="text-xl font-bold text-primary">Drop audio files to add them</p>
          <p className="text-sm text-muted-foreground">MP3, WAV, FLAC, AAC and more</p>
        </div>
      )}

      <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-3xl border-b border-border">
        <div className="px-6 py-3.5 flex items-center gap-4" style={{ paddingLeft: !sidebarOpen ? 48 : 24 }}>
          <button
            onClick={() => nav("/")}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm font-semibold"
          >
            <ChevronLeft size={16} />
            Library
          </button>
          <div className="flex-1" />
          <button
            onClick={handleShare}
            className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-primary transition-colors"
          >
            <Share2 size={15} />
            Share
          </button>
          <VisibilityToggle isPublic={project.isPublic !== false} onChange={v => update({ isPublic: v })} />
        </div>
      </header>

      {/* Hero */}
      <div className="relative overflow-hidden">
        {project.coverDataUrl && (
          <div
            className="absolute inset-0 opacity-20 blur-3xl scale-110"
            style={{ backgroundImage: `url(${project.coverDataUrl})`, backgroundSize: "cover", backgroundPosition: "center" }}
          />
        )}
        <div className="relative px-6 pt-10 pb-8 max-w-5xl mx-auto">
          <div className="flex flex-col sm:flex-row gap-8 items-start">
            <div className="group relative w-48 h-48 shrink-0 rounded-lg overflow-hidden bg-card border border-border shadow-2xl mx-auto sm:mx-0">
              {project.coverDataUrl ? (
                <img src={project.coverDataUrl} alt={project.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-secondary to-card">
                  <Music size={52} className="text-muted-foreground/25" />
                </div>
              )}
              <label className="absolute inset-0 bg-black/0 group-hover:bg-black/60 transition-all cursor-pointer flex flex-col items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100">
                <ImagePlus size={22} className="text-white" />
                <span className="text-white text-xs font-semibold">Change Cover</span>
                <input type="file" accept="image/*,image/gif" className="hidden" onChange={async e => {
                  const input = e.target;
                  const file = input.files?.[0];
                  input.value = "";
                  if (!file) return;
                  const dataUrl = await processCover(file);
                  if (dataUrl) update({ coverDataUrl: dataUrl });
                }} />
              </label>
            </div>

            <div className="flex-1 min-w-0 flex flex-col justify-end">
              <p className="text-xs font-bold text-primary uppercase tracking-widest mb-2">Project</p>
              {showEdit ? (
                <EditProjectForm
                  project={project}
                  onSave={(name, artist) => { update({ name, artist }); setShowEdit(false); }}
                  onCancel={() => setShowEdit(false)}
                />
              ) : (
                <>
                  <h1 className="text-4xl font-extrabold tracking-tight mb-1 truncate">{project.name}</h1>
                  <p className="text-lg text-muted-foreground mb-1">{project.artist || "Unknown Artist"}</p>
                  <p className="text-sm text-muted-foreground/60 mb-7">
                    {project.tracks.length} track{project.tracks.length !== 1 ? "s" : ""}
                    {totalDuration > 0 && ` · ${fmt(totalDuration)}`}
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={() => {
                        if (!project.tracks.length) return;
                        const q = project.tracks.map((_, i) => ({ projectId, trackIndex: i }));
                        playTrack(projectId, 0, q, 0);
                      }}
                      disabled={project.tracks.length === 0}
                      className="flex items-center gap-2.5 bg-primary text-white px-7 py-3 rounded-md font-bold text-sm hover:bg-primary/85 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-primary/20"
                    >
                      <Play size={17} className="ml-0.5" />
                      Play All
                    </button>
                    <button onClick={() => setShowEdit(true)} className="flex items-center gap-2 px-4 py-3 rounded-md border border-border text-sm font-semibold hover:bg-card transition-colors">
                      <Edit2 size={13} />
                      Edit Info
                    </button>
                    <button onClick={handleShare} className="flex items-center gap-2 px-4 py-3 rounded-md border border-border text-sm font-semibold hover:bg-card transition-colors">
                      <Link2 size={13} />
                      Share Link
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Track list */}
      <div className="px-6 pb-12 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4 mt-2">
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
            <ListMusic size={13} />
            Tracks
          </h3>
          <label className={`flex items-center gap-2 cursor-pointer border border-border hover:border-primary/40 hover:text-primary px-4 py-2 rounded-md text-sm font-semibold transition-all ${uploading ? "opacity-60 pointer-events-none" : ""}`}>
            <Upload size={13} />
            {uploading ? "Adding…" : "Add Tracks"}
            <input type="file" accept="audio/*,.mp3,.wav,.ogg,.flac,.aac,.m4a" multiple className="hidden" disabled={uploading}
              onChange={e => e.target.files && handleAddTracks(e.target.files)} />
          </label>
        </div>

        {project.tracks.length === 0 ? (
          <label className="flex flex-col items-center justify-center gap-3 border-2 border-dashed border-border rounded-lg py-16 cursor-pointer hover:border-primary/40 hover:bg-card/50 transition-all group">
            <Upload size={32} className="text-muted-foreground/30 group-hover:text-primary/50 transition-colors" />
            <p className="font-semibold text-muted-foreground">Drop audio files here or click to upload</p>
            <p className="text-xs text-muted-foreground/50">MP3, WAV, FLAC, AAC and more</p>
            <input type="file" accept="audio/*" multiple className="hidden" onChange={e => e.target.files && handleAddTracks(e.target.files)} />
          </label>
        ) : (
          <TrackList
            tracks={project.tracks}
            projectId={projectId}
            player={player}
            playTrack={playTrack}
            onReorder={newTracks => update({ tracks: newTracks })}
            onDelete={handleDeleteTrack}
            editingTrackId={editingTrackId}
            editingName={editingName}
            onStartEdit={(track) => { setEditingTrackId(track.id); setEditingName(track.name); }}
            onEditName={setEditingName}
            onSaveEdit={(track) => handleRename(track.id, editingName.trim() || track.name)}
            onCancelEdit={() => setEditingTrackId(null)}
            toggleLike={toggleLike}
            isLiked={isLiked}
            addToFront={addToFront}
            addToBack={addToBack}
          />
        )}

        <div className="mt-14 pt-6 border-t border-border/40">
          <button onClick={handleDeleteProject} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive transition-colors font-medium">
            <Trash2 size={13} />
            Delete Project
          </button>
        </div>
      </div>
    </div>
  );
}

// ── TrackList (with drag-to-reorder) ──────────────────────────────────────

function TrackList({
  tracks, projectId, player, playTrack, onReorder, onDelete,
  editingTrackId, editingName, onStartEdit, onEditName, onSaveEdit, onCancelEdit,
  toggleLike, isLiked, addToFront, addToBack,
}: {
  tracks: Track[]; projectId: string;
  player: PlayerState; playTrack: (pid: string, idx: number, queue?: QueueItem[], queuePos?: number) => Promise<void>;
  onReorder: (tracks: Track[]) => void;
  onDelete: (track: Track) => void;
  editingTrackId: string | null; editingName: string;
  onStartEdit: (track: Track) => void; onEditName: (v: string) => void;
  onSaveEdit: (track: Track) => void; onCancelEdit: () => void;
  toggleLike?: (pid: string, tid: string) => void;
  isLiked?: (pid: string, tid: string) => boolean;
  addToFront?: (pid: string, tidx: number) => void;
  addToBack?: (pid: string, tidx: number) => void;
}) {
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [locked, setLocked] = useState(true);

  // Project queue: all tracks in this project
  const projectQueue = tracks.map((_, i) => ({ projectId, trackIndex: i }));

  const onDragStart = (idx: number) => { if (locked) return; dragIdx.current = idx; };
  const onDragOver = (e: React.DragEvent, idx: number) => { if (locked) return; e.preventDefault(); setOverIdx(idx); };
  const onDrop = (e: React.DragEvent, idx: number) => {
    if (locked) return;
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) { dragIdx.current = null; setOverIdx(null); return; }
    const reordered = [...tracks];
    const [moved] = reordered.splice(dragIdx.current, 1);
    reordered.splice(idx, 0, moved);
    onReorder(reordered);
    dragIdx.current = null;
    setOverIdx(null);
  };
  const onDragEnd = () => { dragIdx.current = null; setOverIdx(null); };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <button
          onClick={() => setLocked(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold border transition-all active:scale-95 ${
            locked
              ? "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
              : "border-primary/50 text-primary bg-primary/10 hover:bg-primary/15"
          }`}
          title={locked ? "Unlock to reorder tracks" : "Lock reordering"}
        >
          {locked ? <Lock size={11} /> : <Unlock size={11} />}
          {locked ? "Reorder locked" : "Reorder unlocked"}
        </button>
      </div>
      <div className={`rounded-lg border transition-colors ${locked ? "border-border" : "border-primary/40 ring-1 ring-primary/10"}`}>
        {tracks.map((track, idx) => (
          <TrackRow
            key={track.id}
            track={track}
            index={idx}
            isActive={player.projectId === projectId && player.trackIndex === idx}
            isPlaying={player.projectId === projectId && player.trackIndex === idx && player.isPlaying}
            isLast={idx === tracks.length - 1}
            isDragOver={overIdx === idx}
            reorderUnlocked={!locked}
            onPlay={() => playTrack(projectId, idx, projectQueue, idx)}
            onDelete={() => onDelete(track)}
            isEditing={editingTrackId === track.id}
            editingName={editingName}
            onStartEdit={() => onStartEdit(track)}
            onEditName={onEditName}
            onSaveEdit={() => onSaveEdit(track)}
            onCancelEdit={onCancelEdit}
            onDragStart={() => onDragStart(idx)}
            onDragOver={e => onDragOver(e, idx)}
            onDrop={e => onDrop(e, idx)}
            onDragEnd={onDragEnd}
            liked={isLiked ? isLiked(projectId, track.id) : undefined}
            onToggleLike={toggleLike ? () => toggleLike(projectId, track.id) : undefined}
            onAddToFront={addToFront ? () => addToFront(projectId, idx) : undefined}
            onAddToBack={addToBack ? () => addToBack(projectId, idx) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function QueueDropdown({ onAddToFront, onAddToBack }: {
  onAddToFront?: () => void; onAddToBack?: () => void; isLast?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placeAbove: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const menuH = 90;
    const menuW = 170;
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceBelow < menuH + 12;
    const top = placeAbove ? rect.top - menuH - 4 : rect.bottom + 4;
    const left = Math.min(window.innerWidth - menuW - 8, Math.max(8, rect.right - menuW));
    setPos({ top, left, placeAbove });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const scroll = () => setOpen(false);
    document.addEventListener("mousedown", handler);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
    };
  }, [open]);

  return (
    <div className="relative opacity-0 group-hover:opacity-100 transition-all">
      <button
        ref={btnRef}
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        className={`p-1.5 rounded-md hover:bg-secondary transition-colors ${open ? "text-primary bg-secondary opacity-100" : "text-muted-foreground hover:text-primary"}`}
        title="Add to queue"
      >
        <Plus size={13} />
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          className="animate-pop-in fixed z-[9999] flex flex-col bg-popover border border-border rounded-lg shadow-2xl overflow-hidden min-w-[160px]"
          style={{ top: pos.top, left: pos.left }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => { onAddToFront?.(); setOpen(false); }}
            className="flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-left hover:bg-secondary transition-colors whitespace-nowrap"
          >
            <SkipForward size={12} className="text-primary" />
            Play next
          </button>
          <button
            onClick={() => { onAddToBack?.(); setOpen(false); }}
            className="flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-left hover:bg-secondary transition-colors whitespace-nowrap border-t border-border"
          >
            <Plus size={12} className="text-muted-foreground" />
            Add to queue
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

function TrackRow({
  track, index, isActive, isPlaying, isLast, isDragOver, reorderUnlocked, onPlay, onDelete,
  isEditing, editingName, onStartEdit, onEditName, onSaveEdit, onCancelEdit,
  onDragStart, onDragOver, onDrop, onDragEnd, liked, onToggleLike,
  onAddToFront, onAddToBack,
}: {
  track: Track; index: number; isActive: boolean; isPlaying: boolean; isLast: boolean; isDragOver: boolean;
  reorderUnlocked?: boolean;
  onPlay: () => void; onDelete: () => void;
  isEditing: boolean; editingName: string;
  onStartEdit: () => void; onEditName: (v: string) => void;
  onSaveEdit: () => void; onCancelEdit: () => void;
  onDragStart: () => void; onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void; onDragEnd: () => void;
  liked?: boolean; onToggleLike?: () => void;
  onAddToFront?: () => void; onAddToBack?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (isEditing) inputRef.current?.focus(); }, [isEditing]);

  return (
    <div
      draggable={!!reorderUnlocked}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group flex items-center gap-3 px-3 py-3 transition-colors select-none
        ${isActive ? "bg-primary/8" : "hover:bg-card"}
        ${!isLast ? "border-b border-border" : ""}
        ${isDragOver ? "border-t-2 border-primary bg-primary/5" : ""}
        ${reorderUnlocked ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}
      `}
      onClick={!isEditing ? onPlay : undefined}
    >
      {/* Drag handle */}
      <div
        className={`shrink-0 p-1.5 -m-1 rounded-md transition-all ${
          reorderUnlocked
            ? "text-primary/70 hover:text-primary hover:bg-primary/10 cursor-grab active:cursor-grabbing"
            : "text-muted-foreground/25 cursor-not-allowed"
        }`}
        onClick={e => e.stopPropagation()}
        title={reorderUnlocked ? "Drag to reorder" : "Unlock reordering to move tracks"}
      >
        <GripVertical size={16} />
      </div>

      {/* Index / playing indicator */}
      <div className="w-7 shrink-0 text-center">
        {isPlaying ? (
          <div className="flex items-end justify-center gap-0.5 h-4">
            {[0, 1, 2].map(i => (
              <div key={i} className="w-0.5 bg-primary rounded-full"
                style={{ animation: `equalizerBounce 0.9s ease-in-out ${i * 0.15}s infinite alternate`, height: "100%" }} />
            ))}
          </div>
        ) : (
          <>
            <span className={`text-xs font-medium group-hover:hidden ${isActive ? "text-primary" : "text-muted-foreground"}`}>{index + 1}</span>
            <Play size={13} className="hidden group-hover:block text-foreground mx-auto" />
          </>
        )}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            ref={inputRef}
            value={editingName}
            onChange={e => onEditName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") onSaveEdit(); if (e.key === "Escape") onCancelEdit(); }}
            onClick={e => e.stopPropagation()}
            className="w-full bg-secondary border border-primary/40 rounded-md px-3 py-1.5 text-sm font-semibold outline-none focus:border-primary"
          />
        ) : (
          <p className={`text-sm font-semibold truncate ${isActive ? "text-primary" : ""}`}>{track.name}</p>
        )}
      </div>

      <span className="text-xs text-muted-foreground tabular-nums shrink-0">{fmt(track.duration)}</span>

      <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
        {isEditing ? (
          <>
            <button onClick={onSaveEdit} className="p-1.5 rounded-md hover:bg-primary/20 text-primary transition-colors"><Check size={14} /></button>
            <button onClick={onCancelEdit} className="p-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground"><X size={14} /></button>
          </>
        ) : (
          <>
            {onToggleLike && (
              <button onClick={onToggleLike} className={`p-1.5 rounded-md transition-all active:scale-90 ${liked ? "text-red-400" : "text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100"}`}>
                <Heart size={13} fill={liked ? "currentColor" : "none"} strokeWidth={liked ? 0 : 1.5} />
              </button>
            )}
            {/* Queue dropdown — click-based for reliability */}
            {onAddToFront && (
              <QueueDropdown
                onAddToFront={onAddToFront}
                onAddToBack={onAddToBack}
                isLast={isLast}
              />
            )}
            <button onClick={onStartEdit} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-secondary transition-all text-muted-foreground hover:text-foreground"><Edit2 size={13} /></button>
            <button onClick={onDelete} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-destructive/15 transition-all text-muted-foreground hover:text-destructive"><Trash2 size={13} /></button>
          </>
        )}
      </div>
    </div>
  );
}

function EditProjectForm({ project, onSave, onCancel }: { project: Project; onSave: (n: string, a: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(project.name);
  const [artist, setArtist] = useState(project.artist);
  return (
    <div className="space-y-3">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Project name"
        className="w-full bg-secondary border border-border rounded-md px-4 py-3 text-lg font-bold outline-none focus:border-primary transition-colors" />
      <input value={artist} onChange={e => setArtist(e.target.value)} placeholder="Artist name"
        className="w-full bg-secondary border border-border rounded-md px-4 py-3 text-sm font-medium outline-none focus:border-primary transition-colors text-muted-foreground" />
      <div className="flex items-center gap-2 pt-1">
        <button onClick={() => onSave(name.trim() || project.name, artist.trim())} className="flex items-center gap-2 bg-primary text-white px-5 py-2 rounded-md text-sm font-semibold hover:bg-primary/85 transition-all">
          <Check size={14} /> Save
        </button>
        <button onClick={onCancel} className="px-4 py-2 rounded-md text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
      </div>
    </div>
  );
}

// ── ShareView ──────────────────────────────────────────────────────────────

function ShareView({ projects, player, playTrack, nav, projectId }: SharedProps & { projectId: string }) {
  const project = projects.find(p => p.id === projectId) ?? null;

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-6 text-center px-4">
        <div className="text-muted-foreground/30"><CassetteLogo size={56} /></div>
        <div>
          <h2 className="text-2xl font-bold mb-2">Project not available</h2>
          <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
            This project was shared from another device or browser. Music is stored locally and can only be played on the device it was uploaded from.
          </p>
        </div>
        <button onClick={() => nav("/")} className="text-primary font-semibold text-sm">← Open my library</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-32">
      {project.coverDataUrl && (
        <div className="fixed inset-0 opacity-10 blur-3xl scale-150 pointer-events-none"
          style={{ backgroundImage: `url(${project.coverDataUrl})`, backgroundSize: "cover", backgroundPosition: "center" }} />
      )}

      <header className="relative z-10 sticky top-0 bg-background/70 backdrop-blur-3xl border-b border-border">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="text-foreground"><CassetteLogo size={28} /></div>
          <button onClick={() => nav("/")} className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors">Open Library</button>
        </div>
      </header>

      <div className="relative z-10 max-w-3xl mx-auto px-6 pt-12 pb-10">
        <div className="flex flex-col sm:flex-row gap-7 items-center sm:items-end mb-10">
          <div className="w-52 h-52 shrink-0 rounded-lg overflow-hidden bg-card border border-border shadow-2xl">
            {project.coverDataUrl
              ? <img src={project.coverDataUrl} alt={project.name} className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-secondary to-card"><Music size={52} className="text-muted-foreground/25" /></div>
            }
          </div>
          <div className="text-center sm:text-left">
            <p className="text-xs font-bold text-primary uppercase tracking-widest mb-2">Shared Project</p>
            <h1 className="text-4xl font-extrabold tracking-tight mb-1">{project.name}</h1>
            <p className="text-lg text-muted-foreground mb-5">{project.artist || "Unknown Artist"}</p>
            <button
              onClick={() => {
                if (!project.tracks.length) return;
                const q = project.tracks.map((_, i) => ({ projectId: project.id, trackIndex: i }));
                playTrack(project.id, 0, q, 0);
              }}
              disabled={project.tracks.length === 0}
              className="inline-flex items-center gap-2.5 bg-primary text-white px-7 py-3 rounded-md font-bold text-sm hover:bg-primary/85 transition-all active:scale-95 disabled:opacity-40 shadow-md shadow-primary/20"
            >
              <Play size={17} className="ml-0.5" />
              Play All
            </button>
          </div>
        </div>

        {project.tracks.length > 0 && (
          <div className="rounded-lg border border-border overflow-hidden">
            {project.tracks.map((track, idx) => {
              const isActive = player.projectId === project.id && player.trackIndex === idx;
              const isPlaying = isActive && player.isPlaying;
              return (
                <div key={track.id} onClick={() => { const q = project.tracks.map((_, i) => ({ projectId: project.id, trackIndex: i })); playTrack(project.id, idx, q, idx); }}
                  className={`group flex items-center gap-4 px-4 py-3.5 cursor-pointer transition-colors ${isActive ? "bg-primary/10" : "hover:bg-card"} ${idx < project.tracks.length - 1 ? "border-b border-border" : ""}`}
                >
                  <div className="w-8 shrink-0 text-center">
                    {isPlaying ? (
                      <div className="flex items-end justify-center gap-0.5 h-4">
                        {[0, 1, 2].map(i => (
                          <div key={i} className="w-0.5 bg-primary rounded-full"
                            style={{ animation: `equalizerBounce 0.9s ease-in-out ${i * 0.15}s infinite alternate`, height: "100%" }} />
                        ))}
                      </div>
                    ) : (
                      <>
                        <span className={`text-xs font-medium group-hover:hidden ${isActive ? "text-primary" : "text-muted-foreground"}`}>{idx + 1}</span>
                        <Play size={14} className="hidden group-hover:block text-foreground mx-auto" />
                      </>
                    )}
                  </div>
                  <p className={`flex-1 text-sm font-semibold truncate ${isActive ? "text-primary" : ""}`}>{track.name}</p>
                  <span className="text-xs text-muted-foreground tabular-nums">{fmt(track.duration)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── AllTracksView ──────────────────────────────────────────────────────────

function AllTracksView({ projects, player, playTrack, nav, sidebarOpen, toggleLike, isLiked, toggleFavorite, isFavorited, addToFront, addToBack }: SharedProps & { sidebarOpen: boolean; toggleLike: (pid: string, tid: string) => void; isLiked: (pid: string, tid: string) => boolean; toggleFavorite: (type: "album"|"playlist", id: string) => void; isFavorited: (type: "album"|"playlist", id: string) => boolean; addToFront?: (pid: string, tidx: number) => void; addToBack?: (pid: string, tidx: number) => void; }) {
  const [query, setQuery] = useState("");
  const [trackSort, setTrackSort] = useState<TrackSort>("default");

  const allTracks = projects.flatMap(proj =>
    proj.tracks.map((track, idx) => ({ track, proj, trackIndex: idx }))
  );

  const sortTracks = (list: typeof allTracks) => {
    const sorted = [...list];
    switch (trackSort) {
      case "liked-first":  return sorted.sort((a,b) => (isLiked(b.proj.id, b.track.id) ? 1 : 0) - (isLiked(a.proj.id, a.track.id) ? 1 : 0));
      case "alpha-asc":    return sorted.sort((a,b) => a.track.name.localeCompare(b.track.name));
      case "alpha-desc":   return sorted.sort((a,b) => b.track.name.localeCompare(a.track.name));
      case "artist-asc":   return sorted.sort((a,b) => (a.proj.artist||"").localeCompare(b.proj.artist||""));
      case "artist-desc":  return sorted.sort((a,b) => (b.proj.artist||"").localeCompare(a.proj.artist||""));
      case "album-asc":    return sorted.sort((a,b) => a.proj.name.localeCompare(b.proj.name));
      default:             return sorted;
    }
  };

  const filtered = sortTracks(
    query.trim()
      ? allTracks.filter(({ track, proj }) =>
          track.name.toLowerCase().includes(query.toLowerCase()) ||
          proj.name.toLowerCase().includes(query.toLowerCase()) ||
          proj.artist.toLowerCase().includes(query.toLowerCase())
        )
      : allTracks
  );

  // Build the library queue from whatever is currently visible
  const buildQueue = () => filtered.map(({ proj, trackIndex }) => ({ projectId: proj.id, trackIndex }));

  return (
    <div className="min-h-full pb-4">
      <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-3xl border-b border-border">
        <div className="px-6 py-4 flex items-center gap-4" style={{ paddingLeft: !sidebarOpen ? 48 : 24 }}>
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-0.5">All Songs</p>
            <h1 className="text-lg font-bold tracking-tight">Library</h1>
          </div>
          {allTracks.length > 0 && (
            <>
              <div className="flex-1 max-w-xs relative ml-2">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search songs, artists…"
                  className="w-full bg-secondary border border-border rounded-md pl-8 pr-3 py-2 text-sm outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
                />
                {query && (
                  <button onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X size={13} />
                  </button>
                )}
              </div>
              <SortDropdown<TrackSort>
                value={trackSort}
                onChange={setTrackSort}
                options={TRACK_SORT_OPTIONS}
              />
            </>
          )}
        </div>
      </header>

      <main className="px-6 pt-6 pb-10">
        {allTracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[55vh] gap-5 text-center">
            <div className="text-muted-foreground/25"><CassetteLogo size={56} /></div>
            <div>
              <h2 className="text-xl font-bold mb-2">No songs yet</h2>
              <p className="text-muted-foreground text-sm max-w-xs">
                Use "New Project" in the sidebar to upload a single, or add tracks to an album from the Home tab.
              </p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-center">
            <Search size={36} className="text-muted-foreground/25" />
            <p className="font-semibold text-muted-foreground">No songs match "{query}"</p>
            <button onClick={() => setQuery("")} className="text-primary text-sm font-medium">Clear search</button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground mb-5">
              {filtered.length}{query ? ` of ${allTracks.length}` : ""} song{filtered.length !== 1 ? "s" : ""}
            </p>
            <div className="rounded-lg border border-border overflow-hidden">
              {filtered.map(({ track, proj, trackIndex }, i) => {
                const isActive = player.projectId === proj.id && player.trackIndex === trackIndex;
                const isPlaying = isActive && player.isPlaying;
                const isLast = i === filtered.length - 1;

                return (
                  <div
                    key={`${proj.id}-${track.id}`}
                    onClick={() => { const q = buildQueue(); playTrack(proj.id, trackIndex, q, i); }}
                    className={`group flex items-center gap-4 px-4 py-3 cursor-pointer transition-colors ${isActive ? "bg-primary/8" : "hover:bg-card"} ${!isLast ? "border-b border-border" : ""}`}
                  >
                    {/* Cover */}
                    <div className="w-10 h-10 shrink-0 rounded-md overflow-hidden bg-secondary border border-border">
                      {proj.coverDataUrl
                        ? <img src={proj.coverDataUrl} alt={proj.name} className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center"><Music size={14} className="text-muted-foreground/30" /></div>
                      }
                    </div>

                    {/* Track info */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold truncate leading-tight ${isActive ? "text-primary" : ""}`}>
                        {track.name}
                      </p>
                      <button
                        onClick={e => { e.stopPropagation(); nav(`/project/${proj.id}`); }}
                        className="text-xs text-muted-foreground hover:text-primary transition-colors truncate text-left mt-0.5 block"
                      >
                        {proj.artist || "Unknown Artist"} · {proj.name}
                      </button>
                    </div>

                    {/* Playing indicator */}
                    <div className="w-5 shrink-0 flex items-center justify-center">
                      {isPlaying ? (
                        <div className="flex items-end gap-0.5 h-4">
                          {[0, 1, 2].map(j => (
                            <div key={j} className="w-0.5 bg-primary rounded-full"
                              style={{ animation: `equalizerBounce 0.9s ease-in-out ${j * 0.15}s infinite alternate`, height: "100%" }} />
                          ))}
                        </div>
                      ) : (
                        <Play size={13} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </div>

                    {/* Duration */}
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{fmt(track.duration)}</span>

                    {/* Like button */}
                    <button
                      onClick={e => { e.stopPropagation(); toggleLike(proj.id, track.id); }}
                      className={`p-1.5 rounded-md transition-all active:scale-90 shrink-0 ${isLiked(proj.id, track.id) ? "text-red-400" : "text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100"}`}
                    >
                      <Heart size={13} fill={isLiked(proj.id, track.id) ? "currentColor" : "none"} strokeWidth={isLiked(proj.id, track.id) ? 0 : 1.5} />
                    </button>

                    {/* Queue buttons */}
                    {addToFront && (
                      <div onClick={e => e.stopPropagation()}>
                        <QueueDropdown
                          onAddToFront={() => addToFront(proj.id, trackIndex)}
                          onAddToBack={() => addToBack?.(proj.id, trackIndex)}
                          isLast={i === filtered.length - 1}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── PlaylistsView ──────────────────────────────────────────────────────────

function PlaylistsView({
  playlists, setPlaylists, projects, player, playTrack, setPlayer, showToast, sidebarOpen, toggleFavorite, isFavorited, toggleLike, isLiked,
}: {
  playlists: Playlist[];
  setPlaylists: React.Dispatch<React.SetStateAction<Playlist[]>>;
  projects: Project[];
  player: PlayerState;
  playTrack: (pid: string, idx: number, queue?: QueueItem[], queuePos?: number) => Promise<void>;
  setPlayer: React.Dispatch<React.SetStateAction<PlayerState>>;
  showToast: (msg: string) => void;
  sidebarOpen: boolean;
  toggleFavorite?: (type: "album"|"playlist", id: string) => void;
  isFavorited?: (type: "album"|"playlist", id: string) => boolean;
  toggleLike?: (pid: string, tid: string) => void;
  isLiked?: (pid: string, tid: string) => boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const selected = selectedId ? playlists.find(p => p.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <PlaylistDetailView
        playlist={selected}
        playlists={playlists}
        setPlaylists={setPlaylists}
        projects={projects}
        player={player}
        playTrack={playTrack}
        setPlayer={setPlayer}
        showToast={showToast}
        sidebarOpen={sidebarOpen}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="min-h-full pb-4">
      <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-3xl border-b border-border">
        <div className="px-6 py-4 flex items-center justify-between" style={{ paddingLeft: !sidebarOpen ? 48 : 24 }}>
          <h1 className="text-lg font-bold tracking-tight">Playlists</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-primary hover:bg-primary/85 text-white px-4 py-2 rounded-md text-sm font-semibold transition-all active:scale-95 shadow-md shadow-primary/20"
          >
            <Plus size={14} strokeWidth={2.5} />
            New Playlist
          </button>
        </div>
      </header>

      <main className="px-6 pt-8 pb-10">
        {playlists.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[55vh] gap-5 text-center">
            <div className="w-20 h-20 rounded-2xl bg-card border border-border flex items-center justify-center">
              <LayoutList size={36} className="text-muted-foreground/30" />
            </div>
            <div>
              <h2 className="text-xl font-bold mb-2">No playlists yet</h2>
              <p className="text-muted-foreground text-sm max-w-xs">Create a playlist and add songs from your library to it.</p>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 bg-primary text-white px-6 py-3 rounded-md font-semibold hover:bg-primary/85 transition-all active:scale-95 shadow-md shadow-primary/20"
            >
              <Plus size={16} />
              Create your first playlist
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
            {playlists.map(pl => (
              <PlaylistCard
                key={pl.id}
                playlist={pl}
                projects={projects}
                isPlaying={player.queue.length > 0 && player.isPlaying && pl.items.some(item => {
                  const proj = projects.find(p => p.id === item.projectId);
                  if (!proj) return false;
                  const ti = proj.tracks.findIndex(t => t.id === item.trackId);
                  return player.projectId === item.projectId && player.trackIndex === ti;
                })}
                onClick={() => setSelectedId(pl.id)}
                onPlay={() => playPlaylist(pl, projects, playTrack, setPlayer, false)}
                favorited={isFavorited ? isFavorited("playlist", pl.id) : undefined}
                onToggleFavorite={toggleFavorite ? e => { e.stopPropagation(); toggleFavorite("playlist", pl.id); } : undefined}
              />
            ))}
          </div>
        )}
      </main>

      {showCreate && (
        <CreatePlaylistModal
          onClose={() => setShowCreate(false)}
          onCreate={pl => { setPlaylists(prev => [pl, ...prev]); setShowCreate(false); setSelectedId(pl.id); }}
        />
      )}
    </div>
  );
}

// Build a QueueItem[] from a playlist, skipping stale references
function buildPlaylistQueue(playlist: Playlist, projects: Project[]): QueueItem[] {
  return playlist.items.flatMap(item => {
    const proj = projects.find(p => p.id === item.projectId);
    if (!proj) return [];
    const ti = proj.tracks.findIndex(t => t.id === item.trackId);
    if (ti === -1) return [];
    return [{ projectId: item.projectId, trackIndex: ti }];
  });
}

function playPlaylist(
  playlist: Playlist,
  projects: Project[],
  playTrack: (pid: string, idx: number, queue?: QueueItem[], queuePos?: number) => Promise<void>,
  setPlayer: React.Dispatch<React.SetStateAction<PlayerState>>,
  shuffle: boolean,
  startPos = 0,
) {
  const queue = buildPlaylistQueue(playlist, projects);
  if (!queue.length) return;
  const pos = shuffle ? shuffleNext(queue, startPos) : startPos;
  const item = queue[pos];
  setPlayer(p => ({ ...p, shuffle }));
  playTrack(item.projectId, item.trackIndex, queue, pos);
}

function PlaylistCard({
  playlist, projects, isPlaying, onClick, onPlay, favorited, onToggleFavorite,
}: {
  playlist: Playlist; projects: Project[]; isPlaying: boolean;
  onClick: () => void; onPlay: () => void;
  favorited?: boolean; onToggleFavorite?: (e: React.MouseEvent) => void;
}) {
  // Use first 4 track covers for the mosaic if no custom cover
  const mosaicCovers = !playlist.coverDataUrl
    ? [...new Map(
        playlist.items.map(item => projects.find(p => p.id === item.projectId)).filter(Boolean).map(p => [p!.id, p!])
      ).values()].slice(0, 4).map(p => p.coverDataUrl).filter(Boolean) as string[]
    : [];

  return (
    <div className="group cursor-pointer" onClick={onClick}>
      <div className="relative aspect-square rounded-lg overflow-hidden bg-card border border-border mb-3 shadow-lg transition-transform duration-200 group-hover:-translate-y-1">
        {playlist.coverDataUrl ? (
          <img src={playlist.coverDataUrl} alt={playlist.name} className="w-full h-full object-cover" />
        ) : mosaicCovers.length >= 4 ? (
          <div className="w-full h-full grid grid-cols-2 grid-rows-2">
            {mosaicCovers.map((url, i) => (
              <img key={i} src={url} alt="" className="w-full h-full object-cover" />
            ))}
          </div>
        ) : mosaicCovers.length > 0 ? (
          <img src={mosaicCovers[0]} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-card">
            <LayoutList size={32} className="text-muted-foreground/30" />
          </div>
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-200 flex items-end justify-end p-3">
          <button
            onClick={e => { e.stopPropagation(); onPlay(); }}
            className="opacity-0 group-hover:opacity-100 transition-all duration-200 w-11 h-11 bg-primary rounded-md flex items-center justify-center shadow-xl scale-75 group-hover:scale-100"
          >
            {isPlaying ? <Pause size={18} className="text-white" /> : <Play size={18} className="text-white ml-0.5" />}
          </button>
        </div>
        {onToggleFavorite && (
          <button
            onClick={onToggleFavorite}
            className={`absolute top-2 left-2 p-1.5 rounded-md bg-black/40 transition-all opacity-0 group-hover:opacity-100 ${favorited ? "text-yellow-400" : "text-white/70 hover:text-yellow-400"}`}
          >
            <Star size={13} fill={favorited ? "currentColor" : "none"} strokeWidth={favorited ? 0 : 1.5} />
          </button>
        )}
      </div>
      <p className="font-semibold text-sm truncate leading-tight">{playlist.name}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{playlist.items.length} song{playlist.items.length !== 1 ? "s" : ""}</p>
    </div>
  );
}

// ── PlaylistDetailView ─────────────────────────────────────────────────────

function PlaylistDetailView({
  playlist, playlists, setPlaylists, projects, player, playTrack, setPlayer, showToast, sidebarOpen, onBack,
}: {
  playlist: Playlist;
  playlists: Playlist[];
  setPlaylists: React.Dispatch<React.SetStateAction<Playlist[]>>;
  projects: Project[];
  player: PlayerState;
  playTrack: (pid: string, idx: number, queue?: QueueItem[], queuePos?: number) => Promise<void>;
  setPlayer: React.Dispatch<React.SetStateAction<PlayerState>>;
  showToast: (msg: string) => void;
  sidebarOpen: boolean;
  onBack: () => void;
}) {
  const [showAddSongs, setShowAddSongs] = useState(false);
  const [editingCover, setEditingCover] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(playlist.name);
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const updatePlaylist = (patch: Partial<Playlist>) =>
    setPlaylists(prev => prev.map(p => p.id === playlist.id ? { ...p, ...patch } : p));

  const removeItem = (idx: number) => {
    const items = [...playlist.items];
    items.splice(idx, 1);
    updatePlaylist({ items });
  };

  const onDragStart = (idx: number) => { dragIdx.current = idx; };
  const onDragOver = (e: React.DragEvent, idx: number) => { e.preventDefault(); setOverIdx(idx); };
  const onDrop = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) { dragIdx.current = null; setOverIdx(null); return; }
    const items = [...playlist.items];
    const [moved] = items.splice(dragIdx.current, 1);
    items.splice(idx, 0, moved);
    updatePlaylist({ items });
    dragIdx.current = null; setOverIdx(null);
  };
  const onDragEnd = () => { dragIdx.current = null; setOverIdx(null); };

  // Resolve items to display, skipping stale refs
  const resolvedItems = playlist.items.map((item, idx) => {
    const proj = projects.find(p => p.id === item.projectId);
    if (!proj) return null;
    const ti = proj.tracks.findIndex(t => t.id === item.trackId);
    if (ti === -1) return null;
    return { item, proj, track: proj.tracks[ti], trackIndex: ti, listIdx: idx };
  }).filter(Boolean) as { item: PlaylistItem; proj: Project; track: Track; trackIndex: number; listIdx: number }[];

  const queue = buildPlaylistQueue(playlist, projects);
  const totalDuration = resolvedItems.reduce((s, r) => s + r.track.duration, 0);

  const isThisPlaylistPlaying = player.isPlaying && queue.length > 0 &&
    queue.some((qi, i) => i === player.queuePos && qi.projectId === player.projectId && qi.trackIndex === player.trackIndex);

  return (
    <div className="min-h-full pb-4">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-3xl border-b border-border">
        <div className="px-6 py-3.5 flex items-center gap-4" style={{ paddingLeft: !sidebarOpen ? 48 : 24 }}>
          <button onClick={onBack} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm font-semibold">
            <ChevronLeft size={16} />
            Playlists
          </button>
          <div className="flex-1" />
          <VisibilityToggle isPublic={playlist.isPublic !== false} onChange={v => updatePlaylist({ isPublic: v })} />
        </div>
      </header>

      {/* Hero */}
      <div className="px-6 pt-10 pb-8 max-w-5xl mx-auto">
        <div className="flex flex-col sm:flex-row gap-8 items-start">
          {/* Cover */}
          <label className="group relative w-48 h-48 shrink-0 rounded-lg overflow-hidden bg-card border border-border shadow-2xl cursor-pointer mx-auto sm:mx-0 block">
            {playlist.coverDataUrl ? (
              <img src={playlist.coverDataUrl} alt={playlist.name} className="w-full h-full object-cover" />
            ) : resolvedItems.length >= 4 ? (
              <div className="w-full h-full grid grid-cols-2 grid-rows-2">
                {[...new Map(resolvedItems.map(r => [r.proj.id, r.proj])).values()].slice(0, 4).map((proj, i) => (
                  proj.coverDataUrl
                    ? <img key={i} src={proj.coverDataUrl} alt="" className="w-full h-full object-cover" />
                    : <div key={i} className="w-full h-full bg-muted flex items-center justify-center"><Music size={16} className="text-muted-foreground/30" /></div>
                ))}
              </div>
            ) : resolvedItems.length > 0 && resolvedItems[0].proj.coverDataUrl ? (
              <img src={resolvedItems[0].proj.coverDataUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-secondary to-card">
                <LayoutList size={48} className="text-muted-foreground/25" />
              </div>
            )}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/60 transition-all flex flex-col items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100">
              <ImagePlus size={22} className="text-white" />
              <span className="text-white text-xs font-semibold">Change Cover</span>
            </div>
            <input type="file" accept="image/*,image/gif" className="hidden" onChange={async e => {
              const input = e.target;
              const file = input.files?.[0];
              input.value = "";
              if (!file) return;
              const url = await processCover(file);
              if (url) updatePlaylist({ coverDataUrl: url });
            }} />
          </label>

          {/* Meta */}
          <div className="flex-1 min-w-0 flex flex-col justify-end">
            <p className="text-xs font-bold text-primary uppercase tracking-widest mb-2">Playlist</p>
            {editingName ? (
              <div className="flex items-center gap-2 mb-4">
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={e => setNameDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") { updatePlaylist({ name: nameDraft.trim() || playlist.name }); setEditingName(false); }
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  className="text-3xl font-extrabold bg-secondary border border-primary/40 rounded-md px-3 py-2 outline-none focus:border-primary w-full"
                />
                <button onClick={() => { updatePlaylist({ name: nameDraft.trim() || playlist.name }); setEditingName(false); }} className="p-2 rounded-md bg-primary text-white hover:bg-primary/85"><Check size={16} /></button>
                <button onClick={() => setEditingName(false)} className="p-2 rounded-md hover:bg-secondary text-muted-foreground"><X size={16} /></button>
              </div>
            ) : (
              <div className="flex items-start gap-2 mb-1 group/name">
                <h1 className="text-4xl font-extrabold tracking-tight">{playlist.name}</h1>
                <button onClick={() => { setNameDraft(playlist.name); setEditingName(true); }} className="mt-2 p-1.5 rounded-md opacity-0 group-hover/name:opacity-100 hover:bg-secondary text-muted-foreground transition-all">
                  <Edit2 size={14} />
                </button>
              </div>
            )}
            <p className="text-sm text-muted-foreground mb-7">
              {resolvedItems.length} song{resolvedItems.length !== 1 ? "s" : ""}
              {totalDuration > 0 && ` · ${fmt(totalDuration)}`}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => playPlaylist(playlist, projects, playTrack, setPlayer, false)}
                disabled={!queue.length}
                className="flex items-center gap-2.5 bg-primary text-white px-7 py-3 rounded-md font-bold text-sm hover:bg-primary/85 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-primary/20"
              >
                <Play size={17} className="ml-0.5" />
                Play
              </button>
              <button
                onClick={() => playPlaylist(playlist, projects, playTrack, setPlayer, true)}
                disabled={!queue.length}
                className={`flex items-center gap-2.5 px-5 py-3 rounded-md font-bold text-sm border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${player.shuffle && isThisPlaylistPlaying ? "bg-primary/15 border-primary/40 text-primary" : "border-border hover:bg-card"}`}
              >
                <Shuffle size={15} />
                Shuffle
              </button>
              <button
                onClick={() => setShowAddSongs(true)}
                className="flex items-center gap-2 px-4 py-3 rounded-md border border-border text-sm font-semibold hover:bg-card transition-colors"
              >
                <Plus size={13} />
                Add Songs
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Track list */}
      <div className="px-6 pb-12 max-w-5xl mx-auto">
        {resolvedItems.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-4 border-2 border-dashed border-border rounded-lg py-16 cursor-pointer hover:border-primary/40 hover:bg-card/50 transition-all"
            onClick={() => setShowAddSongs(true)}
          >
            <Plus size={28} className="text-muted-foreground/30" />
            <p className="font-semibold text-muted-foreground">Add songs to get started</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            {resolvedItems.map(({ item, proj, track, trackIndex, listIdx }, i) => {
              const isActive = player.projectId === proj.id && player.trackIndex === trackIndex;
              const isPlaying = isActive && player.isPlaying;
              const isLast = i === resolvedItems.length - 1;

              return (
                <div
                  key={`${item.projectId}-${item.trackId}-${listIdx}`}
                  draggable
                  onDragStart={() => onDragStart(listIdx)}
                  onDragOver={e => onDragOver(e, listIdx)}
                  onDrop={e => onDrop(e, listIdx)}
                  onDragEnd={onDragEnd}
                  onClick={() => {
                    const q = buildPlaylistQueue(playlist, projects);
                    playTrack(proj.id, trackIndex, q, i);
                  }}
                  className={`group flex items-center gap-3 px-3 py-3 cursor-pointer transition-colors select-none
                    ${isActive ? "bg-primary/8" : "hover:bg-card"}
                    ${!isLast ? "border-b border-border" : ""}
                    ${overIdx === listIdx ? "border-t-2 border-primary bg-primary/5" : ""}
                  `}
                >
                  {/* Grip */}
                  <div className="shrink-0 p-1 text-muted-foreground/30 hover:text-muted-foreground cursor-grab active:cursor-grabbing" onClick={e => e.stopPropagation()}>
                    <GripVertical size={14} />
                  </div>

                  {/* Cover */}
                  <div className="w-9 h-9 shrink-0 rounded-md overflow-hidden bg-secondary border border-border">
                    {proj.coverDataUrl
                      ? <img src={proj.coverDataUrl} alt={proj.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center"><Music size={12} className="text-muted-foreground/30" /></div>
                    }
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold truncate leading-tight ${isActive ? "text-primary" : ""}`}>
                      {proj.isSingle ? proj.name : track.name}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {proj.artist || "Unknown Artist"}{!proj.isSingle && ` · ${proj.name}`}
                    </p>
                  </div>

                  {/* Playing indicator */}
                  {isPlaying ? (
                    <div className="flex items-end gap-0.5 h-4 shrink-0">
                      {[0, 1, 2].map(j => (
                        <div key={j} className="w-0.5 bg-primary rounded-full"
                          style={{ animation: `equalizerBounce 0.9s ease-in-out ${j * 0.15}s infinite alternate`, height: "100%" }} />
                      ))}
                    </div>
                  ) : null}

                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">{fmt(track.duration)}</span>

                  <button
                    onClick={e => { e.stopPropagation(); removeItem(listIdx); }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-all shrink-0"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Delete playlist */}
        <div className="mt-14 pt-6 border-t border-border/40">
          <button
            onClick={() => { if (window.confirm(`Delete "${playlist.name}"?`)) { setPlaylists(prev => prev.filter(p => p.id !== playlist.id)); onBack(); } }}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-destructive transition-colors font-medium"
          >
            <Trash2 size={13} />
            Delete Playlist
          </button>
        </div>
      </div>

      {showAddSongs && (
        <AddSongsToPlaylistModal
          playlist={playlist}
          projects={projects}
          onClose={() => setShowAddSongs(false)}
          onSave={items => { updatePlaylist({ items }); setShowAddSongs(false); showToast("Playlist updated"); }}
        />
      )}
    </div>
  );
}

// ── AddSongsToPlaylistModal ────────────────────────────────────────────────

function AddSongsToPlaylistModal({
  playlist, projects, onClose, onSave,
}: {
  playlist: Playlist;
  projects: Project[];
  onClose: () => void;
  onSave: (items: PlaylistItem[]) => void;
}) {
  const [query, setQuery] = useState("");
  // Track which trackIds are in the playlist (key: `${projectId}::${trackId}`)
  const [selected, setSelected] = useState<Set<string>>(() => {
    return new Set(playlist.items.map(i => `${i.projectId}::${i.trackId}`));
  });

  const allTracks = projects.flatMap(proj =>
    proj.tracks.map((track) => ({ track, proj }))
  );
  const filtered = query.trim()
    ? allTracks.filter(({ track, proj }) =>
        track.name.toLowerCase().includes(query.toLowerCase()) ||
        proj.name.toLowerCase().includes(query.toLowerCase()) ||
        proj.artist.toLowerCase().includes(query.toLowerCase())
      )
    : allTracks;

  const toggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleSave = () => {
    // Preserve existing order for items already in playlist, append new ones at end
    const existingKeys = playlist.items.map(i => `${i.projectId}::${i.trackId}`);
    const kept = playlist.items.filter(i => selected.has(`${i.projectId}::${i.trackId}`));
    const newItems: PlaylistItem[] = [];
    for (const key of selected) {
      if (!existingKeys.includes(key)) {
        const [projectId, trackId] = key.split("::");
        newItems.push({ projectId, trackId, addedAt: Date.now() });
      }
    }
    onSave([...kept, ...newItems]);
  };

  const addedCount = selected.size;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="animate-slide-in-right relative z-10 w-full sm:max-w-lg bg-popover border border-border rounded-t-xl sm:rounded-lg shadow-2xl flex flex-col max-h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-base font-bold">Add Songs</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{addedCount} selected</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              className="px-4 py-2 rounded-md bg-primary text-white text-sm font-bold hover:bg-primary/85 transition-all"
            >
              Done
            </button>
            <button onClick={onClose} className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-border shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search songs…"
              className="w-full bg-secondary border border-border rounded-md pl-8 pr-3 py-2 text-sm outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
            />
            {query && (
              <button onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        {/* Track list */}
        <div className="overflow-y-auto scrollbar-hide flex-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
              <Search size={28} className="text-muted-foreground/25" />
              <p className="text-muted-foreground text-sm">{query ? `No results for "${query}"` : "No songs in your library"}</p>
            </div>
          ) : (
            filtered.map(({ track, proj }, i) => {
              const key = `${proj.id}::${track.id}`;
              const isSelected = selected.has(key);
              const isLast = i === filtered.length - 1;

              return (
                <div
                  key={key}
                  onClick={() => toggle(key)}
                  className={`flex items-center gap-3 px-5 py-3 cursor-pointer transition-colors hover:bg-secondary ${!isLast ? "border-b border-border" : ""}`}
                >
                  {/* Cover */}
                  <div className="w-9 h-9 shrink-0 rounded-md overflow-hidden bg-secondary border border-border">
                    {proj.coverDataUrl
                      ? <img src={proj.coverDataUrl} alt={proj.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center"><Music size={12} className="text-muted-foreground/30" /></div>
                    }
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{proj.isSingle ? proj.name : track.name}</p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {proj.artist || "Unknown Artist"}{!proj.isSingle && ` · ${proj.name}`}
                    </p>
                  </div>

                  <span className="text-xs text-muted-foreground tabular-nums shrink-0 mr-2">{fmt(track.duration)}</span>

                  {/* Checkbox */}
                  <div
                    className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                      isSelected ? "bg-primary border-primary" : "border-border"
                    }`}
                  >
                    {isSelected && <Check size={12} className="text-primary-foreground" strokeWidth={3} />}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ── CreatePlaylistModal ────────────────────────────────────────────────────

function CreatePlaylistModal({ onClose, onCreate }: { onClose: () => void; onCreate: (p: Playlist) => void }) {
  const [name, setName] = useState("");
  const [coverDataUrl, setCoverDataUrl] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(true);

  const handleCreate = () => {
    if (!name.trim()) return;
    onCreate({ id: genId(), name: name.trim(), coverDataUrl, items: [], createdAt: Date.now(), isPublic });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="animate-slide-in-up relative z-10 w-full max-w-sm bg-popover border border-border rounded-lg shadow-2xl p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">New Playlist</h2>
          <button onClick={onClose} className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"><X size={16} /></button>
        </div>

        {/* Cover + name side by side */}
        <div className="flex gap-4 mb-5">
          <label className="group relative w-24 h-24 shrink-0 rounded-lg border-2 border-dashed border-border hover:border-primary/50 cursor-pointer overflow-hidden transition-all bg-secondary flex flex-col items-center justify-center">
            {coverDataUrl ? (
              <>
                <img src={coverDataUrl} alt="Cover" className="w-full h-full object-cover absolute inset-0" />
                <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <ImagePlus size={16} className="text-white" />
                </div>
              </>
            ) : (
              <>
                <ImagePlus size={18} className="text-muted-foreground/50 mb-1 group-hover:text-primary/60 transition-colors" />
                <span className="text-[10px] text-muted-foreground font-medium text-center">Cover</span>
              </>
            )}
            <input type="file" accept="image/*,image/gif" className="hidden" onChange={async e => {
              if (e.target.files?.[0]) { const url = await processCover(e.target.files[0]); if (url) setCoverDataUrl(url); }
            }} />
          </label>
          <div className="flex-1 flex flex-col justify-center">
            <label className="block text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1.5">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && name.trim()) handleCreate(); }}
              placeholder="My Playlist"
              autoFocus
              className="w-full bg-secondary border border-border rounded-md px-3 py-2.5 text-sm font-semibold outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
            />
          </div>
        </div>

        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-semibold text-muted-foreground">Visibility</span>
          <VisibilityToggle isPublic={isPublic} onChange={setIsPublic} />
        </div>
        <button
          onClick={handleCreate}
          disabled={!name.trim()}
          className="w-full bg-primary text-white py-3 rounded-md font-bold text-sm hover:bg-primary/85 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-primary/20"
        >
          Create Playlist
        </button>
      </div>
    </div>
  );
}

// ── HeartButton / FavoriteButton / VisibilityToggle ───────────────────────

function HeartButton({ liked, onToggle, size = 15 }: { liked: boolean; onToggle: (e: React.MouseEvent) => void; size?: number }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onToggle(e); }}
      className={`p-1.5 rounded-md transition-all active:scale-90 ${liked ? "text-red-400" : "text-muted-foreground hover:text-red-400"}`}
    >
      <Heart size={size} fill={liked ? "currentColor" : "none"} strokeWidth={liked ? 0 : 1.5} />
    </button>
  );
}

function FavoriteButton({ favorited, onToggle }: { favorited: boolean; onToggle: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onToggle(e); }}
      className={`p-1.5 rounded-md transition-all active:scale-90 ${favorited ? "text-yellow-400" : "text-muted-foreground hover:text-yellow-400"}`}
    >
      <Star size={15} fill={favorited ? "currentColor" : "none"} strokeWidth={favorited ? 0 : 1.5} />
    </button>
  );
}

function VisibilityToggle({ isPublic, onChange }: { isPublic: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!isPublic)}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all border ${
        isPublic
          ? "border-green-500/30 text-green-400 bg-green-500/10 hover:bg-green-500/20"
          : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
      }`}
    >
      {isPublic ? <Globe size={11} /> : <Lock size={11} />}
      {isPublic ? "Public" : "Private"}
    </button>
  );
}

// ── LikedSongsView ─────────────────────────────────────────────────────────

function LikedSongsView({ likedSongs, projects, player, playTrack, toggleLike, sidebarOpen }: {
  likedSongs: LikedSong[];
  projects: Project[];
  player: PlayerState;
  playTrack: (pid: string, idx: number, queue?: QueueItem[], queuePos?: number) => Promise<void>;
  toggleLike: (projectId: string, trackId: string) => void;
  sidebarOpen: boolean;
}) {
  const resolved = likedSongs
    .map(ls => {
      const proj = projects.find(p => p.id === ls.projectId);
      if (!proj) return null;
      const ti = proj.tracks.findIndex(t => t.id === ls.trackId);
      if (ti === -1) return null;
      return { ...ls, proj, track: proj.tracks[ti], trackIndex: ti };
    })
    .filter(Boolean) as Array<LikedSong & { proj: Project; track: Track; trackIndex: number }>;

  const queue = resolved.map(r => ({ projectId: r.projectId, trackIndex: r.trackIndex }));

  return (
    <div className="min-h-full pb-4">
      <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-3xl border-b border-border">
        <div className="px-6 py-4 flex items-center justify-between" style={{ paddingLeft: !sidebarOpen ? 48 : 24 }}>
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-0.5">My Music</p>
            <h1 className="text-lg font-bold tracking-tight flex items-center gap-2">
              <Heart size={18} className="text-red-400" fill="currentColor" />
              Liked Songs
            </h1>
          </div>
          {resolved.length > 0 && (
            <button
              onClick={() => { if (queue.length) playTrack(queue[0].projectId, queue[0].trackIndex, queue, 0); }}
              className="flex items-center gap-2 bg-primary text-white px-4 py-2 rounded-md text-sm font-semibold hover:bg-primary/85 transition-all active:scale-95"
            >
              <Play size={14} />
              Play All
            </button>
          )}
        </div>
      </header>
      <main className="px-6 pt-6 pb-10">
        {resolved.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4 text-center">
            <Heart size={48} className="text-muted-foreground/20" />
            <div>
              <h2 className="text-xl font-bold mb-2">No liked songs yet</h2>
              <p className="text-muted-foreground text-sm">Tap the heart on any track to save it here.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground mb-5">{resolved.length} song{resolved.length !== 1 ? "s" : ""}</p>
            <div className="rounded-lg border border-border overflow-hidden">
              {resolved.map((r, i) => {
                const isActive = player.projectId === r.projectId && player.trackIndex === r.trackIndex;
                const isPlaying = isActive && player.isPlaying;
                return (
                  <div
                    key={`${r.projectId}-${r.trackId}`}
                    onClick={() => playTrack(r.projectId, r.trackIndex, queue, i)}
                    className={`group flex items-center gap-4 px-4 py-3 cursor-pointer transition-colors ${isActive ? "bg-primary/8" : "hover:bg-card"} ${i < resolved.length - 1 ? "border-b border-border" : ""}`}
                  >
                    <div className="w-10 h-10 shrink-0 rounded-md overflow-hidden bg-secondary border border-border">
                      {r.proj.coverDataUrl
                        ? <img src={r.proj.coverDataUrl} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center"><Music size={14} className="text-muted-foreground/30" /></div>
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold truncate ${isActive ? "text-primary" : ""}`}>{r.track.name}</p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {r.proj.artist || "Unknown Artist"}{!r.proj.isSingle && ` · ${r.proj.name}`}
                      </p>
                    </div>
                    {isPlaying && (
                      <div className="flex items-end gap-0.5 h-4">
                        {[0,1,2].map(j => (
                          <div key={j} className="w-0.5 bg-primary rounded-full"
                            style={{animation:`equalizerBounce 0.9s ease-in-out ${j*0.15}s infinite alternate`,height:"100%"}}/>
                        ))}
                      </div>
                    )}
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{fmt(r.track.duration)}</span>
                    <button
                      onClick={e => { e.stopPropagation(); toggleLike(r.projectId, r.trackId); }}
                      className="p-1.5 rounded-md text-red-400 hover:text-red-300 transition-colors shrink-0"
                    >
                      <Heart size={14} fill="currentColor" strokeWidth={0} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── FavoritesView ──────────────────────────────────────────────────────────

function FavoritesView({ favorites, projects, playlists, player, playTrack, toggleFavorite, nav, setSidebarTab, sidebarOpen }: {
  favorites: FavoriteItem[];
  projects: Project[];
  playlists: Playlist[];
  player: PlayerState;
  playTrack: (pid: string, idx: number, queue?: QueueItem[], queuePos?: number) => Promise<void>;
  toggleFavorite: (type: "album"|"playlist", id: string) => void;
  nav: (hash: string) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  sidebarOpen: boolean;
}) {
  const favAlbums = favorites
    .filter(f => f.type === "album")
    .map(f => projects.find(p => p.id === f.id))
    .filter(Boolean) as Project[];

  const favPlaylists = favorites
    .filter(f => f.type === "playlist")
    .map(f => playlists.find(p => p.id === f.id))
    .filter(Boolean) as Playlist[];

  return (
    <div className="min-h-full pb-4">
      <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-3xl border-b border-border">
        <div className="px-6 py-4" style={{ paddingLeft: !sidebarOpen ? 48 : 24 }}>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-0.5">My Music</p>
          <h1 className="text-lg font-bold tracking-tight flex items-center gap-2">
            <Star size={18} className="text-yellow-400" fill="currentColor" />
            Favorites
          </h1>
        </div>
      </header>
      <main className="px-6 pt-6 pb-10">
        {favorites.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4 text-center">
            <Star size={48} className="text-muted-foreground/20" />
            <div>
              <h2 className="text-xl font-bold mb-2">No favorites yet</h2>
              <p className="text-muted-foreground text-sm">Star albums and playlists to save them here.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-10">
            {favAlbums.length > 0 && (
              <section>
                <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-4">Albums</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5">
                  {favAlbums.map(proj => (
                    <div key={proj.id} className="group cursor-pointer" onClick={() => nav(`/project/${proj.id}`)}>
                      <div className="relative aspect-square rounded-lg overflow-hidden bg-card border border-border mb-3 shadow-lg transition-transform duration-200 group-hover:-translate-y-1">
                        {proj.coverDataUrl
                          ? <img src={proj.coverDataUrl} alt={proj.name} className="w-full h-full object-cover" />
                          : <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-card"><Music size={32} className="text-muted-foreground/30" /></div>
                        }
                        <button
                          onClick={e => { e.stopPropagation(); toggleFavorite("album", proj.id); }}
                          className="absolute top-2 right-2 p-1.5 rounded-md bg-black/40 text-yellow-400 hover:text-yellow-300 transition-colors"
                        >
                          <Star size={13} fill="currentColor" strokeWidth={0} />
                        </button>
                      </div>
                      <p className="text-sm font-semibold truncate">{proj.name}</p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{proj.artist || "Unknown Artist"}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {favPlaylists.length > 0 && (
              <section>
                <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-4">Playlists</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5">
                  {favPlaylists.map(pl => (
                    <div key={pl.id} className="group cursor-pointer" onClick={() => setSidebarTab("playlists")}>
                      <div className="relative aspect-square rounded-lg overflow-hidden bg-card border border-border mb-3 shadow-lg transition-transform duration-200 group-hover:-translate-y-1">
                        {pl.coverDataUrl
                          ? <img src={pl.coverDataUrl} alt={pl.name} className="w-full h-full object-cover" />
                          : <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-card"><LayoutList size={32} className="text-muted-foreground/30" /></div>
                        }
                        <button
                          onClick={e => { e.stopPropagation(); toggleFavorite("playlist", pl.id); }}
                          className="absolute top-2 right-2 p-1.5 rounded-md bg-black/40 text-yellow-400 hover:text-yellow-300 transition-colors"
                        >
                          <Star size={13} fill="currentColor" strokeWidth={0} />
                        </button>
                      </div>
                      <p className="text-sm font-semibold truncate">{pl.name}</p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{pl.items.length} songs</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ── ProfileView ────────────────────────────────────────────────────────────

function ProfileView({ projects, playlists, likedSongs, favorites, nav, setSidebarTab, player, playTrack }: {
  projects: Project[];
  playlists: Playlist[];
  likedSongs: LikedSong[];
  favorites: FavoriteItem[];
  nav: (hash: string) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  player: PlayerState;
  playTrack: (pid: string, idx: number, queue?: QueueItem[], queuePos?: number) => Promise<void>;
}) {
  const [name, setName] = useState(() => localStorage.getItem("melodia_profile_name") || "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  const publicAlbums = projects.filter(p => !p.isSingle && p.isPublic !== false);
  const privateAlbums = projects.filter(p => !p.isSingle && p.isPublic === false);
  const publicPlaylists = playlists.filter(p => p.isPublic !== false);
  const privatePlaylists = playlists.filter(p => p.isPublic === false);
  const totalTracks = projects.reduce((s, p) => s + p.tracks.length, 0);

  const initials = name.trim() ? name.trim().split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() : "?";

  const save = () => {
    const t = draft.trim();
    setName(t);
    localStorage.setItem("melodia_profile_name", t);
    setEditing(false);
  };

  return (
    <div className="min-h-full pb-10">
      {/* Hero section */}
      <div className="px-6 pt-10 pb-8 border-b border-border">
        <div className="max-w-4xl mx-auto flex items-end gap-6">
          <div className="w-24 h-24 rounded-xl bg-primary/15 border border-primary/20 flex items-center justify-center shrink-0 shadow-lg">
            <span className="text-3xl font-bold text-primary">{initials}</span>
          </div>
          <div className="flex-1 min-w-0 pb-1">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">Profile</p>
            {editing ? (
              <div className="flex items-center gap-2 mb-2">
                <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if(e.key==="Enter")save(); if(e.key==="Escape")setEditing(false); }}
                  className="text-2xl font-extrabold bg-secondary border border-primary/40 rounded-md px-3 py-1.5 outline-none focus:border-primary"
                  style={{ minWidth: 0, width: "auto", maxWidth: 300 }}
                />
                <button onClick={save} className="p-2 rounded-md bg-primary text-white"><Check size={14} /></button>
                <button onClick={() => setEditing(false)} className="p-2 rounded-md hover:bg-secondary text-muted-foreground"><X size={14} /></button>
              </div>
            ) : (
              <div className="flex items-center gap-2 mb-2 group">
                <h1 className="text-3xl font-extrabold tracking-tight truncate">{name || <span className="text-muted-foreground font-normal text-xl">No name set</span>}</h1>
                <button onClick={() => { setDraft(name); setEditing(true); }}
                  className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-secondary text-muted-foreground transition-all">
                  <Edit2 size={13} />
                </button>
              </div>
            )}
            <div className="flex items-center gap-5 text-sm text-muted-foreground">
              <span><strong className="text-foreground font-semibold">{publicAlbums.length}</strong> albums</span>
              <span><strong className="text-foreground font-semibold">{publicPlaylists.length}</strong> playlists</span>
              <span><strong className="text-foreground font-semibold">{totalTracks}</strong> tracks</span>
              <span><strong className="text-foreground font-semibold">{likedSongs.length}</strong> liked</span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6">
        {/* Quick access */}
        <div className="grid grid-cols-2 gap-3 mt-8 mb-10">
          <button onClick={() => setSidebarTab("liked")}
            className="flex items-center gap-3 p-4 bg-card border border-border rounded-lg hover:bg-secondary transition-colors text-left group">
            <div className="w-10 h-10 rounded-md bg-red-500/15 flex items-center justify-center shrink-0">
              <Heart size={18} className="text-red-400" fill="currentColor" />
            </div>
            <div>
              <p className="text-sm font-semibold">Liked Songs</p>
              <p className="text-xs text-muted-foreground">{likedSongs.length} song{likedSongs.length !== 1 ? "s" : ""}</p>
            </div>
          </button>
          <button onClick={() => setSidebarTab("favorites")}
            className="flex items-center gap-3 p-4 bg-card border border-border rounded-lg hover:bg-secondary transition-colors text-left group">
            <div className="w-10 h-10 rounded-md bg-yellow-500/15 flex items-center justify-center shrink-0">
              <Star size={18} className="text-yellow-400" fill="currentColor" />
            </div>
            <div>
              <p className="text-sm font-semibold">Favorites</p>
              <p className="text-xs text-muted-foreground">{favorites.length} item{favorites.length !== 1 ? "s" : ""}</p>
            </div>
          </button>
        </div>

        {/* Public Albums */}
        {publicAlbums.length > 0 && (
          <section className="mb-10">
            <div className="flex items-center gap-2 mb-5">
              <Globe size={13} className="text-muted-foreground" />
              <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Public Albums</h2>
              <span className="text-xs text-muted-foreground/50">({publicAlbums.length})</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-5">
              {publicAlbums.map(proj => (
                <div key={proj.id} className="group cursor-pointer" onClick={() => nav(`/project/${proj.id}`)}>
                  <div className="aspect-square rounded-lg overflow-hidden bg-card border border-border mb-3 shadow-md transition-transform duration-200 group-hover:-translate-y-1">
                    {proj.coverDataUrl
                      ? <img src={proj.coverDataUrl} alt={proj.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-card"><Music size={28} className="text-muted-foreground/30" /></div>
                    }
                  </div>
                  <p className="text-sm font-semibold truncate">{proj.name}</p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{proj.artist || "Unknown Artist"}</p>
                  <p className="text-xs text-muted-foreground/50 mt-0.5 flex items-center gap-1"><Calendar size={9} />{new Date(proj.createdAt).toLocaleDateString(undefined,{month:"short",year:"numeric"})}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Private Albums */}
        {privateAlbums.length > 0 && (
          <section className="mb-10">
            <div className="flex items-center gap-2 mb-5">
              <Lock size={13} className="text-muted-foreground" />
              <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Private Albums</h2>
              <span className="text-xs text-muted-foreground/50">({privateAlbums.length})</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-5">
              {privateAlbums.map(proj => (
                <div key={proj.id} className="group cursor-pointer opacity-70 hover:opacity-100 transition-opacity" onClick={() => nav(`/project/${proj.id}`)}>
                  <div className="relative aspect-square rounded-lg overflow-hidden bg-card border border-border mb-3 shadow-md transition-transform duration-200 group-hover:-translate-y-1">
                    {proj.coverDataUrl
                      ? <img src={proj.coverDataUrl} alt={proj.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-card"><Music size={28} className="text-muted-foreground/30" /></div>
                    }
                    <div className="absolute top-2 right-2 p-1 rounded-md bg-black/50 text-white/70">
                      <Lock size={10} />
                    </div>
                  </div>
                  <p className="text-sm font-semibold truncate">{proj.name}</p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{proj.artist || "Unknown Artist"}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Public Playlists */}
        {publicPlaylists.length > 0 && (
          <section className="mb-10">
            <div className="flex items-center gap-2 mb-5">
              <Globe size={13} className="text-muted-foreground" />
              <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Public Playlists</h2>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-5">
              {publicPlaylists.map(pl => (
                <div key={pl.id} className="group cursor-pointer" onClick={() => setSidebarTab("playlists")}>
                  <div className="aspect-square rounded-lg overflow-hidden bg-card border border-border mb-3 shadow-md transition-transform duration-200 group-hover:-translate-y-1">
                    {pl.coverDataUrl
                      ? <img src={pl.coverDataUrl} alt={pl.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-card"><LayoutList size={28} className="text-muted-foreground/30" /></div>
                    }
                  </div>
                  <p className="text-sm font-semibold truncate">{pl.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{pl.items.length} songs</p>
                  <p className="text-xs text-muted-foreground/50 mt-0.5 flex items-center gap-1"><Calendar size={9} />{new Date(pl.createdAt).toLocaleDateString(undefined,{month:"short",year:"numeric"})}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {publicAlbums.length === 0 && publicPlaylists.length === 0 && privateAlbums.length === 0 && privatePlaylists.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <User size={48} className="text-muted-foreground/20" />
            <div>
              <h2 className="text-xl font-bold mb-2">Nothing here yet</h2>
              <p className="text-muted-foreground text-sm">Create albums and playlists to see them on your profile.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── AudioVisualizer ────────────────────────────────────────────────────────

function AudioVisualizer({ analyserRef, config, isPlaying, layoutTheme, accent }: {
  analyserRef: React.MutableRefObject<AnalyserNode | null>;
  config: VisualizerConfig;
  isPlaying: boolean;
  layoutTheme: LayoutTheme;
  accent: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Resize canvas to match container
    const resize = () => {
      canvas.width = canvas.offsetWidth * devicePixelRatio;
      canvas.height = canvas.offsetHeight * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const hex = accent;
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const accentRgb = `${r},${g},${b}`;

    // Effective style: "theme" maps to layout-theme-specific style
    const effectiveStyle = config.style === "theme"
      ? ({ default:"bars", modern:"circular", classic:"waveform", unique:"dots" }[layoutTheme] ?? "bars") as VisualizerConfig["style"]
      : config.style;

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const analyser = analyserRef.current;
      const W = canvas.offsetWidth, H = canvas.offsetHeight;

      ctx.clearRect(0, 0, W, H);

      if (!analyser || !isPlaying) {
        // Draw idle state: flat line or empty
        if (effectiveStyle === "waveform") {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${accentRgb},0.2)`;
          ctx.lineWidth = 1.5;
          ctx.moveTo(0, H/2); ctx.lineTo(W, H/2);
          ctx.stroke();
        }
        return;
      }

      // Resume AudioContext if suspended
      if (analyser.context.state === "suspended") (analyser.context as AudioContext).resume();

      const bufLen = analyser.frequencyBinCount;
      const freqData = new Uint8Array(bufLen);
      const timeData = new Uint8Array(bufLen);
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);

      const intensityMul = config.intensity / 100;

      if (effectiveStyle === "bars") {
        const barCount = Math.min(64, bufLen);
        const barW = W / barCount;
        for (let i = 0; i < barCount; i++) {
          const v = (freqData[i] / 255) * H * intensityMul;
          const hue = 360 * (i / barCount);
          const grad = ctx.createLinearGradient(0, H, 0, H - v);
          grad.addColorStop(0, `rgba(${accentRgb},0.8)`);
          grad.addColorStop(1, `rgba(${accentRgb},0.2)`);
          ctx.fillStyle = grad;
          ctx.fillRect(i * barW + 1, H - v, barW - 2, v);
        }
      } else if (effectiveStyle === "waveform") {
        ctx.beginPath();
        ctx.lineWidth = 2;
        const grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, `rgba(${accentRgb},0.1)`);
        grad.addColorStop(0.5, `rgba(${accentRgb},0.9)`);
        grad.addColorStop(1, `rgba(${accentRgb},0.1)`);
        ctx.strokeStyle = grad;
        const step = W / bufLen;
        for (let i = 0; i < bufLen; i++) {
          const v = ((timeData[i] / 128) - 1) * (H / 2) * intensityMul;
          const x = i * step;
          const y = H / 2 + v;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        // Glow
        ctx.shadowBlur = 8;
        ctx.shadowColor = `rgba(${accentRgb},0.5)`;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (effectiveStyle === "circular") {
        const cx = W / 2, cy = H / 2;
        const radius = Math.min(W, H) * 0.3;
        const bars = Math.min(80, bufLen);
        for (let i = 0; i < bars; i++) {
          const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
          const v = (freqData[i] / 255) * radius * 0.6 * intensityMul;
          const x1 = cx + Math.cos(angle) * radius;
          const y1 = cy + Math.sin(angle) * radius;
          const x2 = cx + Math.cos(angle) * (radius + v);
          const y2 = cy + Math.sin(angle) * (radius + v);
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${accentRgb},${0.4 + (freqData[i]/255)*0.6})`;
          ctx.lineWidth = 2;
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
          ctx.stroke();
        }
        // Center circle
        ctx.beginPath();
        ctx.arc(cx, cy, radius - 4, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${accentRgb},0.15)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (effectiveStyle === "dots") {
        const cols = 20, rows = 6;
        const cellW = W / cols, cellH = H / rows;
        for (let col = 0; col < cols; col++) {
          const freqIdx = Math.floor((col / cols) * bufLen);
          const val = (freqData[freqIdx] / 255) * intensityMul;
          const activeDots = Math.floor(val * rows);
          for (let row = 0; row < rows; row++) {
            const x = col * cellW + cellW / 2;
            const y = H - row * cellH - cellH / 2;
            const active = row < activeDots;
            const alpha = active ? 0.2 + val * 0.8 : 0.05;
            ctx.beginPath();
            ctx.arc(x, y, Math.min(cellW, cellH) * 0.28, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${accentRgb},${alpha})`;
            ctx.fill();
          }
        }
      }
    };

    draw();
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, [isPlaying, config.style, config.intensity, accent, layoutTheme]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute", inset: 0,
        width: "100%", height: "100%",
        opacity: config.opacity / 100,
        pointerEvents: "none",
      }}
    />
  );
}

// ── CustomThemeBuilder ─────────────────────────────────────────────────────

function CustomThemeBuilder({ theme, setTheme, savedCustomThemes, setSavedCustomThemes, showToast }: {
  theme: AppTheme;
  setTheme: React.Dispatch<React.SetStateAction<AppTheme>>;
  savedCustomThemes: SavedCustomTheme[];
  setSavedCustomThemes: React.Dispatch<React.SetStateAction<SavedCustomTheme[]>>;
  showToast: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<CustomThemeConfig>(theme.custom ?? DEFAULT_CUSTOM_CONFIG);
  const [saveName, setSaveName] = useState("My Theme");
  const [showSaveForm, setShowSaveForm] = useState(false);

  // Apply draft changes live
  useEffect(() => {
    applyCustomThemeConfig(draft, theme.accent);
    setTheme(prev => ({ ...prev, custom: draft }));
  }, [draft, theme.accent]);

  const updateDraft = (patch: Partial<CustomThemeConfig>) =>
    setDraft(prev => ({ ...prev, ...patch }));

  const handleSave = () => {
    if (!saveName.trim()) return;
    const saved: SavedCustomTheme = {
      id: genId(),
      name: saveName.trim(),
      accent: theme.accent,
      mode: theme.mode,
      config: { ...draft },
      createdAt: Date.now(),
    };
    setSavedCustomThemes(prev => [saved, ...prev.slice(0, 9)]);
    showToast("Theme saved!");
    setShowSaveForm(false);
    setSaveName("My Theme");
  };

  const applyTheme = (saved: SavedCustomTheme) => {
    setDraft(saved.config);
    setTheme(prev => ({ ...prev, accent: saved.accent, mode: saved.mode, custom: saved.config }));
    showToast(`Applied "${saved.name}"`);
  };

  const SliderRow = ({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) => (
    <div className="flex items-center justify-between gap-3">
      <label className="text-sm font-medium shrink-0 w-36">{label}</label>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} className="flex-1 accent-primary cursor-pointer" />
      <span className="text-xs text-muted-foreground tabular-nums w-12 text-right shrink-0">{value}{unit}</span>
    </div>
  );

  return (
    <div>
      {/* Live Preview */}
      <div className="mb-6">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Live Preview</p>
        <div
          className="rounded-lg overflow-hidden border border-border shadow-xl"
          style={{ height: 160, position: "relative", fontFamily: FONT_MAP[draft.fontFamily]?.css ?? "system-ui" }}
        >
          {/* BG */}
          {draft.backgroundUrl ? (
            <div style={{ position:"absolute", inset:0, backgroundImage:`url(${draft.backgroundUrl})`, backgroundSize:"cover", backgroundPosition:"center", filter:`blur(${draft.backgroundBlur * 0.5}px)`, transform:"scale(1.05)" }} />
          ) : <div style={{ position:"absolute", inset:0, background:"var(--background)" }} />}
          <div style={{ position:"absolute", inset:0, background:`rgba(0,0,0,${draft.backgroundOpacity/200})` }} />
          {/* Fake UI */}
          <div style={{ position:"relative", zIndex:1, display:"flex", height:"100%" }}>
            {/* Sidebar */}
            <div style={{ width:44, background:"var(--sidebar)", borderRight:"1px solid var(--border)", display:"flex", flexDirection:"column", alignItems:"center", padding:"8px 0", gap:6 }}>
              {[...Array(4)].map((_,i)=><div key={i} style={{width:20,height:4,background:i===0?"var(--primary)":"var(--muted)",borderRadius:2,opacity:i===0?1:0.5}}/>)}
            </div>
            {/* Content */}
            <div style={{ flex:1, padding:"10px 12px", display:"flex", flexDirection:"column", gap:8, minWidth:0 }}>
              <div style={{ height:10, background:"var(--foreground)", borderRadius:4, opacity:0.8, width:"60%" }} />
              <div style={{ display:"flex", gap:8, flex:1 }}>
                {[...Array(3)].map((_,i)=>(
                  <div key={i} style={{ flex:1, background:`rgba(255,255,255,${draft.glassBlur > 30 ? 0.07 : 0.04})`, backdropFilter:draft.glassBlur>30?`blur(${draft.glassBlur*0.5}px)`:undefined, border:"1px solid var(--border)", borderRadius:4, minHeight:60 }} />
                ))}
              </div>
            </div>
          </div>
          {/* Fake player bar */}
          <div style={{ position:"absolute", bottom:0, left:0, right:0, height:28, background:"var(--popover)", borderTop:"1px solid var(--border)", display:"flex", alignItems:"center", padding:"0 10px", gap:8 }}>
            <div style={{ width:18, height:18, background:`var(--primary)`, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <Play size={8} className="text-white ml-px" />
            </div>
            <div style={{ flex:1, height:3, background:"var(--border)", borderRadius:9999, position:"relative" }}>
              <div style={{ position:"absolute", left:0, top:0, bottom:0, width:"40%", background:`var(--primary)`, borderRadius:9999 }} />
            </div>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="space-y-5">
        {/* Background */}
        <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border">
          <div className="px-5 py-4">
            <p className="text-sm font-bold mb-3">Background Image / GIF</p>
            <div className="flex items-center gap-3">
              <label className={`flex items-center gap-2 px-4 py-2.5 rounded-md border text-sm font-semibold cursor-pointer transition-all ${draft.backgroundUrl ? "border-primary/40 bg-primary/5 text-primary" : "border-border hover:border-primary/40"}`}>
                <ImagePlus size={14} />
                {draft.backgroundUrl ? "Change" : "Upload"}
                <input type="file" accept="image/*,image/gif" className="hidden" onChange={async e => {
                  if (!e.target.files?.[0]) return;
                  const f = e.target.files[0];
                  if (f.type === "image/gif") {
                    const r = new FileReader();
                    r.onload = () => updateDraft({ backgroundUrl: r.result as string });
                    r.readAsDataURL(f);
                  } else {
                    const url = await resizeCover(f);
                    if (url) updateDraft({ backgroundUrl: url });
                  }
                }} />
              </label>
              {draft.backgroundUrl && (
                <button onClick={() => updateDraft({ backgroundUrl: null })} className="px-3 py-2.5 rounded-md border border-border text-sm font-semibold text-muted-foreground hover:text-destructive hover:border-destructive/30 transition-colors">
                  <X size={14} />
                </button>
              )}
              {draft.backgroundUrl && (
                <div className="w-12 h-9 rounded-md overflow-hidden border border-border shrink-0">
                  <img src={draft.backgroundUrl} alt="" className="w-full h-full object-cover" />
                </div>
              )}
            </div>
          </div>
          {draft.backgroundUrl && (
            <>
              <div className="px-5 py-4 space-y-3">
                <SliderRow label="Blur" value={draft.backgroundBlur} min={0} max={60} unit="px" onChange={v => updateDraft({ backgroundBlur: v })} />
                <SliderRow label="Overlay opacity" value={draft.backgroundOpacity} min={0} max={95} unit="%" onChange={v => updateDraft({ backgroundOpacity: v })} />
              </div>
            </>
          )}
        </div>

        {/* Glass + Glass Blur */}
        <div className="bg-card border border-border rounded-lg px-5 py-4">
          <p className="text-sm font-bold mb-3">Glass Blur</p>
          <SliderRow label="Blur amount" value={draft.glassBlur} min={0} max={80} unit="px" onChange={v => updateDraft({ glassBlur: v })} />
          <p className="text-xs text-muted-foreground mt-2">Controls blur intensity on glass panels (Modern theme)</p>
        </div>

        {/* Font */}
        <div className="bg-card border border-border rounded-lg px-5 py-4">
          <p className="text-sm font-bold mb-3">Font</p>
          <div className="grid grid-cols-2 gap-2">
            {(Object.entries(FONT_MAP) as [FontOption, { label: string; css: string }][]).map(([key, { label, css }]) => (
              <button key={key} onClick={() => updateDraft({ fontFamily: key })}
                className={`px-3 py-2.5 rounded-md border text-sm text-left transition-all ${draft.fontFamily === key ? "border-primary bg-primary/10 text-primary font-semibold" : "border-border hover:border-primary/30"}`}
                style={{ fontFamily: css }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Save */}
        <div className="bg-card border border-border rounded-lg px-5 py-4">
          <p className="text-sm font-bold mb-3">Save Custom Theme</p>
          {showSaveForm ? (
            <div className="flex items-center gap-2">
              <input autoFocus value={saveName} onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setShowSaveForm(false); }}
                placeholder="Theme name" className="flex-1 bg-secondary border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary transition-colors" />
              <button onClick={handleSave} className="px-4 py-2 rounded-md bg-primary text-white text-sm font-semibold hover:bg-primary/85 transition-all"><Check size={14} /></button>
              <button onClick={() => setShowSaveForm(false)} className="px-3 py-2 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground transition-colors"><X size={14} /></button>
            </div>
          ) : (
            <button onClick={() => setShowSaveForm(true)} className="flex items-center gap-2 px-4 py-2 rounded-md border border-border text-sm font-semibold hover:border-primary/40 hover:text-primary transition-colors">
              <Plus size={14} /> Save current customization
            </button>
          )}
        </div>
      </div>

      {/* Saved themes */}
      {savedCustomThemes.length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Saved Custom Themes</p>
          <div className="space-y-2">
            {savedCustomThemes.map(saved => (
              <div key={saved.id} className="flex items-center gap-3 px-4 py-3 bg-card border border-border rounded-lg">
                <div className="w-6 h-6 rounded-md shrink-0 border border-border" style={{ backgroundColor: saved.accent }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{saved.name}</p>
                  <p className="text-xs text-muted-foreground">{saved.mode} · {FONT_MAP[saved.config.fontFamily]?.label ?? "System"}</p>
                </div>
                <button onClick={() => applyTheme(saved)} className="px-3 py-1.5 rounded-md bg-primary text-white text-xs font-semibold hover:bg-primary/85 transition-all">Apply</button>
                <button onClick={() => setSavedCustomThemes(prev => prev.filter(t => t.id !== saved.id))} className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── VisualizerSettings ─────────────────────────────────────────────────────

function VisualizerSettings({ config, onChange }: {
  config: VisualizerConfig;
  onChange: (v: VisualizerConfig) => void;
}) {
  const update = (patch: Partial<VisualizerConfig>) => onChange({ ...config, ...patch });

  const STYLES: { key: VisualizerConfig["style"]; label: string; desc: string }[] = [
    { key: "bars",     label: "Frequency Bars",   desc: "Classic equalizer bars" },
    { key: "waveform", label: "Waveform",          desc: "Audio waveform line" },
    { key: "circular", label: "Circular Spectrum", desc: "Radial frequency display" },
    { key: "dots",     label: "Dot Matrix",        desc: "Pulsing grid of dots" },
    { key: "theme",    label: "Theme Style",       desc: "Matches current theme" },
  ];

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border">
      {/* Toggle */}
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <p className="text-sm font-semibold">Audio Visualizer</p>
          <p className="text-xs text-muted-foreground mt-0.5">Reacts to the currently playing song</p>
        </div>
        <ToggleSwitch on={config.enabled} onChange={() => update({ enabled: !config.enabled })} />
      </div>

      {config.enabled && (
        <>
          {/* Style picker */}
          <div className="px-5 py-4">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Style</p>
            <div className="grid grid-cols-1 gap-2">
              {STYLES.map(s => (
                <button key={s.key} onClick={() => update({ style: s.key })}
                  className={`flex items-center justify-between px-4 py-2.5 rounded-md border text-left transition-all ${config.style === s.key ? "border-primary bg-primary/10" : "border-border hover:border-primary/30"}`}>
                  <div>
                    <span className={`text-sm font-semibold ${config.style === s.key ? "text-primary" : ""}`}>{s.label}</span>
                    <span className="text-xs text-muted-foreground ml-2">{s.desc}</span>
                  </div>
                  {config.style === s.key && <Check size={14} className="text-primary shrink-0" />}
                </button>
              ))}
            </div>
          </div>

          {/* Sliders */}
          <div className="px-5 py-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium w-24 shrink-0">Intensity</label>
              <input type="range" min={10} max={100} value={config.intensity} onChange={e => update({ intensity: Number(e.target.value) })} className="flex-1 accent-primary cursor-pointer" />
              <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">{config.intensity}%</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium w-24 shrink-0">Opacity</label>
              <input type="range" min={10} max={100} value={config.opacity} onChange={e => update({ opacity: Number(e.target.value) })} className="flex-1 accent-primary cursor-pointer" />
              <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">{config.opacity}%</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── FsBgSettings ──────────────────────────────────────────────────────────

function FsBgSettings({ config, onChange }: { config: FsBgConfig; onChange: (c: FsBgConfig) => void }) {
  const set = (patch: Partial<FsBgConfig>) => onChange({ ...config, ...patch });

  const MODES: { key: FsBgMode; label: string; desc: string }[] = [
    { key: "movement",   label: "Subtle Movement",   desc: "Album art slowly pans and zooms (Ken Burns effect)" },
    { key: "visualizer", label: "Music Visualizer",  desc: "Animated audio visualizer behind the player" },
    { key: "custom",     label: "Custom Background", desc: "Upload your own image or GIF" },
  ];

  const FIT_OPTIONS: { key: FsBgConfig["customFit"]; label: string }[] = [
    { key: "fill",    label: "Fill" },
    { key: "fit",     label: "Fit" },
    { key: "center",  label: "Center" },
    { key: "stretch", label: "Stretch" },
  ];

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border">
      {/* Enable toggle */}
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <p className="text-sm font-semibold">Animated Background</p>
          <p className="text-xs text-muted-foreground mt-0.5">Bring the fullscreen player to life</p>
        </div>
        <ToggleSwitch on={config.enabled} onChange={() => set({ enabled: !config.enabled })} />
      </div>

      {config.enabled && (
        <>
          {/* Mode picker */}
          <div className="px-5 py-4">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Animation Mode</p>
            <div className="space-y-2">
              {MODES.map(m => (
                <button key={m.key} onClick={() => set({ mode: m.key })}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-md border text-left transition-all ${config.mode === m.key ? "border-primary bg-primary/10" : "border-border hover:border-primary/30"}`}>
                  <div>
                    <span className={`text-sm font-semibold ${config.mode === m.key ? "text-primary" : ""}`}>{m.label}</span>
                    <span className="text-xs text-muted-foreground ml-2">{m.desc}</span>
                  </div>
                  {config.mode === m.key && <Check size={14} className="text-primary shrink-0 ml-2" />}
                </button>
              ))}
            </div>
          </div>

          {/* Intensity (movement + visualizer) */}
          {config.mode !== "custom" && (
            <div className="px-5 py-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold">{config.mode === "movement" ? "Animation Speed" : "Visualizer Intensity"}</p>
                <span className="text-sm text-muted-foreground tabular-nums">{config.intensity}%</span>
              </div>
              <input type="range" min={10} max={100} value={config.intensity} onChange={e => set({ intensity: Number(e.target.value) })} className="w-full accent-primary cursor-pointer" />
            </div>
          )}

          {/* Custom background options */}
          {config.mode === "custom" && (
            <div className="px-5 py-4 space-y-4">
              <div>
                <p className="text-sm font-semibold mb-3">Background Image / GIF</p>
                <div className="flex items-center gap-3">
                  <label className={`flex items-center gap-2 px-4 py-2.5 rounded-md border text-sm font-semibold cursor-pointer transition-all ${config.customUrl ? "border-primary/40 bg-primary/5 text-primary" : "border-border hover:border-primary/40"}`}>
                    <ImagePlus size={14} />
                    {config.customUrl ? "Change" : "Upload"}
                    <input type="file" accept="image/*,image/gif" className="hidden" onChange={async e => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.type === "image/gif") {
                        const r = new FileReader();
                        r.onload = () => set({ customUrl: r.result as string });
                        r.readAsDataURL(f);
                      } else {
                        const url = await resizeCover(f);
                        if (url) set({ customUrl: url });
                      }
                    }} />
                  </label>
                  {config.customUrl && (
                    <>
                      <button onClick={() => set({ customUrl: null })} className="p-2.5 rounded-md border border-border text-muted-foreground hover:text-destructive transition-colors"><X size={14} /></button>
                      <div className="w-12 h-9 rounded-md overflow-hidden border border-border shrink-0">
                        <img src={config.customUrl} alt="" className="w-full h-full object-cover" />
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Fit mode + blur */}
              {config.customUrl && (
                <>
                  <div>
                    <p className="text-sm font-semibold mb-2">Background Fit</p>
                    <div className="grid grid-cols-4 gap-2">
                      {FIT_OPTIONS.map(f => (
                        <button key={f.key} onClick={() => set({ customFit: f.key })}
                          className={`py-2 rounded-md text-xs font-semibold border transition-all ${config.customFit === f.key ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary/30"}`}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold">Background Blur</p>
                      <span className="text-sm text-muted-foreground tabular-nums">{config.customBlur ?? 0}px</span>
                    </div>
                    <input type="range" min={0} max={80} value={config.customBlur ?? 0} onChange={e => set({ customBlur: Number(e.target.value) })} className="w-full accent-primary cursor-pointer" />
                    <p className="text-xs text-muted-foreground mt-1">Higher values create a soft, abstract wash of color</p>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── ColorCustomizer ────────────────────────────────────────────────────────

const COLOR_VARS: { group: string; vars: { label: string; desc: string; cssVar: string }[] }[] = [
  {
    group: "Backgrounds",
    vars: [
      { label: "Page Background",     desc: "Main site background",               cssVar: "--background" },
      { label: "Card / Panel",         desc: "Cards, modals, list items",          cssVar: "--card" },
      { label: "Sidebar",              desc: "Navigation sidebar",                 cssVar: "--sidebar" },
      { label: "Popover / Dropdown",   desc: "Menus, tooltips, player bar",        cssVar: "--popover" },
      { label: "Secondary Surface",    desc: "Inputs, secondary buttons",          cssVar: "--secondary" },
      { label: "Muted Surface",        desc: "Subtle backgrounds",                 cssVar: "--muted" },
    ],
  },
  {
    group: "Text",
    vars: [
      { label: "Primary Text",         desc: "Main body text",                     cssVar: "--foreground" },
      { label: "Card Text",            desc: "Text inside cards",                  cssVar: "--card-foreground" },
      { label: "Sidebar Text",         desc: "Navigation labels",                  cssVar: "--sidebar-foreground" },
      { label: "Popover Text",         desc: "Dropdown / menu text",               cssVar: "--popover-foreground" },
      { label: "Secondary Text",       desc: "Secondary surface text",             cssVar: "--secondary-foreground" },
      { label: "Muted / Dim Text",     desc: "Subtitles, hints, placeholders",     cssVar: "--muted-foreground" },
    ],
  },
  {
    group: "Accent & Interactive",
    vars: [
      { label: "Primary / Accent",     desc: "Buttons, active states, links",      cssVar: "--primary" },
      { label: "Text on Primary",      desc: "Text on primary-colored elements",   cssVar: "--primary-foreground" },
      { label: "Accent",               desc: "Highlight accent (usually = primary)", cssVar: "--accent" },
      { label: "Accent Text",          desc: "Text on accent elements",            cssVar: "--accent-foreground" },
      { label: "Destructive",          desc: "Delete / danger buttons",            cssVar: "--destructive" },
      { label: "Destructive Text",     desc: "Text on destructive buttons",        cssVar: "--destructive-foreground" },
    ],
  },
  {
    group: "Borders & Misc",
    vars: [
      { label: "Border",               desc: "Dividers, outlines, separators",     cssVar: "--border" },
      { label: "Sidebar Accent",       desc: "Active sidebar item background",     cssVar: "--sidebar-accent" },
      { label: "Sidebar Accent Text",  desc: "Active sidebar item text",           cssVar: "--sidebar-accent-foreground" },
      { label: "Ring / Focus",         desc: "Focus indicator",                    cssVar: "--ring" },
    ],
  },
];

/** Convert any CSS color string to the closest hex for <input type="color"> */
function cssColorToHex(cssColor: string): string {
  if (!cssColor) return "#888888";
  const s = cssColor.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s.slice(0, 7);
  // Try to parse via a temporary canvas
  try {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = s;
    const computed = ctx.fillStyle; // browser normalizes to hex or rgb()
    if (/^#/.test(computed)) return computed;
    const m = computed.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) return "#" + [m[1],m[2],m[3]].map(n => parseInt(n).toString(16).padStart(2,"0")).join("");
  } catch {}
  return "#888888";
}

/** Read a CSS variable's computed value from the document */
function readCssVar(cssVar: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
}

function ColorCustomizer({ theme, updateTheme, showToast }: {
  theme: AppTheme;
  updateTheme: (patch: Partial<AppTheme>) => void;
  showToast: (msg: string) => void;
}) {
  // Draft: pending changes not yet saved
  const [draft, setDraft] = useState<Record<string, string>>({ ...theme.colorOverrides });
  const [hasChanges, setHasChanges] = useState(false);

  // Live preview: apply draft to DOM while user tweaks
  const applyPreview = (varName: string, value: string) => {
    document.documentElement.style.setProperty(varName, value);
    // Auto-adjust paired foreground colors
    const pairMap: Record<string, string> = {
      "--background":  "--foreground",
      "--card":        "--card-foreground",
      "--sidebar":     "--sidebar-foreground",
      "--popover":     "--popover-foreground",
      "--secondary":   "--secondary-foreground",
      "--primary":     "--primary-foreground",
      "--accent":      "--accent-foreground",
    };
    const paired = pairMap[varName];
    if (paired && !draft[paired]) {
      const autoFg = isLightColor(value) ? "#111111" : "#ffffff";
      document.documentElement.style.setProperty(paired, autoFg);
    }
  };

  const handleChange = (cssVar: string, hex: string) => {
    const next = { ...draft, [cssVar]: hex };
    setDraft(next);
    setHasChanges(true);
    applyPreview(cssVar, hex);
  };

  const handleApply = () => {
    updateTheme({ colorOverrides: draft });
    setHasChanges(false);
    showToast("Colors applied!");
  };

  const handleReset = () => {
    // Clear all overrides and revert DOM to theme defaults
    updateTheme({ colorOverrides: {} });
    setDraft({});
    setHasChanges(false);
    showToast("Colors reset to defaults");
  };

  const handleRevert = () => {
    // Discard unsaved draft changes
    setDraft({ ...theme.colorOverrides });
    setHasChanges(false);
    // Re-apply current saved overrides
    const root = document.documentElement;
    for (const [v, val] of Object.entries(theme.colorOverrides)) {
      root.style.setProperty(v, val);
    }
    showToast("Changes discarded");
  };

  return (
    <section className="mb-8">
      {/* Header with action buttons */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Color Overrides</p>
          <p className="text-xs text-muted-foreground mt-0.5">Change any color — affects every element site-wide.</p>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <button onClick={handleRevert} className="px-3 py-1.5 rounded-md text-xs font-semibold border border-border text-muted-foreground hover:text-foreground transition-colors">
              Discard
            </button>
          )}
          <button
            onClick={handleApply}
            disabled={!hasChanges}
            className="px-4 py-1.5 rounded-md text-xs font-bold bg-primary text-white hover:bg-primary/85 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
          >
            {hasChanges ? "Apply Changes" : "Applied ✓"}
          </button>
          <button onClick={handleReset} className="px-3 py-1.5 rounded-md text-xs font-semibold border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors">
            Reset All
          </button>
        </div>
      </div>

      {/* Unsaved indicator */}
      {hasChanges && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-md bg-primary/8 border border-primary/20">
          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          <p className="text-xs text-primary font-semibold">You have unsaved color changes — click Apply to save them.</p>
        </div>
      )}

      {/* Color groups */}
      <div className="space-y-4">
        {COLOR_VARS.map(({ group, vars }) => (
          <div key={group} className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-4 py-2 border-b border-border bg-secondary/50">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">{group}</p>
            </div>
            <div className="divide-y divide-border">
              {vars.map(({ label, desc, cssVar }) => {
                // Current value: draft override → saved override → computed CSS var
                const savedOverride = theme.colorOverrides[cssVar];
                const draftVal = draft[cssVar];
                const computedVal = readCssVar(cssVar);
                const displayHex = cssColorToHex(draftVal || savedOverride || computedVal);
                const isOverridden = !!savedOverride;
                const isDraftDirty = draftVal && draftVal !== (savedOverride || computedVal);

                return (
                  <div key={cssVar} className="flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold">{label}</p>
                        {isOverridden && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-bold uppercase tracking-wide">custom</span>
                        )}
                        {isDraftDirty && !isOverridden && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500 font-bold uppercase tracking-wide">unsaved</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-4">
                      {/* Live color preview + native picker */}
                      <label className="relative cursor-pointer group">
                        <div
                          className="w-9 h-9 rounded-md border-2 border-border shadow-sm transition-transform group-hover:scale-110 group-hover:shadow-md"
                          style={{ backgroundColor: `var(${cssVar})` }}
                        />
                        <input
                          type="color"
                          value={displayHex}
                          onChange={e => handleChange(cssVar, e.target.value)}
                          className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                        />
                      </label>
                      {/* Hex value display */}
                      <span className="text-xs font-mono text-muted-foreground w-16 text-right tabular-nums">
                        {displayHex.toUpperCase()}
                      </span>
                      {/* Clear individual override */}
                      {(isOverridden || draftVal) && (
                        <button
                          onClick={() => {
                            const next = { ...draft };
                            delete next[cssVar];
                            setDraft(next);
                            setHasChanges(true);
                            // Temporarily un-set to show theme default
                            document.documentElement.style.removeProperty(cssVar);
                          }}
                          className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
                          title="Remove override"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── SettingsView ───────────────────────────────────────────────────────────

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onChange}
      className={`w-11 h-6 rounded-sm transition-colors relative shrink-0 ${on ? "bg-primary" : "bg-muted"}`}
    >
      <div
        className="absolute top-0.5 w-5 h-5 bg-white rounded-sm shadow transition-all"
        style={{ left: on ? "calc(100% - 1.375rem)" : "0.125rem" }}
      />
    </button>
  );
}

function SettingsView({ projects, setProjects, showToast, player, setPlayer, audioRef, theme, setTheme, visualizer, setVisualizer, savedCustomThemes, setSavedCustomThemes }: {
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  showToast: (msg: string) => void;
  player: PlayerState;
  setPlayer: React.Dispatch<React.SetStateAction<PlayerState>>;
  audioRef: React.MutableRefObject<HTMLAudioElement | null>;
  theme: AppTheme;
  setTheme: React.Dispatch<React.SetStateAction<AppTheme>>;
  visualizer: VisualizerConfig;
  setVisualizer: React.Dispatch<React.SetStateAction<VisualizerConfig>>;
  savedCustomThemes: SavedCustomTheme[];
  setSavedCustomThemes: React.Dispatch<React.SetStateAction<SavedCustomTheme[]>>;
}) {
  const [customAccent, setCustomAccent] = useState(theme.accent);
  const [settingsTab, setSettingsTab] = useState<"theme"|"appearance"|"colors"|"playback"|"system">("theme");

  const updateTheme = (patch: Partial<AppTheme>) => {
    setTheme(prev => ({ ...prev, ...patch }));
  };

  const applyAccent = (hex: string) => {
    setCustomAccent(hex);
    updateTheme({ accent: hex });
  };

  const handleClearAll = async () => {
    if (!window.confirm("Delete all projects and tracks? This cannot be undone.")) return;
    const db = await openDB();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction("audio", "readwrite");
      tx.objectStore("audio").clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    setProjects([]);
    localStorage.removeItem("melodia_projects");
    showToast("All data cleared");
  };

  const totalTracks = projects.reduce((s, p) => s + p.tracks.length, 0);
  const accentOnLight = isLightColor(theme.accent);

  return (
    <div className="max-w-xl mx-auto px-6 py-12">
      <h1 className="text-2xl font-bold tracking-tight mb-6">Settings</h1>

      {/* Quick access tabs */}
      <div className="settings-tabs flex items-center gap-1 mb-8 p-1 bg-secondary rounded-lg overflow-x-auto scrollbar-hide">
        {([
          { key: "theme", label: "Theme" },
          { key: "appearance", label: "Appearance" },
          { key: "colors", label: "Colors" },
          { key: "playback", label: "Playback" },
          { key: "system", label: "System" },
        ] as const).map(tab => (
          <button
            key={tab.key}
            onClick={() => setSettingsTab(tab.key)}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-semibold transition-all whitespace-nowrap ${
              settingsTab === tab.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Custom Theme Builder ── */}
      {settingsTab === "colors" && (
      <section className="mb-8">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1">Custom Theme Builder</p>
        <p className="text-xs text-muted-foreground mb-4">Personalize the look with backgrounds, fonts, glass effects, and more.</p>
        <CustomThemeBuilder
          theme={theme}
          setTheme={setTheme}
          savedCustomThemes={savedCustomThemes}
          setSavedCustomThemes={setSavedCustomThemes}
          showToast={showToast}
        />
      </section>
      )}

      {/* ── Fine-tune Colors ── */}
      {settingsTab === "colors" && (
        <ColorCustomizer
          theme={theme}
          updateTheme={updateTheme}
          showToast={showToast}
        />
      )}

      {/* ── Audio Visualizer ── */}
      {settingsTab === "playback" && (
      <section className="mb-8">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1">Audio Visualizer</p>
        <p className="text-xs text-muted-foreground mb-4">Reactive visuals that appear behind the player when music is playing.</p>
        <VisualizerSettings config={visualizer} onChange={setVisualizer} />
      </section>
      )}

      {/* ── Themes ── */}
      {settingsTab === "theme" && (
      <section className="mb-8">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1">Theme</p>
        <p className="text-xs text-muted-foreground mb-4">Choose a complete look and feel for the entire app.</p>
        <div className="grid grid-cols-2 gap-3">
          {(["default","modern","classic","unique"] as LayoutTheme[]).map(lt => {
            const active = (theme.layoutTheme ?? "default") === lt;
            const meta: Record<LayoutTheme,{label:string;desc:string;preview:React.ReactNode}> = {
              default: {
                label: "Default",
                desc: "The original dark, Apple Music-inspired design.",
                preview: (
                  <div className="w-full h-full" style={{background:"#0c0c10",borderRadius:4,padding:6,display:"flex",flexDirection:"column",gap:3}}>
                    <div style={{height:8,background:"#161619",borderRadius:2}}/>
                    <div style={{display:"flex",gap:3,flex:1}}>
                      <div style={{width:18,background:"#111114",borderRadius:2}}/>
                      <div style={{flex:1,display:"flex",flexDirection:"column",gap:2}}>
                        <div style={{height:16,background:"#161619",borderRadius:2}}/>
                        <div style={{display:"flex",gap:2,flex:1}}>
                          {["#fc3c44","#1a1a1f","#1a1a1f","#1a1a1f"].map((c,i)=><div key={i} style={{flex:1,background:c,borderRadius:2}}/>)}
                        </div>
                      </div>
                    </div>
                    <div style={{height:7,background:"#1c1c20",borderRadius:2,display:"flex",alignItems:"center",justifyContent:"center"}}>
                      <div style={{width:12,height:3,background:"#fc3c44",borderRadius:1}}/>
                    </div>
                  </div>
                ),
              },
              modern: {
                label: "Modern",
                desc: "Glassmorphism, soft blur, large rounded corners.",
                preview: (
                  <div className="w-full h-full" style={{background:"#030308",borderRadius:12,padding:6,display:"flex",flexDirection:"column",gap:3}}>
                    <div style={{height:8,background:"rgba(255,255,255,0.06)",borderRadius:10,backdropFilter:"blur(8px)",border:"1px solid rgba(255,255,255,0.08)"}}/>
                    <div style={{display:"flex",gap:3,flex:1}}>
                      <div style={{width:18,background:"rgba(0,0,0,0.5)",borderRadius:10,border:"1px solid rgba(255,255,255,0.06)"}}/>
                      <div style={{flex:1,display:"flex",flexDirection:"column",gap:2}}>
                        <div style={{height:16,background:"rgba(255,255,255,0.045)",borderRadius:10,border:"1px solid rgba(255,255,255,0.07)"}}/>
                        <div style={{display:"flex",gap:2,flex:1}}>
                          {["#6366f1","rgba(255,255,255,0.045)","rgba(255,255,255,0.045)","rgba(255,255,255,0.045)"].map((c,i)=>(
                            <div key={i} style={{flex:1,background:c,borderRadius:10,boxShadow:i===0?"0 0 8px #6366f1":undefined}}/>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div style={{height:7,background:"rgba(20,20,28,0.82)",borderRadius:10,border:"1px solid rgba(255,255,255,0.06)"}}/>
                  </div>
                ),
              },
              classic: {
                label: "Classic",
                desc: "Retro Windows XP / early-2000s desktop style.",
                preview: (
                  <div className="w-full h-full" style={{background:"#ece9d8",borderRadius:3,padding:4,display:"flex",flexDirection:"column",gap:2,border:"1px solid #aca899"}}>
                    <div style={{height:9,background:"linear-gradient(180deg,#4a82d4,#1a4e99)",borderRadius:"2px 2px 0 0",display:"flex",alignItems:"center",paddingLeft:4,gap:2}}>
                      <div style={{width:4,height:4,background:"#ff5f57",borderRadius:1}}/>
                      <div style={{width:4,height:4,background:"#ffbd2e",borderRadius:1}}/>
                      <div style={{width:4,height:4,background:"#28ca41",borderRadius:1}}/>
                    </div>
                    <div style={{display:"flex",gap:2,flex:1}}>
                      <div style={{width:18,background:"linear-gradient(180deg,#e8e5d9,#d0cdc0)",border:"1px solid #aca899",borderRadius:2}}/>
                      <div style={{flex:1,display:"flex",flexDirection:"column",gap:2}}>
                        <div style={{height:14,background:"#fff",border:"1px solid #aca899",boxShadow:"inset 1px 1px 0 #fff",borderRadius:2}}/>
                        <div style={{display:"flex",gap:2,flex:1}}>
                          {["linear-gradient(180deg,#6ba3e8,#1a52a8)","#fff","#fff"].map((c,i)=>(
                            <div key={i} style={{flex:1,background:c,border:"1px solid #aca899",borderRadius:2,boxShadow:i===0?"inset 0 1px 0 rgba(255,255,255,0.5)":undefined}}/>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div style={{height:7,background:"linear-gradient(180deg,#f0ede2,#d8d5c4)",border:"2px solid #aca899",borderRadius:2,borderTop:"1px solid #aca899"}}/>
                  </div>
                ),
              },
              unique: {
                label: "Unique",
                desc: "Neo-brutalist cyber with neon glows and hard edges.",
                preview: (
                  <div className="w-full h-full" style={{background:"#05050a",padding:5,display:"flex",flexDirection:"column",gap:2,border:"2px solid rgba(255,255,255,0.12)"}}>
                    <div style={{height:8,background:"#08080e",borderLeft:"2px solid var(--primary, #fc3c44)",display:"flex",alignItems:"center",gap:3,paddingLeft:4}}>
                      <div style={{width:8,height:2,background:"var(--primary, #fc3c44)",boxShadow:"0 0 4px var(--primary, #fc3c44)"}}/>
                      <div style={{flex:1,height:1,background:"rgba(255,255,255,0.15)"}}/>
                    </div>
                    <div style={{display:"flex",gap:2,flex:1}}>
                      <div style={{width:18,backgroundImage:"repeating-linear-gradient(-45deg,#0d0d12,#0d0d12 4px,#0f0f15 4px,#0f0f15 8px)",borderRight:"1px solid var(--primary, #fc3c44)"}}/>
                      <div style={{flex:1,display:"flex",flexDirection:"column",gap:2}}>
                        <div style={{height:14,background:"#0a0a0e",borderLeft:"2px solid var(--primary, #fc3c44)",border:"1px solid rgba(255,255,255,0.12)",borderLeftWidth:2,borderLeftColor:"var(--primary, #fc3c44)"}}/>
                        <div style={{display:"flex",gap:2,flex:1}}>
                          {(["var(--primary, #fc3c44)","#0a0a0e","#0a0a0e"]).map((c,i)=>(
                            <div key={i} style={{flex:1,background:c,border:"1px solid rgba(255,255,255,0.12)",boxShadow:i===0?"0 0 6px var(--primary, #fc3c44)":undefined}}/>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div style={{height:6,background:"#08080e",borderTop:"2px solid var(--primary, #fc3c44)"}}/>
                  </div>
                ),
              },
            };
            const m = meta[lt];
            return (
              <button
                key={lt}
                onClick={() => updateTheme({ layoutTheme: lt })}
                className={`text-left rounded-lg border-2 overflow-hidden transition-all ${
                  active ? "border-primary shadow-lg" : "border-border hover:border-primary/40"
                }`}
              >
                {/* Mini preview */}
                <div className="h-24 relative overflow-hidden bg-muted">
                  {m.preview}
                  {active && (
                    <div className="absolute top-2 right-2 w-5 h-5 bg-primary rounded-full flex items-center justify-center shadow-lg">
                      <Check size={11} className="text-white" strokeWidth={3} />
                    </div>
                  )}
                </div>
                <div className="px-3 py-2.5">
                  <p className="text-sm font-bold mb-0.5">{m.label}</p>
                  <p className="text-xs text-muted-foreground leading-snug">{m.desc}</p>
                </div>
              </button>
            );
          })}
        </div>
      </section>
      )}

      {/* ── Appearance ── */}
      {settingsTab === "appearance" && (
      <section className="mb-8">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Appearance</p>

        {/* Mode toggle */}
        <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border mb-4">
          <div className="px-5 py-4">
            <p className="text-sm font-semibold mb-3">Mode</p>
            <div className="grid grid-cols-2 gap-2">
              {(["dark", "light"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => updateTheme({ mode: m })}
                  className={`flex items-center justify-center gap-2.5 py-3 rounded-md text-sm font-semibold border transition-all ${
                    theme.mode === m
                      ? "bg-primary border-primary"
                      : "border-border hover:bg-secondary"
                  }`}
                  style={theme.mode === m
                    ? { color: isLightColor(theme.accent) ? "#111111" : "#ffffff" }
                    : {}}
                >
                  <span className="text-base">{m === "dark" ? "🌙" : "☀️"}</span>
                  {m === "dark" ? "Dark" : "Light"}
                </button>
              ))}
            </div>
          </div>

          {/* Accent presets */}
          <div className="px-5 py-4">
            <p className="text-sm font-semibold mb-3">Accent Color</p>
            <div className="grid grid-cols-6 gap-2 mb-3">
              {ACCENT_PRESETS.map(p => {
                const selected = theme.accent.toLowerCase() === p.value.toLowerCase();
                return (
                  <button
                    key={p.value}
                    title={p.label}
                    onClick={() => applyAccent(p.value)}
                    className="relative aspect-square rounded-md transition-transform hover:scale-110 active:scale-95 focus:outline-none"
                    style={{ backgroundColor: p.value }}
                  >
                    {selected && (
                      <div
                        className="absolute inset-0 flex items-center justify-center rounded-md"
                        style={{ boxShadow: `0 0 0 2px var(--card), 0 0 0 4px ${p.value}` }}
                      >
                        <Check size={14} style={{ color: isLightColor(p.value) ? "#111" : "#fff" }} strokeWidth={3} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Custom picker */}
            <div className="flex items-center gap-3 mt-1">
              <label className="flex items-center gap-2.5 flex-1 cursor-pointer px-4 py-2.5 bg-secondary border border-border rounded-md hover:border-primary/40 transition-colors">
                <div className="w-5 h-5 rounded shrink-0 border border-border/50" style={{ backgroundColor: customAccent }} />
                <span className="text-sm font-medium text-muted-foreground">Custom</span>
                <span className="text-xs text-muted-foreground/60 font-mono ml-auto">{customAccent.toUpperCase()}</span>
                <input
                  type="color"
                  value={customAccent}
                  onChange={e => applyAccent(e.target.value)}
                  className="sr-only"
                />
              </label>
            </div>

            {/* Contrast warning */}
            {theme.mode === "light" && accentOnLight && (
              <p className="text-xs text-amber-500 mt-2 flex items-center gap-1.5">
                ⚠️ This color may be hard to see on a light background.
              </p>
            )}
          </div>

          {/* Live preview */}
          <div className="px-5 py-4">
            <p className="text-sm font-semibold mb-3">Preview</p>
            <div className="flex items-center gap-3">
              <button
                className="flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-bold shadow-md transition-all"
                style={{
                  backgroundColor: theme.accent,
                  color: accentOnLight ? "#111111" : "#ffffff",
                  boxShadow: `0 4px 14px ${hexToRgba(theme.accent, 0.35)}`,
                }}
              >
                <Play size={14} style={{ marginLeft: 1 }} />
                Play
              </button>
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-semibold border border-border">
                <Settings size={13} />
                Settings
              </div>
              <div className="text-sm font-bold" style={{ color: theme.accent }}>
                Active
              </div>
            </div>
          </div>
        </div>

        {/* Background Gradient */}
        <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border mt-4">
          {/* Toggle */}
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-semibold">Background Gradient</p>
              <p className="text-xs text-muted-foreground mt-0.5">Replace solid background with a custom gradient</p>
            </div>
            <ToggleSwitch
              on={theme.gradient.enabled}
              onChange={() => updateTheme({ gradient: { ...theme.gradient, enabled: !theme.gradient.enabled } })}
            />
          </div>

          {theme.gradient.enabled && (
            <>
              {/* Gradient preview bar */}
              <div className="px-5 py-4">
                <div
                  className="w-full h-16 rounded-lg shadow-inner mb-1"
                  style={{ background: buildGradientCss(theme.gradient.stops, theme.gradient.angle) }}
                />
                <p className="text-xs text-muted-foreground text-center mt-2">
                  {theme.gradient.angle}° · {theme.gradient.stops.length} stops
                </p>
              </div>

              {/* Angle slider */}
              <div className="px-5 py-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold">Angle</p>
                  <span className="text-sm text-muted-foreground tabular-nums">{theme.gradient.angle}°</span>
                </div>
                <input
                  type="range" min={0} max={360} step={5}
                  value={theme.gradient.angle}
                  onChange={e => updateTheme({ gradient: { ...theme.gradient, angle: Number(e.target.value) } })}
                  className="w-full accent-primary cursor-pointer"
                />
                <div className="flex justify-between text-xs text-muted-foreground/60 mt-1 select-none">
                  <span>0°</span><span>90°</span><span>180°</span><span>270°</span><span>360°</span>
                </div>
              </div>

              {/* Color stops */}
              <div className="px-5 py-4">
                <p className="text-sm font-semibold mb-3">Color Stops</p>
                <div className="space-y-3">
                  {theme.gradient.stops.map((stop, i) => (
                    <div key={i} className="flex items-center gap-3">
                      {/* Swatch + picker */}
                      <label className="relative cursor-pointer shrink-0">
                        <div
                          className="w-8 h-8 rounded-md border-2 border-border shadow-sm"
                          style={{ backgroundColor: stop.color }}
                        />
                        <input
                          type="color"
                          value={stop.color}
                          onChange={e => {
                            const stops = [...theme.gradient.stops];
                            stops[i] = { ...stops[i], color: e.target.value };
                            updateTheme({ gradient: { ...theme.gradient, stops } });
                          }}
                          className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                        />
                      </label>
                      {/* Hex value */}
                      <span className="text-xs font-mono text-muted-foreground uppercase w-16 shrink-0">{stop.color}</span>
                      {/* Position slider */}
                      <input
                        type="range" min={0} max={100} step={1}
                        value={stop.position}
                        onChange={e => {
                          const stops = [...theme.gradient.stops];
                          stops[i] = { ...stops[i], position: Number(e.target.value) };
                          updateTheme({ gradient: { ...theme.gradient, stops } });
                        }}
                        className="flex-1 accent-primary cursor-pointer"
                      />
                      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right shrink-0">{stop.position}%</span>
                      {/* Remove stop */}
                      {theme.gradient.stops.length > 2 && (
                        <button
                          onClick={() => {
                            const stops = theme.gradient.stops.filter((_, j) => j !== i);
                            updateTheme({ gradient: { ...theme.gradient, stops } });
                          }}
                          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors shrink-0"
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {/* Add stop */}
                {theme.gradient.stops.length < 5 && (
                  <button
                    onClick={() => {
                      const stops = [...theme.gradient.stops, { color: "#ffffff", position: 100 }];
                      updateTheme({ gradient: { ...theme.gradient, stops } });
                    }}
                    className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-primary transition-colors"
                  >
                    <Plus size={12} />
                    Add stop
                  </button>
                )}
              </div>

              {/* Presets */}
              <div className="px-5 py-4">
                <p className="text-sm font-semibold mb-3">Presets</p>
                <div className="grid grid-cols-6 gap-2">
                  {GRADIENT_PRESETS.map(preset => {
                    const css = buildGradientCss(preset.stops, preset.angle);
                    const isActive =
                      JSON.stringify(theme.gradient.stops) === JSON.stringify(preset.stops) &&
                      theme.gradient.angle === preset.angle;
                    return (
                      <button
                        key={preset.label}
                        title={preset.label}
                        onClick={() => updateTheme({ gradient: { ...theme.gradient, stops: preset.stops, angle: preset.angle } })}
                        className="relative group aspect-square rounded-md overflow-hidden border-2 transition-all hover:scale-110 active:scale-95"
                        style={{
                          background: css,
                          borderColor: isActive ? "var(--primary)" : "transparent",
                        }}
                      >
                        {isActive && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                            <Check size={12} className="text-white" strokeWidth={3} />
                          </div>
                        )}
                        <span className="absolute bottom-0 inset-x-0 text-[8px] text-center text-white/80 font-semibold pb-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
                          {preset.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      )}

      {/* ── Fullscreen Background Animation ── */}
      {settingsTab === "appearance" && (
      <section className="mb-8">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1">Fullscreen Background</p>
        <p className="text-xs text-muted-foreground mb-4">Animate the fullscreen player background while music plays.</p>
        <FsBgSettings
          config={theme.fsBg ?? DEFAULT_FS_BG}
          onChange={cfg => updateTheme({ fsBg: cfg })}
        />
      </section>
      )}

      {/* ── Playback ── */}
      {settingsTab === "playback" && (
      <section className="mb-8">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Playback</p>
        <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border">
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-semibold">Volume</p>
              <p className="text-xs text-muted-foreground mt-0.5">{Math.round(player.volume * 100)}%</p>
            </div>
            <input
              type="range" min={0} max={1} step={0.05}
              value={player.volume}
              onChange={e => {
                const v = Number(e.target.value);
                if (audioRef.current) audioRef.current.volume = v;
                setPlayer(p => ({ ...p, volume: v }));
              }}
              className="w-28 accent-primary cursor-pointer"
            />
          </div>
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-semibold">Shuffle</p>
              <p className="text-xs text-muted-foreground mt-0.5">{player.shuffle ? "On" : "Off"}</p>
            </div>
            <ToggleSwitch on={player.shuffle} onChange={() => setPlayer(p => ({ ...p, shuffle: !p.shuffle }))} />
          </div>
        </div>
      </section>
      )}

      {/* ── Storage ── */}
      {settingsTab === "system" && (
      <section className="mb-8">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Storage</p>
        <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border">
          <div className="flex items-center justify-between px-5 py-4">
            <p className="text-sm font-semibold">Projects</p>
            <p className="text-sm text-muted-foreground tabular-nums">{projects.length}</p>
          </div>
          <div className="flex items-center justify-between px-5 py-4">
            <p className="text-sm font-semibold">Total Tracks</p>
            <p className="text-sm text-muted-foreground tabular-nums">{totalTracks}</p>
          </div>
          <div className="flex items-center justify-between px-5 py-4">
            <p className="text-sm font-semibold">Storage Location</p>
            <p className="text-sm text-muted-foreground">This device</p>
          </div>
        </div>
      </section>
      )}

      {/* ── About ── */}
      {settingsTab === "system" && (
      <section className="mb-10">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">About</p>
        <div className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border">
          <div className="flex items-center justify-between px-5 py-4">
            <p className="text-sm font-semibold">Wicked</p>
            <p className="text-sm text-muted-foreground">v4.2</p>
          </div>
          <div className="px-5 py-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Music is stored locally in your browser using IndexedDB. Share links work on the same device and browser. No data is sent to any server.
            </p>
          </div>
        </div>
      </section>
      )}

      {/* ── Danger zone ── */}
      {settingsTab === "system" && (
      <section>
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Danger Zone</p>
        <div className="bg-card border border-destructive/30 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-semibold text-destructive">Clear All Data</p>
              <p className="text-xs text-muted-foreground mt-0.5">Permanently delete all projects and audio files</p>
            </div>
            <button onClick={handleClearAll} className="px-4 py-2 rounded-md text-sm font-semibold text-destructive border border-destructive/40 hover:bg-destructive/10 transition-colors">
              Clear
            </button>
          </div>
        </div>
      </section>
      )}
    </div>
  );
}

// ── FullscreenPlayer ──────────────────────────────────────────────────────

interface FullscreenSharedProps {
  project: Project;
  track: Track;
  player: PlayerState;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onVolume: (v: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onShuffle: () => void;
  onClose: () => void;
  accentColor: string;
  liked: boolean;
  toggleLike?: (pid: string, tid: string) => void;
  fsBg?: FsBgConfig;
  analyserRef?: React.MutableRefObject<AnalyserNode | null>;
}

// ── Shared fullscreen background layer ─────────────────────────────────────

function FsBackground({ project, accentColor, fsBg, analyserRef, isPlaying }: {
  project: Project;
  accentColor: string;
  fsBg?: FsBgConfig;
  analyserRef?: React.MutableRefObject<AnalyserNode | null>;
  isPlaying: boolean;
}) {
  const hasCover = !!project.coverDataUrl;

  // Ken Burns / movement animation
  const kbStyle: React.CSSProperties = fsBg?.enabled && fsBg.mode === "movement" ? {
    animation: `kenBurns ${12 + (100 - (fsBg.intensity ?? 50)) * 0.2}s ease-in-out infinite alternate`,
  } : {};

  const customBlurPx = `${fsBg?.customBlur ?? 0}px`;

  const bgContent = fsBg?.enabled && fsBg.mode === "custom" && fsBg.customUrl ? (
    // Custom background — user-uploaded image/GIF with optional blur
    <img
      src={fsBg.customUrl}
      alt=""
      aria-hidden
      style={{
        position: "absolute", inset: 0, width: "100%", height: "100%",
        objectFit: fsBg.customFit === "fit" ? "contain"
          : fsBg.customFit === "center" ? "none"
          : fsBg.customFit === "stretch" ? "fill"
          : "cover",
        objectPosition: "center",
        filter: (fsBg.customBlur ?? 0) > 0 ? `blur(${customBlurPx})` : undefined,
        transform: (fsBg.customBlur ?? 0) > 0 ? "scale(1.08)" : undefined,
      }}
    />
  ) : hasCover ? (
    // Album art — heavily blurred + super-saturated to create an immersive color wash
    <img
      src={project.coverDataUrl!}
      alt=""
      aria-hidden
      className="absolute inset-0 w-full h-full object-cover"
      style={{
        filter: "blur(80px) saturate(320%) brightness(58%)",
        transform: "scale(2.2)",   // Very large scale — completely eliminates blur edge bleed
        ...kbStyle,
      }}
    />
  ) : (
    <div className="absolute inset-0" style={{ background: `rgb(${accentColor})`, filter: "brightness(0.2)" }} />
  );

  return (
    <>
      <style>{`
        @keyframes kenBurns {
          0%   { transform: scale(1.08) translate(0, 0); }
          25%  { transform: scale(1.12) translate(1%, -1%); }
          50%  { transform: scale(1.10) translate(-1.5%, 0.5%); }
          75%  { transform: scale(1.13) translate(0.5%, 1%); }
          100% { transform: scale(1.09) translate(-1%, -0.5%); }
        }
      `}</style>

      {/* Main background */}
      {bgContent}

      {/* Dark overlay — ensure readability over the colorful blur */}
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.42)" }} />

      {/* Subtle color tint from album */}
      {hasCover && (
        <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at 30% 20%, rgba(${accentColor},0.18) 0%, transparent 60%)` }} />
      )}

      {/* Visualizer mode overlay */}
      {fsBg?.enabled && fsBg.mode === "visualizer" && analyserRef && (
        <div className="absolute inset-0" style={{ opacity: 0.65 }}>
          <AudioVisualizer
            analyserRef={analyserRef}
            config={{ enabled: true, style: "circular", intensity: fsBg.intensity ?? 70, opacity: 80 }}
            isPlaying={isPlaying}
            layoutTheme="default"
            accent={`#${accentColor.split(",").map(n => parseInt(n.trim()).toString(16).padStart(2,"0")).join("")}`}
          />
        </div>
      )}

      {/* Bottom gradient for readability */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
    </>
  );
}

// ── Polished media control button ──────────────────────────────────────────

function FsBtn({
  onClick, disabled, children, variant = "ghost", size = "md",
}: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
  variant?: "ghost" | "primary" | "active";
  size?: "sm" | "md" | "lg";
}) {
  const pad = size === "sm" ? 8 : size === "lg" ? 16 : 12;
  const radius = 14;

  const bg = variant === "primary"
    ? "rgba(255,255,255,0.18)"
    : variant === "active"
      ? "rgba(255,255,255,0.14)"
      : "transparent";

  const shadow = variant === "primary"
    ? "inset 0 1px 0 rgba(255,255,255,0.18), 0 4px 20px rgba(0,0,0,0.35)"
    : "none";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: pad,
        background: bg,
        border: "none",
        borderRadius: radius,
        cursor: disabled ? "default" : "pointer",
        color: disabled ? "rgba(255,255,255,0.25)" : "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "transform 0.12s ease, background 0.15s ease, opacity 0.15s ease",
        boxShadow: shadow,
        opacity: disabled ? 0.35 : 1,
      }}
      onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = variant === "ghost" ? "rgba(255,255,255,0.08)" : variant === "active" ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.24)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = bg; }}
      onMouseDown={e => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.92)"; }}
      onMouseUp={e => { (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)"; }}
    >
      {children}
    </button>
  );
}

function FullscreenModern(props: FullscreenSharedProps) {
  const { project, track, player, onTogglePlay, onSeek, onVolume, onPrev, onNext, onShuffle, onClose, accentColor, liked, toggleLike, fsBg, analyserRef } = props;
  const hasCover = !!project.coverDataUrl;
  const progress = player.duration > 0 ? player.currentTime / player.duration : 0;
  const [scrubHover, setScrubHover] = useState(false);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center overflow-hidden animate-app-fade-in">
      {/* Background */}
      <div className="absolute inset-0">
        <FsBackground project={project} accentColor={accentColor} fsBg={fsBg} analyserRef={analyserRef} isPlaying={player.isPlaying} />
        {/* Vignette / darkening for readability */}
        <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.65) 100%)" }} />
      </div>

      {/* Ambient glow behind glass card */}
      <div
        className="absolute rounded-full pointer-events-none"
        style={{
          width: 520, height: 520,
          background: `radial-gradient(circle, rgba(${accentColor},0.55) 0%, rgba(${accentColor},0) 70%)`,
          filter: "blur(60px)",
          top: "50%", left: "50%", transform: "translate(-50%,-58%)",
        }}
      />

      {/* Liquid glass card */}
      <div
        className="relative z-10 w-full max-w-md mx-4 flex flex-col items-center animate-app-scale-in"
        style={{
          background: "linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%)",
          backdropFilter: "blur(60px) saturate(220%)",
          WebkitBackdropFilter: "blur(60px) saturate(220%)",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: "2rem",
          padding: "1.75rem 1.75rem 1.5rem",
          boxShadow: "0 40px 100px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(255,255,255,0.04)",
        }}
      >
        {/* Top row: grab pill + close */}
        <div className="w-full flex items-center justify-between mb-4">
          <div style={{ width: 32 }} />
          <div style={{ width: 40, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.22)" }} />
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white transition-all hover:scale-105 active:scale-95"
            style={{
              width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(255,255,255,0.10)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
              borderRadius: 9999, border: "1px solid rgba(255,255,255,0.14)",
            }}
            aria-label="Close"
          >
            <ChevronDown size={16} />
          </button>
        </div>

        {/* Album art */}
        <div
          className="transition-transform duration-500 ease-out"
          style={{
            width: "100%", maxWidth: 260, aspectRatio: "1",
            borderRadius: "1.5rem", overflow: "hidden",
            boxShadow: `0 28px 70px rgba(${accentColor},0.45), 0 12px 30px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.10)`,
            marginBottom: "0.5rem",
            transform: player.isPlaying ? "scale(1)" : "scale(0.94)",
          }}
        >
          {hasCover
            ? <img src={project.coverDataUrl!} alt={project.name} className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center bg-white/10"><Music size={64} className="text-white/30" /></div>}
        </div>

        {/* Reflection */}
        <div
          style={{
            width: "72%", height: 26,
            background: hasCover ? `url(${project.coverDataUrl}) center bottom / cover` : `rgba(${accentColor},0.15)`,
            filter: "blur(8px)", opacity: 0.22, transform: "scaleY(-1)",
            borderRadius: "0 0 1.5rem 1.5rem", marginBottom: "1.25rem",
          }}
        />

        {/* Track info */}
        <div className="w-full flex items-center justify-between mb-4 gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-white font-bold text-[19px] truncate leading-tight tracking-tight">{track.name}</p>
            <p className="text-white/55 text-[13px] truncate mt-1 font-medium">{project.artist || "Unknown Artist"}</p>
          </div>
          {toggleLike && (
            <button
              onClick={() => toggleLike(project.id, track.id)}
              className={`transition-all duration-200 ease-out hover:scale-110 active:scale-90 ${liked ? "text-red-400" : "text-white/50 hover:text-white"}`}
              style={{
                width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(255,255,255,0.10)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 9999,
                backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
              }}
              aria-label={liked ? "Unlike" : "Like"}
            >
              <Heart size={17} fill={liked ? "currentColor" : "none"} strokeWidth={liked ? 0 : 2} />
            </button>
          )}
        </div>

        {/* Scrubber */}
        <div
          className="w-full mb-1"
          style={{ cursor: "pointer" }}
          onMouseEnter={() => setScrubHover(true)}
          onMouseLeave={() => setScrubHover(false)}
          onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * player.duration); }}
        >
          <div style={{ height: scrubHover ? 6 : 4, background: "rgba(255,255,255,0.14)", borderRadius: 9999, position: "relative", transition: "height 180ms ease" }}>
            <div
              style={{
                height: "100%", width: `${progress * 100}%`,
                background: `linear-gradient(90deg, #fff 0%, rgba(255,255,255,0.85) 100%)`,
                borderRadius: 9999, position: "relative",
                boxShadow: `0 0 12px rgba(255,255,255,0.35)`,
                transition: "width 120ms linear",
              }}
            >
              <div
                style={{
                  position: "absolute", right: -6, top: "50%", transform: "translateY(-50%)",
                  width: scrubHover ? 14 : 0, height: scrubHover ? 14 : 0,
                  background: "#fff", borderRadius: 9999,
                  boxShadow: "0 0 10px rgba(255,255,255,0.7), 0 2px 6px rgba(0,0,0,0.4)",
                  transition: "width 180ms ease, height 180ms ease",
                }}
              />
            </div>
          </div>
        </div>
        <div className="flex justify-between w-full text-[11px] text-white/40 mb-6 font-medium tabular-nums">
          <span>{fmt(player.currentTime)}</span>
          <span>-{fmt(Math.max(0, player.duration - player.currentTime))}</span>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between w-full mb-5">
          <button
            onClick={onShuffle}
            className="transition-all duration-200 hover:scale-110 active:scale-90"
            style={{
              width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 9999,
              background: player.shuffle ? "rgba(255,255,255,0.18)" : "transparent",
              color: player.shuffle ? "#fff" : "rgba(255,255,255,0.45)",
              border: player.shuffle ? "1px solid rgba(255,255,255,0.16)" : "1px solid transparent",
            }}
            aria-label="Shuffle"
          >
            <Shuffle size={17} />
          </button>
          <button
            onClick={onPrev}
            disabled={player.queuePos === 0 && !player.shuffle}
            className="w-12 h-12 flex items-center justify-center rounded-full text-white/90 hover:text-white hover:bg-white/10 transition-all duration-200 hover:scale-110 active:scale-90 disabled:opacity-30"
            aria-label="Previous"
          >
            <IconPrev size={32} />
          </button>
          <button
            onClick={onTogglePlay}
            className="transition-all duration-200 hover:scale-105 active:scale-95"
            style={{
              width: 64, height: 64, display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 9999,
              background: "linear-gradient(180deg, #fff 0%, rgba(240,240,245,0.95) 100%)",
              color: "#0a0a12",
              boxShadow: `0 12px 32px rgba(0,0,0,0.5), 0 0 24px rgba(${accentColor},0.35), inset 0 1px 0 rgba(255,255,255,0.9), inset 0 -2px 4px rgba(0,0,0,0.08)`,
            }}
            aria-label={player.isPlaying ? "Pause" : "Play"}
          >
            {player.isPlaying
              ? <Pause size={26} fill="currentColor" strokeWidth={0} />
              : <Play  size={26} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />}
          </button>
          <button
            onClick={onNext}
            className="w-12 h-12 flex items-center justify-center rounded-full text-white/90 hover:text-white hover:bg-white/10 transition-all duration-200 hover:scale-110 active:scale-90"
            aria-label="Next"
          >
            <IconNext size={32} />
          </button>
          <div style={{ width: 40 }} />
        </div>

        {/* Volume */}
        <div className="flex items-center gap-3 w-full">
          <button onClick={() => onVolume(0)} className="text-white/40 hover:text-white/80 transition-colors shrink-0" aria-label="Mute">
            <VolumeX size={14} />
          </button>
          <input
            type="range" min={0} max={1} step={0.01}
            value={player.volume}
            onChange={e => onVolume(Number(e.target.value))}
            className="flex-1 cursor-pointer"
            style={{ accentColor: "rgba(255,255,255,0.9)", height: 2 }}
          />
          <button onClick={() => onVolume(1)} className="text-white/70 hover:text-white transition-colors shrink-0" aria-label="Full volume">
            <Volume2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}


function FullscreenClassic(props: FullscreenSharedProps) {
  const { project, track, player, onTogglePlay, onSeek, onVolume, onPrev, onNext, onShuffle, onClose, liked, toggleLike } = props;
  const hasCover = !!project.coverDataUrl;
  const progress = player.duration > 0 ? player.currentTime / player.duration : 0;
  const CYAN = "#00c8ff", BLUE = "#1e8fef", DEEP = "#0a4fb0";

  // Aero glossy orb button
  const AeroOrb = ({ onClick, children, primary, active, disabled, size = 44 }: { onClick?:()=>void; children:React.ReactNode; primary?:boolean; active?:boolean; disabled?:boolean; size?:number }) => (
    <button onClick={onClick} disabled={disabled} style={{
      width: size, height: size, borderRadius: size/2,
      background: primary
        ? `radial-gradient(circle at 50% 20%, rgba(255,255,255,0.95) 0%, rgba(180,240,255,0.95) 22%, ${CYAN} 50%, ${BLUE} 78%, #0b5cb8 100%)`
        : active
          ? `linear-gradient(180deg, rgba(200,240,255,0.9) 0%, ${CYAN} 50%, ${BLUE} 100%)`
          : `linear-gradient(180deg, rgba(220,240,255,0.55) 0%, rgba(140,190,240,0.3) 48%, rgba(50,110,200,0.35) 50%, rgba(20,70,170,0.5) 100%)`,
      border: `1px solid ${primary || active ? "rgba(0,50,130,0.9)" : "rgba(180,225,255,0.55)"}`,
      boxShadow: primary
        ? `inset 0 1px 0 rgba(255,255,255,1), inset 0 -4px 8px rgba(0,40,100,0.55), 0 0 20px rgba(0,180,255,0.7), 0 4px 12px rgba(0,40,120,0.65), 0 0 0 3px rgba(0,180,255,0.15)`
        : active
          ? `inset 0 1px 0 rgba(255,255,255,0.75), 0 0 14px rgba(0,180,255,0.55), 0 3px 8px rgba(0,40,120,0.5)`
          : `inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -1px 0 rgba(0,20,60,0.35), 0 2px 5px rgba(0,20,60,0.5)`,
      color: primary || active ? "#fff" : "rgba(230,244,255,0.94)",
      cursor: disabled ? "default" : "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      opacity: disabled ? 0.3 : 1,
      position: "relative", overflow: "hidden",
      transition: "filter 0.15s ease, transform 0.1s ease, box-shadow 0.25s ease",
    }}
    onMouseEnter={e => { if (!disabled) e.currentTarget.style.filter = "brightness(1.15) saturate(1.1)"; }}
    onMouseLeave={e => { e.currentTarget.style.filter = "brightness(1)"; }}
    >
      <span style={{ position: "absolute", top: 1, left: 1, right: 1, height: "50%", borderRadius: `${size/2}px ${size/2}px 50% 50% / ${size/2}px ${size/2}px 100% 100%`, background: "linear-gradient(180deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.08) 100%)", pointerEvents: "none" }} />
      <span style={{ position: "relative", display: "flex", filter: "drop-shadow(0 1px 1px rgba(0,20,60,0.5))" }}>{children}</span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[200] flex flex-col overflow-hidden"
      style={{
        background: `radial-gradient(ellipse at 30% 110%, rgba(0,180,255,0.35) 0%, transparent 55%),
                     radial-gradient(ellipse at 80% -10%, rgba(120,220,255,0.28) 0%, transparent 50%),
                     linear-gradient(180deg, #041832 0%, #062a5e 40%, #0a4098 100%)`,
        fontFamily: "'Segoe UI',Tahoma,system-ui,sans-serif",
      }}>

      <style>{`
        @keyframes aeroFsBubble {
          0%   { transform: translateY(0) translateX(0) scale(1); opacity: 0.6; }
          50%  { transform: translateY(-55vh) translateX(30px) scale(1.15); opacity: 0.9; }
          100% { transform: translateY(-115vh) translateX(-15px) scale(0.85); opacity: 0; }
        }
        @keyframes aeroFsGlow {
          0%,100% { box-shadow: 0 0 40px rgba(0,180,255,0.5), 0 0 80px rgba(0,180,255,0.25), inset 0 2px 0 rgba(255,255,255,0.4); }
          50%     { box-shadow: 0 0 60px rgba(0,180,255,0.75), 0 0 120px rgba(0,180,255,0.4), inset 0 2px 0 rgba(255,255,255,0.5); }
        }
      `}</style>

      {/* Rising bubbles */}
      <div className="absolute inset-x-0 pointer-events-none" style={{
        bottom: "-20vh", height: "140vh",
        backgroundImage:
          "radial-gradient(circle at 15% 90%, rgba(200,240,255,0.42) 0 8px, transparent 9px)," +
          "radial-gradient(circle at 82% 70%, rgba(210,245,255,0.35) 0 5px, transparent 6px)," +
          "radial-gradient(circle at 45% 50%, rgba(170,225,255,0.30) 0 12px, transparent 13px)," +
          "radial-gradient(circle at 70% 20%, rgba(220,250,255,0.35) 0 6px, transparent 7px)," +
          "radial-gradient(circle at 25% 30%, rgba(180,235,255,0.25) 0 9px, transparent 10px)," +
          "radial-gradient(circle at 90% 40%, rgba(210,245,255,0.28) 0 4px, transparent 5px)," +
          "radial-gradient(circle at 55% 85%, rgba(160,225,255,0.32) 0 10px, transparent 11px)",
        animation: "aeroFsBubble 26s linear infinite",
      }} />
      <div className="absolute inset-x-0 pointer-events-none" style={{
        bottom: "-20vh", height: "140vh",
        backgroundImage:
          "radial-gradient(circle at 35% 60%, rgba(200,240,255,0.30) 0 6px, transparent 7px)," +
          "radial-gradient(circle at 65% 40%, rgba(170,225,255,0.28) 0 10px, transparent 11px)," +
          "radial-gradient(circle at 10% 20%, rgba(220,250,255,0.30) 0 4px, transparent 5px)",
        animation: "aeroFsBubble 38s linear infinite -14s",
        opacity: 0.65,
      }} />

      {/* Aero window title bar */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 relative z-10"
        style={{
          background: "linear-gradient(180deg, rgba(160,220,255,0.55) 0%, rgba(30,120,220,0.60) 50%, rgba(10,70,170,0.75) 100%)",
          backdropFilter: "blur(24px) saturate(200%)",
          WebkitBackdropFilter: "blur(24px) saturate(200%)",
          borderBottom: "1px solid rgba(200,235,255,0.45)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5), 0 4px 20px rgba(0,20,60,0.5)",
          overflow: "hidden",
        }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "50%", background: "linear-gradient(180deg, rgba(255,255,255,0.35) 0%, transparent 100%)", pointerEvents: "none" }} />
        <div className="flex items-center gap-2 relative">
          <div style={{ width: 16, height: 16, borderRadius: 8, background: "radial-gradient(circle at 40% 30%, #fff 0%, #7cd6ff 30%, #0080e0 100%)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6), 0 0 6px rgba(0,180,255,0.6)" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "#fff", textShadow: "0 1px 2px rgba(0,20,60,0.7)", letterSpacing: "0.01em" }}>
            Wicked — Now Playing
          </span>
        </div>
        <div className="flex items-center gap-1.5 relative">
          {["—","▢"].map((s,i) => (
            <button key={i} style={{
              width: 26, height: 22, borderRadius: 4,
              background: "linear-gradient(180deg, rgba(220,240,255,0.5) 0%, rgba(80,150,220,0.3) 100%)",
              border: "1px solid rgba(180,225,255,0.5)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5)",
              color: "#fff", fontSize: 11, cursor: "pointer",
            }}>{s}</button>
          ))}
          <button onClick={onClose} style={{
            width: 28, height: 22, borderRadius: 4,
            background: "linear-gradient(180deg, #ff8080 0%, #e04040 50%, #a02020 100%)",
            border: "1px solid rgba(120,20,20,0.9)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 0 8px rgba(255,80,80,0.4)",
            color: "#fff", fontSize: 11, fontWeight: 900, cursor: "pointer",
            textShadow: "0 1px 1px rgba(0,0,0,0.5)",
          }}>✕</button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden relative z-10" style={{ minHeight: 0 }}>

        {/* LEFT: Album art with Aero orb glow */}
        <div className="flex flex-col items-center justify-center shrink-0 gap-6 px-10"
          style={{ width: 380, borderRight: "1px solid rgba(180,225,255,0.15)" }}>
          <div style={{
            width: 260, height: 260, position: "relative",
            borderRadius: 16,
            border: "1px solid rgba(200,240,255,0.55)",
            animation: "aeroFsGlow 3.5s ease-in-out infinite",
            overflow: "hidden",
          }}>
            {hasCover
              ? <img src={project.coverDataUrl!} alt={project.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(180deg,#1a5fbe 0%,#062a70 100%)` }}>
                  <Music size={84} style={{ color: "#c8ecff", opacity: 0.65 }} />
                </div>}
            {/* Aero glossy sheen */}
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "48%", background: "linear-gradient(180deg, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0.06) 60%, transparent 100%)", borderRadius: "16px 16px 45% 45% / 16px 16px 100% 100%", pointerEvents: "none" }} />
            {/* Inner rim */}
            <div style={{ position: "absolute", inset: 0, borderRadius: 16, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,30,80,0.4)", pointerEvents: "none" }} />
          </div>

          {/* Aero EQ visualizer */}
          <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 42, width: 260 }}>
            {Array.from({ length: 32 }, (_, i) => {
              const h = player.isPlaying ? `${8 + Math.abs(Math.sin(Date.now() / 220 + i * 0.7)) * 92}%` : "6%";
              return <div key={i} style={{
                flex: 1, minHeight: 3, height: h,
                background: `linear-gradient(180deg, #fff 0%, ${CYAN} 40%, ${BLUE} 80%, ${DEEP} 100%)`,
                borderRadius: "2px 2px 1px 1px",
                boxShadow: `0 0 6px ${CYAN}, inset 0 1px 0 rgba(255,255,255,0.6)`,
                transition: "height 0.08s ease",
              }} />;
            })}
          </div>
        </div>

        {/* RIGHT: info + controls */}
        <div className="flex-1 flex flex-col justify-center px-12 gap-8" style={{ minWidth: 0 }}>

          {/* Track info — Aero glass panel */}
          <div style={{
            borderRadius: 12,
            border: "1px solid rgba(200,240,255,0.4)",
            borderTop: "1px solid rgba(220,245,255,0.65)",
            background: "linear-gradient(180deg, rgba(180,220,255,0.18) 0%, rgba(30,80,160,0.28) 100%)",
            backdropFilter: "blur(28px) saturate(180%)",
            WebkitBackdropFilter: "blur(28px) saturate(180%)",
            padding: "22px 26px",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 8px 28px rgba(0,20,60,0.5)",
            position: "relative", overflow: "hidden",
          }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "42%", background: "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, transparent 100%)", pointerEvents: "none" }} />
            <div style={{ position: "relative" }}>
              <div style={{ fontSize: 11, color: "#a8dcff", letterSpacing: "0.22em", textTransform: "uppercase", marginBottom: 10, fontWeight: 600 }}>Now Playing</div>
              <div style={{ fontSize: 30, fontWeight: 700, color: "#fff", lineHeight: 1.15, marginBottom: 6, textShadow: "0 2px 8px rgba(0,20,60,0.5), 0 0 24px rgba(0,180,255,0.35)", letterSpacing: "-0.01em" }}>{track.name}</div>
              <div style={{ fontSize: 15, color: "#c8ecff", marginBottom: 4, textShadow: "0 1px 2px rgba(0,20,60,0.4)" }}>{project.artist || "Unknown Artist"}</div>
              <div style={{ fontSize: 12, color: "rgba(200,225,255,0.7)" }}>{project.isSingle ? "Single" : project.name}</div>
              {toggleLike && (
                <button onClick={() => toggleLike(project.id, track.id)} style={{
                  marginTop: 16, padding: "6px 16px", borderRadius: 16,
                  background: liked
                    ? `linear-gradient(180deg, #ff9ec0 0%, #e94a8d 50%, #b02068 100%)`
                    : `linear-gradient(180deg, rgba(220,240,255,0.5) 0%, rgba(80,150,220,0.35) 50%, rgba(30,90,180,0.4) 100%)`,
                  border: `1px solid ${liked ? "rgba(120,20,60,0.85)" : "rgba(180,225,255,0.55)"}`,
                  boxShadow: `inset 0 1px 0 rgba(255,255,255,0.55), 0 2px 6px rgba(0,20,60,0.5), 0 0 12px ${liked ? "rgba(233,74,141,0.5)" : "rgba(0,180,255,0.3)"}`,
                  color: "#fff", fontSize: 12, fontWeight: 600,
                  display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
                  textShadow: "0 1px 1px rgba(0,20,60,0.5)",
                }}>
                  <Heart size={13} fill={liked ? "currentColor" : "none"} strokeWidth={liked ? 0 : 2} />
                  {liked ? "Liked" : "Like"}
                </button>
              )}
            </div>
          </div>

          {/* Progress — Aero glass scrubber */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#a8dcff", marginBottom: 8, fontVariantNumeric: "tabular-nums" }}>
              <span>{fmt(player.currentTime)}</span>
              <span style={{ color: "rgba(200,225,255,0.55)" }}>{fmt(player.duration)}</span>
            </div>
            <div style={{
              height: 20, borderRadius: 10,
              background: "linear-gradient(180deg, rgba(0,10,40,0.85) 0%, rgba(0,20,60,0.6) 100%)",
              border: "1px solid rgba(180,225,255,0.35)",
              boxShadow: "inset 0 2px 5px rgba(0,10,40,0.65), inset 0 -1px 0 rgba(255,255,255,0.1)",
              cursor: "pointer", position: "relative", overflow: "hidden",
            }}
              onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * player.duration); }}>
              <div style={{
                position: "absolute", left: 0, top: 0, bottom: 0,
                width: `${progress * 100}%`,
                background: `linear-gradient(180deg, rgba(220,245,255,0.95) 0%, ${CYAN} 45%, ${BLUE} 100%)`,
                boxShadow: `0 0 14px ${CYAN}, inset 0 1px 0 rgba(255,255,255,0.7)`,
                transition: "width 0.1s linear",
                borderRadius: 10,
              }}>
                <div style={{ position: "absolute", top: 1, left: 1, right: 1, height: "48%", background: "linear-gradient(180deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.05) 100%)", borderRadius: "9px 9px 50% 50% / 9px 9px 100% 100%" }} />
                <div style={{ position: "absolute", right: -8, top: "50%", transform: "translateY(-50%)", width: 18, height: 18, borderRadius: "50%", background: `radial-gradient(circle at 35% 25%, #fff 0%, ${CYAN} 55%, ${BLUE} 100%)`, boxShadow: `0 0 12px ${CYAN}, 0 2px 4px rgba(0,20,60,0.5), inset 0 1px 0 rgba(255,255,255,0.8)`, border: "1px solid rgba(0,80,180,0.6)" }} />
              </div>
            </div>
          </div>

          {/* Controls */}
          <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "center" }}>
            <AeroOrb onClick={onShuffle} active={player.shuffle} size={38}><Shuffle size={15} /></AeroOrb>
            <AeroOrb onClick={onPrev} disabled={player.queuePos === 0 && !player.shuffle} size={46}><SkipBack size={20} fill="currentColor" strokeWidth={0} /></AeroOrb>
            <AeroOrb onClick={onTogglePlay} primary size={64}>
              {player.isPlaying ? <Pause size={26} fill="currentColor" strokeWidth={0} /> : <Play size={26} fill="currentColor" strokeWidth={0} style={{ marginLeft: 3 }} />}
            </AeroOrb>
            <AeroOrb onClick={onNext} size={46}><SkipForward size={20} fill="currentColor" strokeWidth={0} /></AeroOrb>
            <AeroOrb size={38}><Volume2 size={15} /></AeroOrb>
          </div>

          {/* Volume */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => onVolume(player.volume === 0 ? 0.5 : 0)} style={{ color: "#a8dcff", background: "transparent", border: "none", cursor: "pointer" }}>
              {player.volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input type="range" min={0} max={1} step={0.01} value={player.volume} onChange={e => onVolume(Number(e.target.value))} style={{ flex: 1, accentColor: CYAN, cursor: "pointer" }} />
            <span style={{ fontSize: 12, color: "#a8dcff", minWidth: 36, fontVariantNumeric: "tabular-nums" }}>{Math.round(player.volume * 100)}%</span>
          </div>
        </div>
      </div>

      {/* Aero status bar */}
      <div className="shrink-0 flex items-center gap-6 px-5 relative z-10"
        style={{
          height: 28,
          background: "linear-gradient(180deg, rgba(20,60,140,0.55) 0%, rgba(6,25,80,0.85) 100%)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderTop: "1px solid rgba(180,225,255,0.3)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.15)",
        }}>
        {[
          player.isPlaying ? "▶ Playing" : "⏸ Paused",
          `Volume: ${Math.round(player.volume * 100)}%`,
          player.shuffle ? "Shuffle: On" : "Shuffle: Off",
          `Queue: ${player.queue.length}`,
        ].map((s, i, arr) => (
          <span key={i} style={{
            fontSize: 11, color: "#c8ecff", letterSpacing: "0.04em",
            paddingRight: i < arr.length - 1 ? 14 : 0,
            borderRight: i < arr.length - 1 ? "1px solid rgba(180,225,255,0.2)" : "none",
            marginRight: i < arr.length - 1 ? 14 : 0,
            textShadow: "0 1px 1px rgba(0,20,60,0.5)",
          }}>{s}</span>
        ))}
      </div>
    </div>
  );
}



function FullscreenUnique(props: FullscreenSharedProps) {
  const { project, track, player, onTogglePlay, onSeek, onVolume, onPrev, onNext, onShuffle, onClose, accentColor, liked, toggleLike } = props;
  const hasCover = !!project.coverDataUrl;
  const progress = player.duration > 0 ? player.currentTime / player.duration : 0;
  return (
    <div className="fixed inset-0 z-[200] overflow-hidden" style={{ background: "#010108", fontFamily:"'SF Mono','Fira Code',monospace", color:"#fff" }}>
      {/* Grid background */}
      <div className="absolute inset-0" style={{ backgroundImage:`linear-gradient(rgba(${accentColor},0.06) 1px,transparent 1px),linear-gradient(90deg,rgba(${accentColor},0.06) 1px,transparent 1px)`, backgroundSize:"48px 48px" }} />
      {/* Scanlines */}
      <div className="absolute inset-0" style={{ backgroundImage:"repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.05) 3px,rgba(0,0,0,0.05) 4px)", pointerEvents:"none" }} />
      {/* Neon corner brackets */}
      {["top-0 left-0","top-0 right-0","bottom-0 left-0","bottom-0 right-0"].map((pos,i) => (
        <div key={i} className={`absolute ${pos} w-12 h-12`} style={{ border:`2px solid rgb(${accentColor})`, borderRight:i%2===0?"none":"2px solid", borderLeft:i%2===0?"2px solid":"none", borderBottom:i<2?"none":"2px solid", borderTop:i<2?"2px solid":"none", opacity:0.6 }} />
      ))}
      {/* Content */}
      <div className="relative z-10 flex h-full max-w-2xl mx-auto">
        {/* Left: album art column */}
        <div className="flex flex-col items-center justify-center p-8 gap-4" style={{ width: 280, borderRight: `2px solid rgba(${accentColor},0.2)` }}>
          <div style={{ width: 220, height: 220, position: "relative", border: `2px solid rgb(${accentColor})`, boxShadow:`0 0 30px rgb(${accentColor}), inset 0 0 30px rgba(${accentColor},0.1)`, overflow: "hidden" }}>
            {hasCover ? <img src={project.coverDataUrl!} alt={project.name} style={{ width:"100%", height:"100%", objectFit:"cover" }} /> : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", background:`rgba(${accentColor},0.05)` }}><Music size={60} style={{ color:`rgb(${accentColor})`, opacity:0.5 }} /></div>}
            {/* Scanline overlay on art */}
            <div className="absolute inset-0" style={{ backgroundImage:"repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.15) 2px,rgba(0,0,0,0.15) 3px)", pointerEvents:"none" }} />
          </div>
          <div style={{ fontSize:10, color:`rgb(${accentColor})`, letterSpacing:"0.2em", textTransform:"uppercase", textShadow:`0 0 8px rgb(${accentColor})` }}>
            {player.isPlaying ? "▶ PLAYING" : "■ PAUSED"}
          </div>
        </div>
        {/* Right: info + controls */}
        <div className="flex flex-col justify-center flex-1 p-8 gap-5">
          {/* Close */}
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontSize:9, color:`rgb(${accentColor})`, letterSpacing:"0.25em", textTransform:"uppercase", textShadow:`0 0 8px rgb(${accentColor})` }}>// NOW_PLAYING.EXE</span>
            <button onClick={onClose} style={{ fontSize:11, color:`rgb(${accentColor})`, border:`1px solid rgb(${accentColor})`, padding:"2px 8px", background:"transparent", cursor:"pointer", letterSpacing:"0.1em" }}>EXIT</button>
          </div>
          {/* Track info */}
          <div style={{ borderLeft:`3px solid rgb(${accentColor})`, paddingLeft:12 }}>
            <div style={{ fontSize:22, fontWeight:700, color:"#fff", letterSpacing:"-0.01em", textShadow:"0 0 20px rgba(255,255,255,0.3)", lineHeight:1.2 }}>{track.name}</div>
            <div style={{ fontSize:13, color:`rgb(${accentColor})`, marginTop:4, textShadow:`0 0 8px rgb(${accentColor})`, letterSpacing:"0.05em" }}>{project.artist || "UNKNOWN_ARTIST"}</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.3)", marginTop:2, letterSpacing:"0.08em" }}>{project.isSingle ? "[SINGLE]" : `[ALBUM: ${project.name.toUpperCase()}]`}</div>
          </div>
          {/* Neon progress */}
          <div>
            <div style={{ height:3, background:"rgba(255,255,255,0.08)", cursor:"pointer", position:"relative", boxShadow:`inset 0 0 4px rgba(${accentColor},0.2)` }}
              onClick={e => { const r=e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX-r.left)/r.width)*player.duration); }}>
              <div style={{ position:"absolute", left:0, top:0, bottom:0, width:`${progress*100}%`, background:`rgb(${accentColor})`, boxShadow:`0 0 12px rgb(${accentColor}), 0 0 24px rgba(${accentColor},0.5)` }}>
                <div style={{ position:"absolute", right:-4, top:"50%", transform:"translateY(-50%)", width:8, height:8, background:`rgb(${accentColor})`, boxShadow:`0 0 10px rgb(${accentColor})` }} />
              </div>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"rgba(255,255,255,0.4)", marginTop:4, letterSpacing:"0.08em" }}>
              <span>{fmt(player.currentTime)}</span><span>{fmt(player.duration)}</span>
            </div>
          </div>
          {/* Controls */}
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {[
              {icon:<Shuffle size={16}/>, action:onShuffle, active:player.shuffle, label:"SHFL"},
              {icon:<SkipBack size={18} fill="currentColor" strokeWidth={0}/>, action:onPrev, label:"PREV"},
              {icon:player.isPlaying?<Pause size={22} fill="currentColor" strokeWidth={0}/>:<Play size={22} fill="currentColor" strokeWidth={0}/>, action:onTogglePlay, label:player.isPlaying?"PAUS":"PLAY", big:true},
              {icon:<SkipForward size={18} fill="currentColor" strokeWidth={0}/>, action:onNext, label:"NEXT"},
            ].map((btn,i)=>(
              <button key={i} onClick={btn.action} style={{ flex:btn.big?2:1, padding:"10px 0", background:"transparent", border:`1px solid ${btn.active||btn.big?`rgb(${accentColor})`:`rgba(255,255,255,0.15)`}`, color:btn.active||btn.big?`rgb(${accentColor})`:"rgba(255,255,255,0.6)", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:3, boxShadow:btn.big||btn.active?`0 0 16px rgba(${accentColor},0.3)`:undefined, letterSpacing:"0.1em" }}>
                {btn.icon}
                <span style={{ fontSize:8, letterSpacing:"0.15em" }}>{btn.label}</span>
              </button>
            ))}
          </div>
          {/* Volume */}
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:9, color:`rgb(${accentColor})`, letterSpacing:"0.15em", minWidth:32 }}>VOL</span>
            <input type="range" min={0} max={1} step={0.01} value={player.volume} onChange={e=>onVolume(Number(e.target.value))} style={{ flex:1, accentColor:`rgb(${accentColor})` }} />
            <span style={{ fontSize:9, color:"rgba(255,255,255,0.4)", minWidth:28, textAlign:"right" }}>{Math.round(player.volume*100)}</span>
          </div>
          {toggleLike && <button onClick={()=>toggleLike(project.id,track.id)} style={{ alignSelf:"flex-start", padding:"4px 12px", background:"transparent", border:`1px solid ${liked?"#ff4444":"rgba(255,255,255,0.2)"}`, color:liked?"#ff4444":"rgba(255,255,255,0.4)", cursor:"pointer", fontSize:9, letterSpacing:"0.15em", display:"flex", alignItems:"center", gap:6, boxShadow:liked?"0 0 12px rgba(255,68,68,0.4)":undefined }}>
            <Heart size={11} fill={liked?"currentColor":"none"} strokeWidth={liked?0:1.5} />
            {liked?"LIKED":"LIKE"}
          </button>}
        </div>
      </div>
    </div>
  );
}

function FullscreenScrubber({
  current, total, onSeek,
}: { current: number; total: number; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = total > 0 ? Math.min(1, current / total) * 100 : 0;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = ref.current!.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * total);
  };

  return (
    <div ref={ref} className="group relative py-3 cursor-pointer" onClick={seek}>
      <div className="relative h-1 group-hover:h-1.5 bg-white/25 rounded-full transition-all duration-150">
        <div
          className="absolute inset-y-0 left-0 bg-white rounded-full"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function FullscreenPlayer({
  project, track, player,
  onTogglePlay, onSeek, onVolume, onPrev, onNext, onShuffle, onClose,
  toggleLike, isLiked, layoutTheme = "default" as LayoutTheme,
  fsBg, analyserRef,
}: {
  project: Project; track: Track; player: PlayerState;
  onTogglePlay: () => void; onSeek: (t: number) => void; onVolume: (v: number) => void;
  onPrev: () => void; onNext: () => void; onShuffle: () => void; onClose: () => void;
  toggleLike?: (pid: string, tid: string) => void;
  isLiked?: (pid: string, tid: string) => boolean;
  layoutTheme?: LayoutTheme;
  fsBg?: FsBgConfig;
  analyserRef?: React.MutableRefObject<AnalyserNode | null>;
}) {
  const [accentColor, setAccentColor] = useState("20,20,40");

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    if (project.coverDataUrl) {
      sampleCoverColor(project.coverDataUrl).then(setAccentColor);
    } else {
      setAccentColor("20,20,40");
    }
  }, [project.coverDataUrl]);

  const hasCover = !!project.coverDataUrl;
  const isGif = hasCover && project.coverDataUrl!.startsWith("data:image/gif");
  const liked = isLiked ? isLiked(project.id, track.id) : false;

  const sharedProps: FullscreenSharedProps = {
    project, track, player,
    onTogglePlay, onSeek, onVolume, onPrev, onNext, onShuffle, onClose,
    accentColor, liked,
    toggleLike, fsBg, analyserRef,
  };

  if (layoutTheme === "modern") return <FullscreenModern {...sharedProps} />;
  if (layoutTheme === "classic") return <FullscreenClassic {...sharedProps} />;
  if (layoutTheme === "unique") return <FullscreenUnique {...sharedProps} />;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col overflow-hidden">
      {/* ── Fully opaque background ── */}
      <div className="absolute inset-0 overflow-hidden">
        <FsBackground project={project} accentColor={accentColor} fsBg={sharedProps.fsBg} analyserRef={sharedProps.analyserRef} isPlaying={player.isPlaying} />
        {/* Apple Music-style darkening veil */}
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.55) 100%)" }} />
      </div>

      {/* ── Content ── */}
      <div className="relative z-10 flex flex-col h-full text-white max-w-xl mx-auto w-full px-8 pb-10">

        {/* Top bar — minimal grab handle + label */}
        <div className="flex items-center justify-between pt-5 pb-4">
          <button
            onClick={onClose}
            className="p-1.5 text-white/60 hover:text-white transition-colors"
            aria-label="Close fullscreen player"
          >
            <ChevronDown size={26} strokeWidth={2.5} />
          </button>
          <div className="absolute left-1/2 -translate-x-1/2 top-6 w-9 h-1 bg-white/25" />
          <div className="w-8" />
        </div>

        {/* Album art — large square, sharp corners */}
        <div className="flex-1 flex items-center justify-center py-2 min-h-0 relative">
          <div
            className="absolute rounded-full blur-3xl opacity-45 scale-110 pointer-events-none"
            style={{ background: `rgb(${accentColor})`, width: "62%", paddingTop: "62%", top: "8%", left: "19%" }}
          />
          <div
            className="relative aspect-square overflow-hidden rounded-xl transition-transform duration-500 ease-out"
            style={{
              width: "min(100%, 460px)",
              maxHeight: "100%",
              boxShadow: "0 30px 80px rgba(0,0,0,0.65), 0 10px 30px rgba(0,0,0,0.4)",
              transform: player.isPlaying ? "scale(1)" : "scale(0.86)",
            }}
          >
            {hasCover ? (
              <img src={project.coverDataUrl!} alt={project.name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-white/10 flex items-center justify-center">
                <Music size={80} className="text-white/30" />
              </div>
            )}
          </div>
        </div>


        {/* Track info + like — Apple Music alignment */}
        <div className="mt-8 mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[22px] font-bold truncate leading-tight tracking-tight">{track.name}</h2>
            <p className="text-white/65 text-[16px] font-medium mt-0.5 truncate">{project.artist || "Unknown Artist"}</p>
          </div>
          {toggleLike && (
            <button
              onClick={() => toggleLike(project.id, track.id)}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 ease-out hover:scale-110 active:scale-90 shrink-0 ${liked ? "text-red-400" : "text-white/70 hover:text-white"}`}
              style={{ background: "rgba(255,255,255,0.08)" }}
              aria-label={liked ? "Unlike" : "Like"}
            >
              <Heart size={17} fill={liked ? "currentColor" : "none"} strokeWidth={liked ? 0 : 2} />
            </button>
          )}

        </div>

        {/* Scrubber */}
        <div className="mb-6">
          <FullscreenScrubber
            current={player.currentTime}
            total={player.duration}
            onSeek={onSeek}
          />
          <div className="flex justify-between text-[11px] text-white/55 font-medium tabular-nums -mt-0.5">
            <span>{fmt(player.currentTime)}</span>
            <span>-{fmt(Math.max(0, player.duration - player.currentTime))}</span>
          </div>
        </div>

        {/* Main controls — big square play, prev/next flanking */}
        <div className="flex items-center justify-center gap-14 mb-8">
          <button
            onClick={onPrev}
            disabled={player.queuePos === 0 && !player.shuffle}
            className="w-14 h-14 flex items-center justify-center rounded-full text-white/90 hover:text-white hover:bg-white/10 transition-all duration-200 disabled:opacity-30 active:scale-90"
            aria-label="Previous"
          >
            <IconPrev size={40} />
          </button>
          <button
            onClick={onTogglePlay}
            className="w-14 h-14 flex items-center justify-center text-white active:scale-92 transition-transform"
            aria-label={player.isPlaying ? "Pause" : "Play"}
          >
            {player.isPlaying
              ? <Pause size={52} fill="currentColor" strokeWidth={0} />
              : <Play  size={52} fill="currentColor" strokeWidth={0} style={{ marginLeft: 3 }} />}
          </button>
          <button
            onClick={onNext}
            className="w-14 h-14 flex items-center justify-center rounded-full text-white/90 hover:text-white hover:bg-white/10 transition-all duration-200 active:scale-90"
            aria-label="Next"
          >
            <IconNext size={40} />
          </button>
        </div>

        {/* Volume */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onVolume(0)}
            className="text-white/55 hover:text-white transition-colors shrink-0"
            aria-label="Mute"
          >
            <VolumeX size={16} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={player.volume}
            onChange={e => onVolume(Number(e.target.value))}
            className="flex-1 cursor-pointer"
            style={{ accentColor: "rgba(255,255,255,0.9)" }}
          />
          <button
            onClick={() => onVolume(1)}
            className="text-white/85 hover:text-white transition-colors shrink-0"
            aria-label="Full volume"
          >
            <Volume2 size={16} />
          </button>
          <button onClick={onShuffle}
            className="ml-2 shrink-0 transition-colors"
            style={{ color: player.shuffle ? "#fff" : "rgba(255,255,255,0.45)" }}
            aria-label="Shuffle"
          >
            <Shuffle size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── NextUpPreview (sits above player, has 10s timer) ──────────────────────

function NextUpPreview({ player, projects, nextUpPreview, onDismiss, onSkip }: {
  player: PlayerState;
  projects: Project[];
  nextUpPreview: boolean;
  onDismiss: () => void;
  onSkip: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(10);

  const nextItem = player.queue[player.queuePos + 1];
  const nextProj = nextItem ? projects.find(p => p.id === nextItem.projectId) ?? null : null;
  const nextTrack = nextProj ? nextProj.tracks[nextItem!.trackIndex] ?? null : null;

  // Reset timer whenever popup appears
  useEffect(() => {
    if (!nextUpPreview) { setSecondsLeft(10); return; }
    setSecondsLeft(10);
    const interval = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { clearInterval(interval); onDismiss(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [nextUpPreview]);

  if (!nextUpPreview || !nextProj || !nextTrack) return null;

  const progress = (10 - secondsLeft) / 10; // 0→1 over 10s

  return (
    <AnimatePresence>
      <motion.div
        key="next-up-bar"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        style={{ display: "flex", justifyContent: "flex-end", paddingRight: 12, paddingBottom: 6, paddingTop: 4 }}
      >
      <div
        style={{
          width: 288,
          background: "var(--popover)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          overflow: "hidden",
          position: "relative",
          cursor: "pointer",
        }}
        onClick={onSkip}
        title="Click to skip to next song"
      >
        {/* Timer bar — drains right to left along bottom */}
        <div
          className="absolute bottom-0 left-0 h-0.5 bg-primary"
          style={{ width: `${(1 - progress) * 100}%`, transition: "width 1s linear" }}
        />

        <div className="flex items-center gap-3 px-3 py-2.5">
          {/* Cover */}
          <div className="w-8 h-8 shrink-0 rounded overflow-hidden bg-secondary border border-border">
            {nextProj.coverDataUrl
              ? <img src={nextProj.coverDataUrl} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center"><Music size={11} className="text-muted-foreground/30" /></div>}
          </div>

          {/* Labels */}
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold text-primary uppercase tracking-widest leading-none mb-0.5">Next Up · click to skip</p>
            <p className="text-sm font-semibold truncate leading-tight">{nextTrack.name}</p>
            <p className="text-xs text-muted-foreground truncate">{nextProj.artist || "Unknown"}</p>
          </div>

          {/* Countdown */}
          <div className="shrink-0 flex items-center justify-center" style={{ width: 28, height: 28, position: "relative" }}>
            <svg width={28} height={28} style={{ transform: "rotate(-90deg)", position: "absolute" }}>
              <circle cx={14} cy={14} r={11} fill="none" stroke="var(--border)" strokeWidth={2} />
              <circle
                cx={14} cy={14} r={11} fill="none"
                stroke="var(--primary)" strokeWidth={2}
                strokeDasharray={`${2 * Math.PI * 11}`}
                strokeDashoffset={`${2 * Math.PI * 11 * progress}`}
                style={{ transition: "stroke-dashoffset 1s linear" }}
              />
            </svg>
            <span className="text-[10px] font-bold text-primary tabular-nums" style={{ position: "relative", zIndex: 1 }}>{secondsLeft}</span>
          </div>

          <button
            onClick={e => { e.stopPropagation(); onDismiss(); }}
            className="shrink-0 p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      </motion.div>
    </AnimatePresence>
  );
}

// ── NextUpPanel ────────────────────────────────────────────────────────────

function NextUpPanel({ queue, queuePos, projects, onClose, onPlayAt, onRemove, layoutTheme }: {
  queue: QueueItem[];
  queuePos: number;
  projects: Project[];
  onClose: () => void;
  onPlayAt: (pos: number) => void;
  onRemove: (pos: number) => void;
  layoutTheme?: LayoutTheme;
}) {
  const upNext = queue.slice(queuePos + 1);
  const history = queue.slice(0, queuePos);
  const current = queue[queuePos];

  const resolveItem = (item: QueueItem) => {
    const proj = projects.find(p => p.id === item.projectId);
    const track = proj?.tracks[item.trackIndex];
    return proj && track ? { proj, track } : null;
  };

  const currentResolved = current ? resolveItem(current) : null;

  return (
    <div
      className="absolute right-0 top-0 bottom-0 z-50 flex flex-col border-l border-border shadow-2xl"
      style={
        layoutTheme === "classic"
          ? { width: 320, background: "linear-gradient(180deg, rgba(20,60,140,0.72) 0%, rgba(6,30,90,0.85) 100%)", backdropFilter: "blur(40px) saturate(200%)", WebkitBackdropFilter: "blur(40px) saturate(200%)", borderLeft: "1px solid rgba(200,235,255,0.4)", boxShadow: "inset 1px 0 0 rgba(255,255,255,0.15), -8px 0 32px rgba(0,20,60,0.6)" }
          : layoutTheme === "modern"
            ? { width: 320, background: "color-mix(in srgb, var(--popover) 45%, transparent)", backdropFilter: "blur(80px) saturate(220%)", WebkitBackdropFilter: "blur(80px) saturate(220%)", borderLeft: "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)" }
            : { width: 320, background: "var(--popover)", backdropFilter: "blur(40px)", WebkitBackdropFilter: "blur(40px)" }
      }
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0"
        style={
          layoutTheme === "modern" ? { background: "color-mix(in srgb, var(--foreground) 4%, transparent)", backdropFilter: "blur(24px)" }
          : layoutTheme === "classic" ? { background: "linear-gradient(180deg, rgba(160,220,255,0.35) 0%, rgba(30,110,220,0.45) 55%, rgba(10,70,180,0.55) 100%)", borderBottom: "1px solid rgba(200,235,255,0.4)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35)" }
          : layoutTheme === "unique" ? { borderBottom: "2px solid var(--primary)", background: "rgba(0,0,0,0.95)" }
          : {}
        }
      >
        <div>
          <h3 className="text-sm font-bold">Next Up</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{upNext.length} song{upNext.length !== 1 ? "s" : ""} in queue</p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {/* Now Playing */}
        {currentResolved && (
          <div className="px-5 py-3 border-b border-border">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">Now Playing</p>
            <div className="flex items-center gap-3 p-2.5 rounded-lg bg-primary/8 border border-primary/20">
              <div className="w-10 h-10 rounded-md overflow-hidden bg-secondary border border-border shrink-0">
                {currentResolved.proj.coverDataUrl
                  ? <img src={currentResolved.proj.coverDataUrl} alt="" className="w-full h-full object-cover" />
                  : <div className="w-full h-full flex items-center justify-center"><Music size={14} className="text-muted-foreground/30" /></div>}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate text-primary">{currentResolved.track.name}</p>
                <p className="text-xs text-muted-foreground truncate">{currentResolved.proj.artist || "Unknown"}</p>
              </div>
              <NowPlayingDots />
            </div>
          </div>
        )}

        {/* Up Next */}
        {upNext.length > 0 && (
          <div className="px-5 py-3">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">Up Next</p>
            <div className="space-y-1">
              {upNext.map((item, i) => {
                const resolved = resolveItem(item);
                if (!resolved) return null;
                const globalPos = queuePos + 1 + i;
                return (
                  <div
                    key={`next-${globalPos}`}
                    className="group flex items-center gap-3 p-2 rounded-lg hover:bg-secondary cursor-pointer transition-colors"
                    onClick={() => onPlayAt(globalPos)}
                  >
                    <div className="w-9 h-9 rounded-md overflow-hidden bg-secondary border border-border shrink-0">
                      {resolved.proj.coverDataUrl
                        ? <img src={resolved.proj.coverDataUrl} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center"><Music size={12} className="text-muted-foreground/30" /></div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">{resolved.track.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{resolved.proj.artist || "Unknown"}</p>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); onRemove(globalPos); }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-destructive transition-all"
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* History */}
        {history.length > 0 && (
          <div className="px-5 py-3 border-t border-border">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">History</p>
            <div className="space-y-1 opacity-40">
              {[...history].reverse().slice(0, 8).map((item, i) => {
                const resolved = resolveItem(item);
                if (!resolved) return null;
                const globalPos = queuePos - 1 - i;
                return (
                  <div
                    key={`hist-${globalPos}`}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-secondary cursor-pointer transition-colors hover:opacity-100"
                    onClick={() => onPlayAt(globalPos)}
                  >
                    <div className="w-8 h-8 rounded-md overflow-hidden bg-secondary border border-border shrink-0">
                      {resolved.proj.coverDataUrl
                        ? <img src={resolved.proj.coverDataUrl} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center"><Music size={11} className="text-muted-foreground/30" /></div>}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate">{resolved.track.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{resolved.proj.artist || "Unknown"}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {upNext.length === 0 && history.length === 0 && !currentResolved && (
          <div className="flex flex-col items-center justify-center h-40 gap-3 text-center px-6">
            <ListMusic size={32} className="text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground">Nothing queued yet</p>
            <p className="text-xs text-muted-foreground/60">Add songs to the queue from any track list</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── PlayerBar (theme-aware dispatcher) ────────────────────────────────────

interface PlayerBarProps {
  project: Project; track: Track; player: PlayerState;
  onTogglePlay: () => void; onSeek: (t: number) => void; onVolume: (v: number) => void;
  onPrev: () => void; onNext: () => void; onShuffle: () => void; onExpand: () => void;
  onToggleNextUp?: () => void; showNextUp?: boolean;
  nav: (hash: string) => void;
  layoutTheme?: LayoutTheme;
}

function PlayerBar(props: PlayerBarProps) {
  const { layoutTheme = "default" } = props;
  if (layoutTheme === "modern")  return <PlayerBarModern  {...props} />;
  if (layoutTheme === "classic") return <PlayerBarClassic {...props} />;
  if (layoutTheme === "unique")  return <PlayerBarUnique  {...props} />;
  return <PlayerBarDefault {...props} />;
}

// ── Default player bar ─────────────────────────────────────────────────────
function PlayerBarDefault({ project, track, player, onTogglePlay, onSeek, onVolume, onPrev, onNext, onShuffle, onExpand, onToggleNextUp, showNextUp, nav }: PlayerBarProps) {
  const progress = player.duration > 0 ? player.currentTime / player.duration : 0;
  return (
    <div
      className="shrink-0 relative"
      style={{
        background: "color-mix(in srgb, var(--popover) 78%, transparent)",
        backdropFilter: "blur(40px) saturate(180%)",
        WebkitBackdropFilter: "blur(40px) saturate(180%)",
        borderTop: "1px solid color-mix(in srgb, var(--foreground) 8%, transparent)",
        boxShadow: "0 -1px 0 color-mix(in srgb, var(--foreground) 4%, transparent), 0 -12px 40px rgba(0,0,0,0.15)",
      }}
    >
      <div className="px-4 py-2.5 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        {/* Left: album art + info */}
        <div className="flex items-center gap-3 min-w-0 cursor-pointer" onClick={() => nav(`/project/${project.id}`)}>
          <div
            className="w-12 h-12 shrink-0 overflow-hidden rounded-md bg-card transition-transform duration-300 ease-out hover:scale-[1.04]"
            style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.25), 0 0 0 1px color-mix(in srgb, var(--foreground) 8%, transparent)" }}
          >
            {project.coverDataUrl
              ? <img src={project.coverDataUrl} alt={track.name} className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center"><Music size={18} className="text-muted-foreground/40" /></div>}
          </div>

          <div className="min-w-0">
            <p className="text-[13px] font-semibold truncate leading-tight">{track.name}</p>
            <p className="text-[11.5px] text-muted-foreground truncate mt-0.5">{project.artist || "Unknown"}</p>
          </div>
        </div>

        {/* Center: playback + scrubber */}
        <div className="flex flex-col items-center gap-1.5 w-[440px] max-w-full">
          <div className="flex items-center gap-6">
            <button onClick={onPrev} disabled={player.queuePos===0&&!player.shuffle}
              className="w-10 h-10 flex items-center justify-center rounded-full text-foreground/85 hover:text-foreground hover:bg-foreground/10 transition-all duration-200 disabled:opacity-30 active:scale-95">
              <IconPrev size={24} />
            </button>
            <button
              onClick={onTogglePlay}
              className="w-9 h-9 flex items-center justify-center text-foreground hover:scale-105 active:scale-95 transition-transform"
              aria-label={player.isPlaying ? "Pause" : "Play"}
            >
              {player.isPlaying
                ? <Pause size={28} fill="currentColor" strokeWidth={0} />
                : <Play  size={28} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />}
            </button>
            <button onClick={onNext}
              className="w-10 h-10 flex items-center justify-center rounded-full text-foreground/85 hover:text-foreground hover:bg-foreground/10 transition-all duration-200 active:scale-95">
              <IconNext size={24} />
            </button>
          </div>
          <div className="flex items-center gap-2.5 w-full">
            <span className="text-[10.5px] text-muted-foreground tabular-nums w-9 text-right">{fmt(player.currentTime)}</span>
            <div
              className="flex-1 h-1 cursor-pointer relative group/bar rounded-full overflow-hidden"
              style={{ background: "color-mix(in srgb, var(--foreground) 15%, transparent)" }}
              onClick={e => { const r=e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX-r.left)/r.width)*player.duration); }}
            >
              <div className="h-full relative rounded-full transition-[width] duration-150 ease-out" style={{ width: `${progress*100}%`, background: "color-mix(in srgb, var(--foreground) 75%, transparent)" }}>
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-foreground opacity-0 group-hover/bar:opacity-100 transition-opacity" style={{ transform: "translate(50%,-50%)" }} />
              </div>
            </div>
            <span className="text-[10.5px] text-muted-foreground tabular-nums w-9">-{fmt(Math.max(0, player.duration - player.currentTime))}</span>

          </div>
        </div>

        {/* Right: shuffle / queue / volume / fullscreen */}
        <div className="flex items-center justify-end gap-3">
          <button onClick={onShuffle}
            className="transition-colors"
            style={{ color: player.shuffle ? "var(--primary)" : "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
            title="Shuffle">
            <Shuffle size={16} />
          </button>
          {onToggleNextUp && (
            <button
              onClick={onToggleNextUp}
              className="transition-colors"
              style={{ color: showNextUp ? "var(--primary)" : "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
              title="Playing Next"
            >
              <ListMusic size={16} />
            </button>
          )}
          <div className="flex items-center gap-2">
            <Volume2 size={14} style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }} />
            <div
              className="h-1 cursor-pointer relative group/vol rounded-full overflow-hidden"
              style={{ width: 88, background: "color-mix(in srgb, var(--foreground) 15%, transparent)" }}
              onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onVolume(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); }}
            >
              <div className="h-full relative rounded-full transition-[width] duration-150 ease-out" style={{ width: `${player.volume * 100}%`, background: "color-mix(in srgb, var(--foreground) 75%, transparent)" }}>
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-foreground opacity-0 group-hover/vol:opacity-100 transition-opacity" style={{ transform: "translate(50%,-50%)" }} />
              </div>
            </div>

          </div>
          <button onClick={onExpand}
            className="transition-colors"
            style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
            title="Fullscreen">
            <Maximize2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modern player bar (Liquid Glass) ──────────────────────────────────────
function PlayerBarModern({ project, track, player, onTogglePlay, onSeek, onVolume, onPrev, onNext, onShuffle, onExpand, onToggleNextUp, showNextUp, nav }: PlayerBarProps) {
  const progress = player.duration > 0 ? player.currentTime / player.duration : 0;
  const [showVol, setShowVol] = useState(false);
  const [scrubHover, setScrubHover] = useState(false);

  return (
    <div
      className="shrink-0 relative overflow-hidden"
      style={{
        background: "linear-gradient(180deg, rgba(14,14,22,0.72) 0%, rgba(6,6,14,0.86) 100%)",
        backdropFilter: "blur(80px) saturate(200%)",
        WebkitBackdropFilter: "blur(80px) saturate(200%)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 -1px 0 rgba(255,255,255,0.04) inset, 0 -12px 40px rgba(0,0,0,0.35)",
      }}
    >
      {/* Top hairline gradient progress */}
      <div
        className="absolute top-0 left-0 h-[2px] pointer-events-none"
        style={{
          width: `${progress * 100}%`,
          background: `linear-gradient(90deg, var(--primary) 0%, color-mix(in srgb, var(--primary) 60%, #fff) 100%)`,
          boxShadow: `0 0 10px var(--primary)`,
          transition: "width 120ms linear",
        }}
      />
      {/* Clickable full-width scrub strip at top */}
      <div
        className="absolute top-0 left-0 right-0 h-2 cursor-pointer z-10"
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * player.duration); }}
      />

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 py-2.5">
        {/* Left: art + info */}
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="relative shrink-0 cursor-pointer transition-transform duration-300 ease-out hover:scale-[1.05]"
            onClick={() => nav(`/project/${project.id}`)}
            style={{ width: 48, height: 48 }}
          >
            <div
              className="absolute inset-0 rounded-xl overflow-hidden"
              style={{
                border: "1px solid rgba(255,255,255,0.12)",
                boxShadow: "0 4px 12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)",
              }}
            >
              {project.coverDataUrl
                ? <img src={project.coverDataUrl} alt="" className="w-full h-full object-cover" />
                : <div className="w-full h-full flex items-center justify-center" style={{ background: "rgba(255,255,255,0.06)" }}>
                    <Music size={18} style={{ opacity: 0.4, color: "#fff" }} />
                  </div>}
            </div>
            {/* Ambient glow */}
            {project.coverDataUrl && (
              <div
                className="absolute inset-0 rounded-xl -z-10 blur-lg opacity-50 scale-110 pointer-events-none"
                style={{ backgroundImage: `url(${project.coverDataUrl})`, backgroundSize: "cover", backgroundPosition: "center" }}
              />
            )}
          </div>
          <div className="min-w-0 cursor-pointer" onClick={() => nav(`/project/${project.id}`)}>
            <p className="text-[13px] font-semibold truncate leading-tight text-white">{track.name}</p>
            <p className="text-[11.5px] truncate mt-0.5" style={{ color: "rgba(255,255,255,0.5)" }}>{project.artist || "Unknown"}</p>
          </div>
        </div>

        {/* Center: controls + scrubber */}
        <div className="flex flex-col items-center gap-1.5 w-[460px] max-w-full">
          <div className="flex items-center gap-4">
            <button
              onClick={onShuffle}
              className="transition-all duration-200 hover:scale-110 active:scale-90"
              style={{
                width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: 9999,
                background: player.shuffle ? "rgba(255,255,255,0.12)" : "transparent",
                color: player.shuffle ? "var(--primary)" : "rgba(255,255,255,0.45)",
                border: player.shuffle ? "1px solid rgba(255,255,255,0.14)" : "1px solid transparent",
              }}
              aria-label="Shuffle"
            >
              <Shuffle size={14} />
            </button>
            <button
              onClick={onPrev}
              disabled={player.queuePos === 0 && !player.shuffle}
              className="w-10 h-10 flex items-center justify-center rounded-full text-white/85 hover:text-white hover:bg-white/10 transition-all duration-200 hover:scale-110 active:scale-90 disabled:opacity-30"
              aria-label="Previous"
            >
              <IconPrev size={24} />
            </button>
            <button
              onClick={onTogglePlay}
              className="flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95"
              style={{
                width: 40, height: 40,
                borderRadius: 9999,
                background: "linear-gradient(180deg, #fff 0%, rgba(235,235,240,0.95) 100%)",
                color: "#000",
                boxShadow: "0 4px 14px rgba(0,0,0,0.45), 0 0 18px color-mix(in srgb, var(--primary) 30%, transparent), inset 0 1px 0 rgba(255,255,255,0.9)",
              }}
              aria-label={player.isPlaying ? "Pause" : "Play"}
            >
              {player.isPlaying
                ? <Pause size={17} fill="currentColor" strokeWidth={0} />
                : <Play  size={17} fill="currentColor" strokeWidth={0} style={{ marginLeft: 1 }} />}
            </button>
            <button
              onClick={onNext}
              className="w-10 h-10 flex items-center justify-center rounded-full text-white/85 hover:text-white hover:bg-white/10 transition-all duration-200 hover:scale-110 active:scale-90"
              aria-label="Next"
            >
              <IconNext size={24} />
            </button>
            {onToggleNextUp && (
              <button
                onClick={onToggleNextUp}
                className="transition-all duration-200 hover:scale-110 active:scale-90"
                style={{
                  width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
                  borderRadius: 9999,
                  background: showNextUp ? "rgba(255,255,255,0.12)" : "transparent",
                  color: showNextUp ? "var(--primary)" : "rgba(255,255,255,0.4)",
                  border: showNextUp ? "1px solid rgba(255,255,255,0.14)" : "1px solid transparent",
                }}
                aria-label="Playing next"
              >
                <ListMusic size={14} />
              </button>
            )}
          </div>
          {/* Scrubber */}
          <div className="flex items-center gap-2.5 w-full">
            <span className="text-[10.5px] tabular-nums w-9 text-right" style={{ color: "rgba(255,255,255,0.4)" }}>{fmt(player.currentTime)}</span>
            <div
              className="flex-1 cursor-pointer relative"
              style={{ height: scrubHover ? 6 : 3, transition: "height 180ms ease" }}
              onMouseEnter={() => setScrubHover(true)}
              onMouseLeave={() => setScrubHover(false)}
              onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * player.duration); }}
            >
              <div
                className="absolute inset-0 rounded-full"
                style={{ background: "rgba(255,255,255,0.14)" }}
              />
              <div
                className="absolute left-0 top-0 h-full rounded-full"
                style={{
                  width: `${progress * 100}%`,
                  background: `linear-gradient(90deg, #fff 0%, rgba(255,255,255,0.85) 100%)`,
                  boxShadow: "0 0 8px rgba(255,255,255,0.35)",
                  transition: "width 120ms linear",
                }}
              >
                <div
                  className="absolute right-0 top-1/2 rounded-full bg-white"
                  style={{
                    width: scrubHover ? 12 : 0, height: scrubHover ? 12 : 0,
                    transform: "translate(50%,-50%)",
                    boxShadow: "0 0 8px rgba(255,255,255,0.7), 0 2px 6px rgba(0,0,0,0.4)",
                    transition: "width 180ms ease, height 180ms ease",
                  }}
                />
              </div>
            </div>
            <span className="text-[10.5px] tabular-nums w-9" style={{ color: "rgba(255,255,255,0.4)" }}>-{fmt(Math.max(0, player.duration - player.currentTime))}</span>
          </div>
        </div>

        {/* Right: volume + expand */}
        <div className="flex items-center justify-end gap-2">
          <div
            className="flex items-center gap-2 transition-all duration-300"
            onMouseEnter={() => setShowVol(true)}
            onMouseLeave={() => setShowVol(false)}
          >
            <button
              onClick={() => onVolume(player.volume === 0 ? 1 : 0)}
              className="transition-all duration-200 hover:scale-110 active:scale-90"
              style={{
                width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: 9999,
                color: "rgba(255,255,255,0.55)",
              }}
              aria-label="Toggle mute"
            >
              {player.volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <div
              className="overflow-hidden"
              style={{
                width: showVol ? 92 : 0,
                transition: "width 260ms cubic-bezier(0.22,1,0.36,1)",
              }}
            >
              <div
                className="h-1 rounded-full cursor-pointer relative"
                style={{ background: "rgba(255,255,255,0.14)" }}
                onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onVolume(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); }}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${player.volume * 100}%`, background: "linear-gradient(90deg,#fff,rgba(255,255,255,0.85))" }}
                />
              </div>
            </div>
          </div>
          <button
            onClick={onExpand}
            className="transition-all duration-200 hover:scale-110 active:scale-90"
            style={{
              width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 9999,
              color: "rgba(255,255,255,0.5)",
            }}
            aria-label="Fullscreen"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Classic player bar (2000s WinAMP / WMP style) ─────────────────────────
// ── Classic player bar: Windows XP + PS3 XMB style ───────────────────────
function PlayerBarClassic({ project, track, player, onTogglePlay, onSeek, onVolume, onPrev, onNext, onShuffle, onExpand, onToggleNextUp, showNextUp, nav }: PlayerBarProps) {
  const progress = player.duration > 0 ? player.currentTime / player.duration : 0;
  const CYAN = "#00c8ff", BLUE = "#1e8fef";

  // Aero glossy pill button
  const AeroBtn = ({ onClick, children, active, disabled, size = 30, primary }: { onClick?:()=>void; children:React.ReactNode; active?:boolean; disabled?:boolean; size?:number; primary?:boolean }) => (
    <button onClick={onClick} disabled={disabled} style={{
      width: size, height: size,
      borderRadius: size / 2,
      background: primary
        ? `radial-gradient(circle at 50% 22%, rgba(255,255,255,0.85) 0%, rgba(180,235,255,0.9) 18%, ${CYAN} 45%, ${BLUE} 70%, #0b5cb8 100%)`
        : active
          ? `linear-gradient(180deg, rgba(180,235,255,0.9) 0%, ${CYAN} 45%, ${BLUE} 100%)`
          : `linear-gradient(180deg, rgba(220,240,255,0.55) 0%, rgba(140,190,240,0.30) 48%, rgba(60,120,200,0.30) 50%, rgba(30,90,180,0.40) 100%)`,
      border: `1px solid ${primary || active ? "rgba(0,60,140,0.85)" : "rgba(180,225,255,0.55)"}`,
      boxShadow: primary
        ? `inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -3px 6px rgba(0,40,100,0.5), 0 0 14px rgba(0,180,255,0.7), 0 3px 8px rgba(0,40,120,0.6)`
        : active
          ? `inset 0 1px 0 rgba(255,255,255,0.7), 0 0 10px rgba(0,180,255,0.55), 0 2px 5px rgba(0,40,120,0.5)`
          : `inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -1px 0 rgba(0,20,60,0.3), 0 1px 3px rgba(0,20,60,0.4)`,
      color: primary || active ? "#fff" : "rgba(230,244,255,0.92)",
      cursor: disabled ? "default" : "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      opacity: disabled ? 0.35 : 1,
      position: "relative", overflow: "hidden",
      transition: "filter 0.12s ease, transform 0.1s ease, box-shadow 0.2s ease",
    }}
    onMouseEnter={e => { if (!disabled) e.currentTarget.style.filter = "brightness(1.15) saturate(1.1)"; }}
    onMouseLeave={e => { e.currentTarget.style.filter = "brightness(1)"; }}
    >
      {/* Glossy top sheen */}
      <span style={{ position: "absolute", top: 1, left: 1, right: 1, height: "48%", borderRadius: `${size/2}px ${size/2}px 50% 50% / ${size/2}px ${size/2}px 100% 100%`, background: "linear-gradient(180deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.08) 100%)", pointerEvents: "none" }} />
      <span style={{ position: "relative", display: "flex", filter: `drop-shadow(0 1px 0 rgba(0,30,80,0.5))` }}>{children}</span>
    </button>
  );

  return (
    <div style={{
      position: "relative",
      background: "linear-gradient(180deg, rgba(30,90,170,0.55) 0%, rgba(10,50,130,0.75) 55%, rgba(4,25,80,0.90) 100%)",
      backdropFilter: "blur(32px) saturate(200%)",
      WebkitBackdropFilter: "blur(32px) saturate(200%)",
      borderTop: `1px solid rgba(200,235,255,0.55)`,
      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.4), 0 -8px 32px rgba(0,20,60,0.6), 0 -1px 0 rgba(0,180,255,0.3)`,
      fontFamily: "'Segoe UI',Tahoma,system-ui,sans-serif",
      overflow: "hidden",
    }}>
      {/* Top cyan glow line */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, transparent 0%, ${CYAN} 25%, ${CYAN} 75%, transparent 100%)`, boxShadow: `0 0 6px ${CYAN}`, opacity: 0.75 }} />
      {/* Sheen band */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "42%", background: "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.04) 100%)", pointerEvents: "none" }} />

      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "9px 14px" }}>
        {/* Album art — glass frame */}
        <div style={{
          width: 46, height: 46, flexShrink: 0,
          borderRadius: 8,
          border: "1px solid rgba(200,235,255,0.55)",
          overflow: "hidden", cursor: "pointer",
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.4), 0 0 12px rgba(0,180,255,0.35), 0 2px 6px rgba(0,20,60,0.6)`,
          position: "relative",
        }} onClick={() => nav(`/project/${project.id}`)}>
          {project.coverDataUrl
            ? <img src={project.coverDataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(180deg,#1a5fbe 0%,#082d70 100%)" }}><Music size={18} style={{ color: "#c8ecff", opacity: 0.85 }} /></div>}
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "45%", background: "linear-gradient(180deg, rgba(255,255,255,0.28) 0%, transparent 100%)", pointerEvents: "none" }} />
        </div>

        {/* Track info */}
        <div style={{ minWidth: 0, flex: "0 0 200px", cursor: "pointer" }} onClick={() => nav(`/project/${project.id}`)}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#f0f8ff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textShadow: "0 1px 2px rgba(0,20,60,0.5)" }}>{track.name}</div>
          <div style={{ fontSize: 11, color: "#a8dcff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "0.02em" }}>{project.artist || "Unknown"}</div>
        </div>

        {/* Progress — Aero glass trough */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div style={{
            height: 12, borderRadius: 6,
            background: "linear-gradient(180deg, rgba(0,10,40,0.75) 0%, rgba(0,20,60,0.55) 100%)",
            border: "1px solid rgba(180,225,255,0.35)",
            boxShadow: "inset 0 2px 4px rgba(0,10,40,0.55), inset 0 -1px 0 rgba(255,255,255,0.08)",
            cursor: "pointer", position: "relative", overflow: "hidden",
          }} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * player.duration); }}>
            <div style={{
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${progress * 100}%`,
              background: `linear-gradient(180deg, rgba(200,240,255,0.95) 0%, ${CYAN} 45%, ${BLUE} 100%)`,
              boxShadow: `0 0 10px ${CYAN}, inset 0 1px 0 rgba(255,255,255,0.65)`,
              transition: "width 0.1s linear",
              borderRadius: 6,
            }}>
              <div style={{ position: "absolute", top: 1, left: 1, right: 1, height: "45%", background: "linear-gradient(180deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.05) 100%)", borderRadius: "5px 5px 50% 50% / 5px 5px 100% 100%" }} />
              <div style={{ position: "absolute", right: -5, top: "50%", transform: "translateY(-50%)", width: 10, height: 10, borderRadius: "50%", background: `radial-gradient(circle at 40% 30%, #fff 0%, ${CYAN} 55%, ${BLUE} 100%)`, boxShadow: `0 0 8px ${CYAN}, 0 1px 2px rgba(0,20,60,0.5)`, border: "1px solid rgba(255,255,255,0.7)" }} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, letterSpacing: "0.05em", fontVariantNumeric: "tabular-nums" }}>
            <span style={{ color: "#a8dcff" }}>{fmt(player.currentTime)}</span>
            <span style={{ color: "rgba(200,225,255,0.55)" }}>{fmt(player.duration)}</span>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", gap: 5, alignItems: "center", flexShrink: 0 }}>
          <AeroBtn onClick={onShuffle} active={player.shuffle} size={26}><Shuffle size={12} /></AeroBtn>
          <AeroBtn onClick={onPrev} disabled={player.queuePos === 0 && !player.shuffle} size={30}><SkipBack size={15} fill="currentColor" strokeWidth={0} /></AeroBtn>
          <AeroBtn onClick={onTogglePlay} primary size={40}>
            {player.isPlaying ? <Pause size={18} fill="currentColor" strokeWidth={0} /> : <Play size={18} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />}
          </AeroBtn>
          <AeroBtn onClick={onNext} size={30}><SkipForward size={15} fill="currentColor" strokeWidth={0} /></AeroBtn>
          {onToggleNextUp && <AeroBtn onClick={onToggleNextUp} active={showNextUp} size={26}><ListMusic size={12} /></AeroBtn>}
          <AeroBtn onClick={onExpand} size={26}><Maximize2 size={11} /></AeroBtn>
        </div>

        {/* Volume */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, paddingLeft: 10, borderLeft: "1px solid rgba(180,225,255,0.25)" }}>
          <Volume2 size={13} style={{ color: "#a8dcff" }} />
          <input type="range" min={0} max={1} step={0.01} value={player.volume} onChange={e => onVolume(Number(e.target.value))} style={{ width: 64, accentColor: CYAN, cursor: "pointer" }} />
        </div>
      </div>
    </div>
  );
}


// ── Unique player bar (Synthwave/Cyber) ────────────────────────────────────
function PlayerBarUnique({ project, track, player, onTogglePlay, onSeek, onVolume, onPrev, onNext, onShuffle, onExpand, onToggleNextUp, showNextUp, nav }: PlayerBarProps) {
  const progress = player.duration > 0 ? player.currentTime / player.duration : 0;

  return (
    <div style={{ background:"rgba(0,0,0,0.97)", borderTop:"2px solid var(--primary)", boxShadow:`0 -4px 32px color-mix(in srgb,var(--primary) 20%,transparent)`, fontFamily:"'SF Mono','Fira Code',monospace" }}>
      {/* Neon progress bar */}
      <div style={{ height:2, background:"rgba(255,255,255,0.06)", cursor:"pointer", position:"relative" }}
        onClick={e=>{const r=e.currentTarget.getBoundingClientRect();onSeek(((e.clientX-r.left)/r.width)*player.duration);}}>
        <div style={{ position:"absolute", left:0, top:0, bottom:0, width:`${progress*100}%`, background:`var(--primary)`, boxShadow:`0 0 12px var(--primary), 0 0 4px var(--primary)`, transition:"width 0.1s linear" }}>
          <div style={{ position:"absolute", right:-2, top:"50%", transform:"translateY(-50%)", width:5, height:5, background:"var(--primary)", boxShadow:`0 0 8px var(--primary)` }} />
        </div>
      </div>

      <div style={{ padding:"6px 12px", display:"flex", alignItems:"center", gap:8 }}>
        {/* Cover + track info */}
        <div style={{ display:"flex", alignItems:"center", gap:8, minWidth:0, flex:1, cursor:"pointer" }} onClick={()=>nav(`/project/${project.id}`)}>
          <div style={{ width:36, height:36, flexShrink:0, border:`2px solid var(--primary)`, boxShadow:`0 0 10px var(--primary)`, overflow:"hidden" }}>
            {project.coverDataUrl ? <img src={project.coverDataUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.5)"}}><Music size={14} style={{color:"var(--primary)"}}/></div>}
          </div>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", letterSpacing:"0.02em" }}>{track.name.toUpperCase()}</div>
            <div style={{ fontSize:10, color:"var(--primary)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textShadow:`0 0 8px var(--primary)`, letterSpacing:"0.06em" }}>{(project.artist||"UNKNOWN_ARTIST").toUpperCase()}</div>
          </div>
        </div>

        {/* Time */}
        <div style={{ fontSize:10, color:"rgba(255,255,255,0.35)", textAlign:"center", fontVariantNumeric:"tabular-nums", letterSpacing:"0.05em", flexShrink:0 }}>
          <div style={{ color:"var(--primary)", textShadow:`0 0 6px var(--primary)` }}>{fmt(player.currentTime)}</div>
          <div>{fmt(player.duration)}</div>
        </div>

        {/* Controls — neon square buttons */}
        <div style={{ display:"flex", gap:4, alignItems:"center", flexShrink:0 }}>
          {[
            {icon:<Shuffle size={13}/>, action:onShuffle, active:player.shuffle},
            {icon:<SkipBack size={15} fill="currentColor" strokeWidth={0}/>, action:onPrev, disabled:player.queuePos===0&&!player.shuffle},
            {icon:player.isPlaying?<Pause size={18} fill="currentColor" strokeWidth={0}/>:<Play size={18} fill="currentColor" strokeWidth={0}/>, action:onTogglePlay, big:true},
            {icon:<SkipForward size={15} fill="currentColor" strokeWidth={0}/>, action:onNext},
            ...(onToggleNextUp ? [{icon:<ListMusic size={11}/>, action:onToggleNextUp, active:showNextUp}] : []),
            {icon:<Maximize2 size={11}/>, action:onExpand},
          ].map((b,i)=>(
            <button key={i} onClick={b.action} disabled={b.disabled} style={{ width:b.big?38:28, height:b.big?28:22, background:"transparent", border:`1px solid ${b.active||b.big?`var(--primary)`:"rgba(255,255,255,0.15)"}`, color:b.active||b.big?`var(--primary)`:"rgba(255,255,255,0.55)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:b.big||b.active?`0 0 10px color-mix(in srgb,var(--primary) 40%,transparent)`:undefined, opacity:b.disabled?0.3:1, letterSpacing:"0.05em", fontSize:9, fontFamily:"inherit", transition:"all 0.15s" }}>
              {b.icon}
            </button>
          ))}
        </div>

        {/* Volume neon */}
        <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0, borderLeft:"1px solid rgba(255,255,255,0.1)", paddingLeft:8 }}>
          <span style={{ fontSize:9, color:"var(--primary)", textShadow:`0 0 6px var(--primary)`, letterSpacing:"0.15em" }}>VOL</span>
          <input type="range" min={0} max={1} step={0.01} value={player.volume} onChange={e=>onVolume(Number(e.target.value))} style={{ width:60, accentColor:"var(--primary)", cursor:"pointer" }} />
          <span style={{ fontSize:9, color:"rgba(255,255,255,0.35)", fontVariantNumeric:"tabular-nums" }}>{Math.round(player.volume*100)}</span>
        </div>
      </div>
    </div>
  );
}

// ── NewItemModal ───────────────────────────────────────────────────────────

function CoverPicker({ value, onChange }: { value: string | null; onChange: (url: string) => void }) {
  return (
    <label className="group relative flex flex-col items-center justify-center w-32 h-32 shrink-0 rounded-lg border-2 border-dashed border-border hover:border-primary/50 cursor-pointer overflow-hidden transition-all bg-secondary">
      {value ? (
        <>
          <img src={value} alt="Cover" className="w-full h-full object-cover absolute inset-0" />
          <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <ImagePlus size={18} className="text-white" />
            <span className="text-white text-[11px] font-semibold">Change</span>
          </div>
        </>
      ) : (
        <>
          <ImagePlus size={22} className="text-muted-foreground/50 mb-1.5 group-hover:text-primary/60 transition-colors" />
          <span className="text-xs text-muted-foreground font-medium group-hover:text-foreground transition-colors">Add Cover</span>
        </>
      )}
      <input type="file" accept="image/*,image/gif" className="hidden" onChange={async e => {
        if (e.target.files?.[0]) { const url = await processCover(e.target.files[0]); if (url) onChange(url); }
      }} />
    </label>
  );
}

function NewItemModal({
  onClose,
  onCreateAlbum,
  onCreateSingle,
}: {
  onClose: () => void;
  onCreateAlbum: (p: Project) => void;
  onCreateSingle: (p: Project) => void;
}) {
  const [step, setStep] = useState<"pick" | "album" | "single">("pick");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="animate-slide-in-up relative z-10 w-full max-w-md bg-popover border border-border rounded-lg shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          {step !== "pick" ? (
            <button
              onClick={() => setStep("pick")}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm font-semibold transition-colors"
            >
              <ChevronLeft size={16} />
              Back
            </button>
          ) : (
            <h2 className="text-xl font-bold">New Project</h2>
          )}
          <button onClick={onClose} className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
            <X size={17} />
          </button>
        </div>

        {/* Type picker */}
        {step === "pick" && (
          <div className="px-6 pb-6">
            <p className="text-sm text-muted-foreground mb-5">What are you creating?</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setStep("album")}
                className="group flex flex-col items-start gap-3 p-5 rounded-lg border-2 border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left"
              >
                <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center group-hover:bg-primary/15 transition-colors">
                  <Library size={20} className="text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div>
                  <p className="font-bold text-sm mb-0.5">Album</p>
                  <p className="text-xs text-muted-foreground leading-snug">Multiple tracks, shareable, appears in Home</p>
                </div>
              </button>
              <button
                onClick={() => setStep("single")}
                className="group flex flex-col items-start gap-3 p-5 rounded-lg border-2 border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left"
              >
                <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center group-hover:bg-primary/15 transition-colors">
                  <Music size={20} className="text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div>
                  <p className="font-bold text-sm mb-0.5">Single</p>
                  <p className="text-xs text-muted-foreground leading-snug">One song, appears in Library</p>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Album form */}
        {step === "album" && (
          <AlbumForm onClose={onClose} onCreate={onCreateAlbum} />
        )}

        {/* Single form */}
        {step === "single" && (
          <SingleForm onClose={onClose} onCreate={onCreateSingle} />
        )}
      </div>
    </div>
  );
}

function AlbumForm({ onClose, onCreate }: { onClose: () => void; onCreate: (p: Project) => void }) {
  const [name, setName] = useState("");
  const [artist, setArtist] = useState("");
  const [cover, setCover] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(true);

  const submit = () => {
    if (!name.trim()) return;
    onCreate({ id: genId(), name: name.trim(), artist: artist.trim(), coverDataUrl: cover, tracks: [], createdAt: Date.now(), isPublic });
  };

  return (
    <div className="px-6 pb-6">
      <p className="text-xs font-bold text-primary uppercase tracking-widest mb-5">New Album</p>
      <div className="flex gap-4 mb-5">
        <CoverPicker value={cover} onChange={setCover} />
        <div className="flex-1 space-y-3">
          <div>
            <label className="block text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1.5">Album Name</label>
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && name.trim()) submit(); }}
              placeholder="Album title"
              className="w-full bg-secondary border border-border rounded-md px-3 py-2.5 text-sm font-semibold outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1.5">Artist</label>
            <input
              value={artist}
              onChange={e => setArtist(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && name.trim()) submit(); }}
              placeholder="Artist name"
              className="w-full bg-secondary border border-border rounded-md px-3 py-2.5 text-sm font-medium outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
            />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-semibold text-muted-foreground">Visibility</span>
        <VisibilityToggle isPublic={isPublic} onChange={setIsPublic} />
      </div>
      <button
        onClick={submit}
        disabled={!name.trim()}
        className="w-full bg-primary text-white py-3.5 rounded-md font-bold text-sm hover:bg-primary/85 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-primary/20"
      >
        Create Album
      </button>
    </div>
  );
}

function SingleForm({ onClose, onCreate }: { onClose: () => void; onCreate: (p: Project) => void }) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [cover, setCover] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isPublic, setIsPublic] = useState(true);

  const canSubmit = title.trim() && audioFile && !uploading;

  const submit = async () => {
    if (!canSubmit || !audioFile) return;
    setUploading(true);
    const id = genId();
    const audioKey = `audio_${id}`;
    await dbPut(audioKey, audioFile);
    const duration = await getAudioDuration(audioFile);
    onCreate({
      id,
      name: title.trim(),
      artist: artist.trim(),
      coverDataUrl: cover,
      isSingle: true,
      isPublic,
      tracks: [{ id: genId(), name: title.trim(), audioKey, duration }],
      createdAt: Date.now(),
    });
    setUploading(false);
  };

  return (
    <div className="px-6 pb-6">
      <p className="text-xs font-bold text-primary uppercase tracking-widest mb-5">New Single</p>

      {/* Cover + title/artist */}
      <div className="flex gap-4 mb-4">
        <CoverPicker value={cover} onChange={setCover} />
        <div className="flex-1 space-y-3">
          <div>
            <label className="block text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1.5">Title</label>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Song title"
              className="w-full bg-secondary border border-border rounded-md px-3 py-2.5 text-sm font-semibold outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1.5">Artist</label>
            <input
              value={artist}
              onChange={e => setArtist(e.target.value)}
              placeholder="Artist name"
              className="w-full bg-secondary border border-border rounded-md px-3 py-2.5 text-sm font-medium outline-none focus:border-primary transition-colors placeholder:text-muted-foreground/50"
            />
          </div>
        </div>
      </div>

      {/* Audio file */}
      <div className="mb-5">
        <label className="block text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1.5">Audio File</label>
        <label className={`flex items-center gap-3 px-4 py-3.5 rounded-lg border-2 cursor-pointer transition-all ${audioFile ? "border-primary/40 bg-primary/5" : "border-dashed border-border hover:border-primary/40 hover:bg-card"}`}>
          <div className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${audioFile ? "bg-primary/15" : "bg-secondary"}`}>
            <Music size={16} className={audioFile ? "text-primary" : "text-muted-foreground/50"} />
          </div>
          <div className="flex-1 min-w-0">
            {audioFile ? (
              <>
                <p className="text-sm font-semibold truncate">{audioFile.name}</p>
                <p className="text-xs text-muted-foreground">{(audioFile.size / 1024 / 1024).toFixed(1)} MB</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-muted-foreground">Choose audio file</p>
                <p className="text-xs text-muted-foreground/60">MP3, WAV, FLAC, AAC and more</p>
              </>
            )}
          </div>
          {audioFile && (
            <button
              onClick={e => { e.preventDefault(); e.stopPropagation(); setAudioFile(null); }}
              className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <X size={13} />
            </button>
          )}
          <input
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.flac,.aac,.m4a"
            className="hidden"
            onChange={e => { if (e.target.files?.[0]) setAudioFile(e.target.files[0]); }}
          />
        </label>
      </div>

      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-semibold text-muted-foreground">Visibility</span>
        <VisibilityToggle isPublic={isPublic} onChange={setIsPublic} />
      </div>
      <button
        onClick={submit}
        disabled={!canSubmit}
        className="w-full bg-primary text-white py-3.5 rounded-md font-bold text-sm hover:bg-primary/85 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-primary/20"
      >
        {uploading ? "Uploading…" : "Add to Library"}
      </button>
    </div>
  );
}
