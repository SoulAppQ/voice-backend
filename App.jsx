import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import UpdateNotification from './UpdateNotification';
import { createPortal } from 'react-dom';
import io from 'socket.io-client';
import {
  LiveKitRoom,
  useParticipants,
  useLocalParticipant,
  useRoomContext,
  useTracks,
  VideoTrack,
} from '@livekit/components-react';
import { Track, RoomEvent } from 'livekit-client';
import '@livekit/components-styles';
import { useKrispNoiseFilter } from '@livekit/components-react/krisp';
import twemoji from '@twemoji/api';
import CollaborativePlayer from './CollaborativePlayer';
import customDiscIcon from './disc-icon.png';
// Directly import your custom icon from the electron folder
import appIcon from '../electron/icon.ico';

import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseWasmSimdPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

import { NoiseGateWorkletNode } from '@sapphi-red/web-noise-suppressor';
import noiseGateWorkletPath from '@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url';
import SpatialRoom from './SpatialRoom';
import AudioMixer from './AudioMixer';

const API_BASE = import.meta.env.VITE_API_BASE || "https://soul-imw6.onrender.com";
const serverUrl = 'wss://riso-cyzepc7b.livekit.cloud';
const socket = io.connect(API_BASE);

const createReverbImpulse = (ctx, duration, decay) => {
  const length = ctx.sampleRate * duration;
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return impulse;
};

// ---- Visual tokens --------------------------------------------------------
// "Nocturnal jazz club" identity: deep ink-blue rather than a true/zinc black,
// a neon plum marquee color as the primary accent, and a warm brass/gold as
// the secondary accent reserved for "live" states and highlights. Speaking
// participants get a stage-spotlight glow (see the speaking-ring style
// further down) instead of a plain colored ring — that's the one motif that
// repeats everywhere someone is live, and is meant to be Soul's signature.
const colors = {
  bg: '#0d0f1a',           // deep ink-blue, not true black
  panel: '#14172a',        // ink-navy panel
  panelAlt: '#1b1e37',     // one step up, for hover/active surfaces
  stage: '#050611',        // near-black for the video/voice stage
  border: '#262a45',       // muted indigo line, like brass trim in shadow
  borderSoft: 'rgba(204, 75, 194, 0.08)',
  text: '#f1edf7',         // pale cool lavender-white
  textMuted: '#9a94b8',    // dusty periwinkle-grey
  textFaint: '#5a5578',    // deep muted violet-grey
  brand: '#cc4bc2',        // neon plum/magenta — the marquee color
  brandDim: 'rgba(204, 75, 194, 0.16)',
  speak: '#e0a6da',        // pale magenta for the spotlight glow
  online: '#7ee787',
  danger: '#ef4b6b',       // rose-red, warmer than a stock red
  gold: '#d4a24c',         // brass/gold — reserved for "live" tags + highlights
  goldDim: 'rgba(212, 162, 76, 0.16)',
};

const avatarPalette = ['#cc4bc2', '#d4a24c', '#5aa9e6', '#7ee787', '#e0a6da', '#8f7fd6'];
const fontDisplay = "'Space Grotesk', sans-serif";
const fontBody = "'Manrope', sans-serif";
const fontMono = "'Space Mono', monospace";

function WindowControls() {
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.windowControls;
  if (!isElectron) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '100%', WebkitAppRegion: 'no-drag' }}>
      <button
        onClick={() => window.electronAPI.windowControls.minimize()}
        title="Minimize"
        style={{
          width: '42px', height: '100%', border: 'none', background: 'transparent',
          color: colors.textMuted, cursor: 'pointer', display: 'flex', alignItems: 'center',
          justifyContent: 'center', transition: 'background-color 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = colors.panelAlt; e.currentTarget.style.color = colors.text; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}
      >
        <svg width="11" height="1" viewBox="0 0 11 1" fill="currentColor">
          <rect width="11" height="1" />
        </svg>
      </button>

      <button
        onClick={() => window.electronAPI.windowControls.maximize()}
        title="Maximize"
        style={{
          width: '42px', height: '100%', border: 'none', background: 'transparent',
          color: colors.textMuted, cursor: 'pointer', display: 'flex', alignItems: 'center',
          justifyContent: 'center', transition: 'background-color 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = colors.panelAlt; e.currentTarget.style.color = colors.text; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
          <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
        </svg>
      </button>

      <button
        onClick={() => window.electronAPI.windowControls.close()}
        title="Close"
        style={{
          width: '46px', height: '100%', border: 'none', background: 'transparent',
          color: colors.textMuted, cursor: 'pointer', display: 'flex', alignItems: 'center',
          justifyContent: 'center', transition: 'background-color 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = colors.danger; e.currentTarget.style.color = '#ffffff'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}
      >
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2">
          <line x1="1" y1="1" x2="10" y2="10" />
          <line x1="10" y1="1" x2="1" y2="10" />
        </svg>
      </button>
    </div>
  );
}

function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return avatarPalette[Math.abs(hash) % avatarPalette.length];
}

function initialsForName(name) {
  return (name || '').trim().slice(0, 2).toUpperCase() || '?';
}

function formatMsgTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---- API helper: attaches the JWT, throws with the server's error msg ---
function useApi(authToken) {
  return async (path, options = {}) => {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status} ${res.statusText}).`);
    return data;
  };
}

// ---- Icon set -------------------------------------------------------------
const Icon = {
  Mic: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>),
  MicOff: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /><line x1="2" y1="2" x2="22" y2="22" /></svg>),
  Camera: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>),
  CameraOff: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /><line x1="2" y1="2" x2="22" y2="22" /></svg>),
  Monitor: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>),
  PhoneOff: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1-1a2 2 0 0 1 2.11-.45 12.7 12.7 0 0 0 2.81.7A2 2 0 0 1 22 17v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.94.36 1.87.7 2.81a2 2 0 0 1-.45 2.11l-1 1" /><line x1="23" y1="1" x2="1" y2="23" /></svg>),
  Settings: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>),
  Send: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>),
  Volume: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>),
  X: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>),
  Image: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>),
  Search: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>),
  Plus: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>),
  Users: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>),
  Back: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 5" /></svg>),
  Trash: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>),
  Headphones: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>),
  Expand: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>),
  Shrink: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>),
  Check: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>),
  Layers: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>),
  User: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>),
  Lock: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>),
  Eye: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>),
  EyeOff: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.6 18.6 0 0 1 4.22-5.44M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>),
  ArrowRight: (p) => (<svg width={p.size || 15} height={p.size || 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>),
  HeadphonesOff: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 15.36-6.36" /><path d="M21 15.28V12a9 9 0 0 0-.31-2.33" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /><line x1="1" y1="1" x2="23" y2="23" /></svg>),
  Clock: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>),
  Shield: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>),
  CloudRain: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 19v1"/><path d="M8 14v1"/><path d="M16 19v1"/><path d="M16 14v1"/><path d="M12 21v1"/><path d="M12 16v1"/></svg>),
  Radio: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2" /><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-8.49a6 6 0 0 0 0 8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" /></svg>),
  Sliders: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="2" y1="14" x2="6" y2="14" /><line x1="10" y1="8" x2="14" y2="8" /><line x1="18" y1="16" x2="22" y2="16" /></svg>),
  Keyboard: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><line x1="6" y1="8" x2="6" y2="8" /><line x1="10" y1="8" x2="10" y2="8" /><line x1="14" y1="8" x2="14" y2="8" /><line x1="18" y1="8" x2="18" y2="8" /><line x1="6" y1="12" x2="6" y2="12" /><line x1="10" y1="12" x2="10" y2="12" /><line x1="14" y1="12" x2="14" y2="12" /><line x1="18" y1="12" x2="18" y2="12" /><line x1="7" y1="16" x2="17" y2="16" /></svg>),
  Grip: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>),
  SwapH: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 3 21 7 17 11" /><line x1="21" y1="7" x2="9" y2="7" /><polyline points="7 13 3 17 7 21" /><line x1="3" y1="17" x2="15" y2="17" /></svg>),
  Minimize: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>),
  Pin: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14l-1.4-1.4A2 2 0 0 1 17 14.2V9a5 5 0 0 0-10 0v5.2a2 2 0 0 1-.6 1.4L5 17z" /></svg>),
  Link: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>),
  UserPlus: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="17" y1="11" x2="23" y2="11" /></svg>),
  MessageCircle: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>),
  Disc: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" /></svg>),
  PanelRight: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="15" y1="4" x2="15" y2="20" /></svg>),
  LogOut: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>),
  Edit: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" /></svg>),
  Bell: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>),
  BellOff: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13.73 21a1.94 1.94 0 0 1-3.4 0" /><path d="M18.63 13A17.89 17.89 0 0 1 18 8" /><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" /><path d="M18 8a6 6 0 0 0-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" /></svg>),
  Smile: (p) => (<svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>),
  Upload: (p) => (<svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>),
};

// ---- Chime cues (Web Audio oscillator) -----------
// One shared, lazily-created AudioContext reused across every chime instead
// of a fresh context per call — avoids glitching/autoplay-policy issues when
// several chimes fire in a burst (e.g. a run of friend-request accepts).
let chimeCtx = null;
function getChimeCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!chimeCtx || chimeCtx.state === 'closed') {
    chimeCtx = new Ctx();
  }
  // Browsers suspend contexts created/left idle without a user gesture;
  // resume() is a no-op if it's already running.
  if (chimeCtx.state === 'suspended') {
    chimeCtx.resume().catch(() => {});
  }
  return chimeCtx;
}
function playChime(kind) {
  try {
    const ctx = getChimeCtx();
    if (!ctx) return;
    const sequences = {
      mute: [660, 440],
      unmute: [440, 660],
      deafen: [520, 340, 260],
      undeafen: [260, 340, 520],
      'ptt-on': [700],
      'ptt-off': [420],
      notify: [740, 920],
      mention: [880, 1108, 880],
      // Rising major triad — the "you're in" cue when a voice room connects.
      'voice-join': [523.25, 659.25, 783.99],
      // Same triad played downward on the way out.
      'voice-leave': [783.99, 659.25, 523.25],
      'camera-on': [587.33, 880],
      'camera-off': [880, 587.33],
      'share-on': [659.25, 880, 1046.5],
      'share-off': [1046.5, 783.99, 587.33],
      'friend-accept': [659.25, 830.61, 1046.5],
      error: [311.13, 233.08],
    };
    const freqs = sequences[kind] || [500];
    let t = ctx.currentTime;
    freqs.forEach((freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.1, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
      t += 0.065;
    });
  } catch (e) {}
}

// ---- Emoji: static pack (Twemoji, via CDN) + animated pack (Noto Animated
// Emoji, via CDN) + per-server custom emoji ---------------------------------
// Static unicode emoji are typed as real characters into the message text —
// @twemoji/api repaints any unicode emoji it finds into colorful Twitter-style
// images wherever renderMessageHtml() runs, using jsDelivr's CDN by default.
// Animated and custom emoji aren't real unicode characters, so they're stored
// in the text as a Discord-style :shortcode: and resolved to an <img> at
// render time instead.
const NOTO_ANIMATED_BASE = 'https://fonts.gstatic.com/s/e/notoemoji/latest/';

// A curated set of commonly-used animated emoji from Google's Noto Animated
// Emoji collection (open source, no API key needed). Keyed by shortcode.
const ANIMATED_EMOJI = {
  fire: { char: '🔥', codepoint: '1f525' },
  heart: { char: '❤️', codepoint: '2764_fe0f' },
  tada: { char: '🎉', codepoint: '1f389' },
  clap: { char: '👏', codepoint: '1f44f' },
  joy: { char: '😂', codepoint: '1f602' },
  sob: { char: '😭', codepoint: '1f62d' },
  heart_eyes: { char: '😍', codepoint: '1f60d' },
  thumbsup: { char: '👍', codepoint: '1f44d' },
  eyes: { char: '👀', codepoint: '1f440' },
  100: { char: '💯', codepoint: '1f4af' },
  star_struck: { char: '🤩', codepoint: '1f929' },
  skull: { char: '💀', codepoint: '1f480' },
  wave: { char: '👋', codepoint: '1f44b' },
  thinking: { char: '🤔', codepoint: '1f914' },
  partying_face: { char: '🥳', codepoint: '1f973' },
  sparkles: { char: '✨', codepoint: '2728' },
  rocket: { char: '🚀', codepoint: '1f680' },
  broken_heart: { char: '💔', codepoint: '1f494' },
  pray: { char: '🙏', codepoint: '1f64f' },
  sunglasses: { char: '😎', codepoint: '1f60e' },
};

// A curated set of common static emoji, grouped into picker tabs. Rendered
// through Twemoji (see renderMessageHtml/EmojiPicker) rather than relying on
// the OS emoji font, so everyone sees the same artwork.
const EMOJI_CATEGORIES = [
  {
    label: 'Smileys',
    icon: '😀',
    chars: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😙 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🥳 😎 🤓 🧐'.split(' '),
  },
  {
    label: 'Gestures',
    icon: '👍',
    chars: '👋 🤚 🖐️ ✋ 🖖 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🙏 ✍️ 💅 🤳 💪'.split(' '),
  },
  {
    label: 'Hearts',
    icon: '❤️',
    chars: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟'.split(' '),
  },
  {
    label: 'Animals',
    icon: '🐶',
    chars: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🦂 🐢 🐍 🦎 🐙 🦑 🦀 🐬 🐳 🐋 🦈 🐊 🐆 🦓 🦍'.split(' '),
  },
  {
    label: 'Food',
    icon: '🍕',
    chars: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🌽 🥕 🥔 🍞 🥐 🥯 🧀 🍗 🍖 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🍜 🍝 🍣 🍤 🍩 🍪 🎂 🍰 🍫 🍿 🍺 🍻 🍷 🥂 ☕ 🍵'.split(' '),
  },
  {
    label: 'Activities',
    icon: '⚽',
    chars: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🥋 🎮 🎲 🎯 🎳 🎸 🎧 🎤 🎨 🎬 🏆 🥇 🎉 🎊 🎈 🎁'.split(' '),
  },
  {
    label: 'Objects',
    icon: '💡',
    chars: '💡 🔦 🕯️ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 📷 🎥 📞 ☎️ 📺 📻 ⏰ ⏳ 💰 💵 💳 📦 📬 📌 📎 🔒 🔑 🔨 🔧 🧲 🧪 💊 🚗 ✈️ 🚀 ⛵ 🏠 🏢'.split(' '),
  },
  {
    label: 'Symbols',
    icon: '✅',
    chars: '✅ ❌ ❗ ❓ ⁉️ ‼️ 💯 🔥 ✨ ⭐ 🌟 💫 ⚡ 💥 💢 💤 🔔 🔕 🚫 ⛔ 🆗 🆕 🔄 ▶️ ⏸️ ⏹️ 🔀 🔁'.split(' '),
  },
];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Turns raw message text into safe HTML: escapes it first (so nothing in the
// message can inject markup), swaps any :shortcode: for a custom-server or
// animated emoji into an <img>, then hands the rest to Twemoji so plain
// unicode emoji characters get repainted with the CDN artwork too.
function renderMessageHtml(text, customEmojiMap) {
  const escaped = escapeHtml(text || '').replace(/:([a-zA-Z0-9_+-]{2,32}):/g, (match, name) => {
    const custom = customEmojiMap && customEmojiMap[name.toLowerCase()];
    if (custom) {
      return `<img src="${custom.url}" alt=":${name}:" title=":${name}:" class="msg-emoji${custom.animated ? ' msg-emoji-animated' : ''}" draggable="false" loading="lazy" />`;
    }
    const anim = ANIMATED_EMOJI[name.toLowerCase()];
    if (anim) {
      return `<img src="${NOTO_ANIMATED_BASE}${anim.codepoint}/512.gif" alt=":${name}:" title=":${name}:" class="msg-emoji msg-emoji-animated" draggable="false" loading="lazy" />`;
    }
    return match;
  });
  return twemoji.parse(escaped, { className: 'msg-emoji' });
}

// A floating tabbed picker for static, animated, and per-server custom
// emoji. `onPick(token)` is called with either a literal unicode character
// (static tab) or a ":shortcode:" string (animated/custom tabs) — the caller
// decides whether that's inserted into the composer or sent as a reaction.
const EMOJI_PICKER_W = 336;
const EMOJI_PICKER_MAX_H = 380;

// Positions the picker with position:fixed against a captured trigger-button
// rect, flipping to open downward (and clamping horizontally) whenever there
// isn't enough room above — e.g. a reaction button near the top of a long
// scrolled-up chat. Fixed positioning also means the popup escapes the chat
// list's overflow:auto clipping, instead of being cut off/invisible like an
// absolutely-positioned popup inside a scroll container would be.
function computeEmojiPickerStyle(anchorRect) {
  const MARGIN = 8;
  if (!anchorRect) {
    return { position: 'fixed', bottom: 70, left: 20, maxHeight: EMOJI_PICKER_MAX_H };
  }
  const spaceAbove = anchorRect.top;
  const spaceBelow = window.innerHeight - anchorRect.bottom;
  const openDown = spaceAbove < EMOJI_PICKER_MAX_H + MARGIN && spaceBelow > spaceAbove;

  let left = anchorRect.left;
  if (left + EMOJI_PICKER_W > window.innerWidth - MARGIN) left = window.innerWidth - EMOJI_PICKER_W - MARGIN;
  if (left < MARGIN) left = MARGIN;

  const style = { position: 'fixed', left, zIndex: 9999 };
  if (openDown) {
    style.top = anchorRect.bottom + 8;
    style.maxHeight = Math.min(EMOJI_PICKER_MAX_H, spaceBelow - MARGIN * 2);
  } else {
    style.bottom = window.innerHeight - anchorRect.top + 8;
    style.maxHeight = Math.min(EMOJI_PICKER_MAX_H, spaceAbove - MARGIN * 2);
  }
  return style;
}

function EmojiPicker({ onPick, onClose, customEmojis, onUploadEmoji, canUpload, anchorEl }) {
  const [tab, setTab] = useState('Smileys');
  const [uploading, setUploading] = useState(false);
  const [anchorRect, setAnchorRect] = useState(() => anchorEl?.getBoundingClientRect() ?? null);
  const ref = useRef(null);

  useEffect(() => {
    if (!anchorEl) return;
    const updatePosition = () => {
      if (!document.body.contains(anchorEl)) { onClose(); return; }
      setAnchorRect(anchorEl.getBoundingClientRect());
    };
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [anchorEl, onClose]);

  useEffect(() => {
    const handleClick = (e) => { 
      // Safely ignore clicks inside the picker AND clicks on the button that opened it
      if (ref.current && !ref.current.contains(e.target) && (!anchorEl || !anchorEl.contains(e.target))) {
        onClose(); 
      }
    };
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    const handleScroll = (e) => { if (!ref.current || !ref.current.contains(e.target)) onClose(); };
    
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [onClose, anchorEl]);

  const categoryTabs = EMOJI_CATEGORIES.map((c) => ({ key: c.label, label: c.label, icon: c.icon }));
  const tabs = [...categoryTabs, { key: 'Animated', label: 'Animated', icon: '✨' }, { key: 'Custom', label: 'Custom', icon: '⭐' }];

  const handleEmojiFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onUploadEmoji) return;
    const name = window.prompt('Name this emoji (letters, numbers, _ or -):', file.name.replace(/\.[^.]+$/, ''));
    if (!name) return;
    setUploading(true);
    Promise.resolve(onUploadEmoji(file, name)).finally(() => setUploading(false));
  };

  const gridButtonStyle = {
    border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: '9px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '38px', height: '38px', transition: 'background-color 0.1s ease, transform 0.1s ease',
  };

  // 👇 Wrapped in createPortal so it escapes the chat bar and renders freely over the UI
  return createPortal(
    <div
      ref={ref}
      style={{
        ...computeEmojiPickerStyle(anchorRect),
        width: `${EMOJI_PICKER_W}px`,
        backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '14px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        animation: 'popIn 0.14s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px 8px' }}>
        <span style={{ fontFamily: fontDisplay, fontWeight: 700, fontSize: '13px', color: colors.text }}>
          {tabs.find((t) => t.key === tab)?.label}
        </span>
        <button
          onClick={onClose}
          title="Close"
          style={{ border: 'none', background: 'transparent', color: colors.textFaint, cursor: 'pointer', display: 'flex', padding: '2px', borderRadius: '6px' }}
        >
          <Icon.X size={14} />
        </button>
      </div>

      <div className="scroll-thin" style={{ display: 'flex', gap: '2px', padding: '0 8px 8px', borderBottom: `1px solid ${colors.border}`, overflowX: 'auto', flexShrink: 0 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            title={t.label}
            style={{
              border: 'none', cursor: 'pointer', borderRadius: '8px', padding: '5px 9px', fontSize: '16px',
              whiteSpace: 'nowrap', flexShrink: 0, lineHeight: 1,
              backgroundColor: tab === t.key ? colors.brandDim : 'transparent',
              boxShadow: tab === t.key ? `inset 0 -2px 0 ${colors.brand}` : 'none',
              filter: tab === t.key ? 'none' : 'grayscale(35%) opacity(0.75)',
            }}
          >
            {t.icon}
          </button>
        ))}
      </div>

      <div className="scroll-thin" style={{ padding: '10px', overflowY: 'auto', flex: 1 }}>
        {tab === 'Animated' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '4px' }}>
            {Object.entries(ANIMATED_EMOJI).map(([name, info]) => (
              <button
                key={name}
                onClick={() => onPick(`:${name}:`)}
                title={`:${name}:`}
                style={gridButtonStyle}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.panelAlt)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <img src={`${NOTO_ANIMATED_BASE}${info.codepoint}/512.gif`} alt={name} width={26} height={26} loading="lazy" />
              </button>
            ))}
          </div>
        ) : tab === 'Custom' ? (
          <div>
            {canUpload && (
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: colors.brand, cursor: uploading ? 'default' : 'pointer', marginBottom: '10px', padding: '9px', borderRadius: '10px', border: `1.5px dashed ${colors.borderSoft}`, backgroundColor: colors.panelAlt }}>
                <Icon.Upload size={13} />
                {uploading ? 'Uploading…' : 'Add emoji to this server'}
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} disabled={uploading} onChange={handleEmojiFile} />
              </label>
            )}
            {(!customEmojis || customEmojis.length === 0) ? (
              <p style={{ fontSize: '12px', color: colors.textFaint, textAlign: 'center', margin: '20px 0' }}>No custom emoji yet.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '4px' }}>
                {customEmojis.map((em) => (
                  <button
                    key={em.id}
                    onClick={() => onPick(`:${em.name}:`)}
                    title={`:${em.name}:`}
                    style={gridButtonStyle}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.panelAlt)}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <img src={em.url} alt={em.name} width={26} height={26} loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
            {(EMOJI_CATEGORIES.find((c) => c.label === tab)?.chars || []).map((ch, i) => (
              <button
                key={i}
                onClick={() => onPick(ch)}
                style={{ ...gridButtonStyle, fontSize: '20px' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = colors.panelAlt; e.currentTarget.style.transform = 'scale(1.12)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}
              >
                {ch}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
// ---- Notification preferences (mute) --------------------------------------
// Per-server and per-channel mute are purely local preferences — they live in
// localStorage rather than the backend, so they don't need a schema change
// and stay private to this device/account pairing (scoped by username, same
// as the layout prefs elsewhere in the file).
function muteStorageKey(kind, username) {
  return `soulMuted${kind}:${username || 'anon'}`;
}
function readMutedIds(kind, username) {
  try {
    const raw = JSON.parse(localStorage.getItem(muteStorageKey(kind, username)));
    return Array.isArray(raw) ? new Set(raw) : new Set();
  } catch { return new Set(); }
}
function writeMutedIds(kind, username, set) {
  try { localStorage.setItem(muteStorageKey(kind, username), JSON.stringify([...set])); } catch (e) {}
}
function isServerMuted(serverId, username) { return readMutedIds('Servers', username).has(serverId); }
function isChannelMuted(channelId, username) { return readMutedIds('Channels', username).has(channelId); }
// Toggles membership in the stored set and returns the new muted state.
function toggleMutedId(kind, username, id) {
  const set = readMutedIds(kind, username);
  if (set.has(id)) set.delete(id); else set.add(id);
  writeMutedIds(kind, username, set);
  return set.has(id);
}

// Whether `content` @-mentions `username` (case-insensitive, word-bounded —
// "@ari" matches but "@arianna" or "email@ari.com" should not).
function messageMentions(content, username) {
  if (!content || !username) return false;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-zA-Z0-9_])@${escaped}(?![a-zA-Z0-9_])`, 'i').test(content);
}

// Fires a native OS notification via the standard Web Notification API. This
// works as-is inside Electron's renderer (main.cjs already auto-grants the
// permission through its permission-request handler); in a plain browser tab
// it'll prompt the user the first time. Silently no-ops if unsupported.
function fireDesktopNotification(title, body, onClick) {
  try {
    if (typeof Notification === 'undefined') return;
    const spawn = () => {
      const n = new Notification(title, { body, silent: true });
      n.onclick = () => {
        try { window.focus(); } catch (e) {}
        try { window.electronAPI?.windowControls?.focus?.(); } catch (e) {}
        onClick?.();
      };
    };
    if (Notification.permission === 'granted') spawn();
    else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => { if (p === 'granted') spawn(); });
  } catch (e) { /* Notification API unavailable in this environment */ }
  // Also nudge the taskbar/dock icon — the OS notification bubble alone is
  // easy to miss, especially on Windows where it can disappear silently.
  try { window.electronAPI?.windowControls?.flash?.(); } catch (e) {}
}

// Tracks whether the app window currently has OS focus. Used to decide
// whether a new message needs a background alert (desktop notification) or
// just a quiet in-app nudge (toast + chime) since the person is already
// looking at the app.
function useWindowFocused() {
  const [focused, setFocused] = useState(() => (typeof document === 'undefined' ? true : document.hasFocus()));
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return focused;
}

const bannerSwatches = ['#6366f1', '#14b8a6', '#f43f5e', '#f59e0b', '#8b5cf6', '#0ea5e9'];

function RoleBadge({ role }) {
  if (!role || role === 'member') return null;
  const isOwner = role === 'owner';
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
      padding: '2px 7px', borderRadius: '4px', fontFamily: fontMono,
      color: isOwner ? colors.gold : colors.brand,
      backgroundColor: isOwner ? colors.goldDim : colors.brandDim,
      border: `1px solid ${isOwner ? 'rgba(212, 162, 76, 0.35)' : 'rgba(204, 75, 194, 0.35)'}`,
    }}>
      {isOwner ? 'Owner' : 'Admin'}
    </span>
  );
}

// Small account-level badges (Founder, Supporter, etc) — separate from the
// per-server RoleBadge above, these follow the account everywhere.
function UserBadges({ badges }) {
  if (!badges || badges.length === 0) return null;
  return (
    <>
      {badges.map((b) => (
        <span key={b.id} title={b.label} style={{
          fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', fontFamily: fontMono,
          color: b.color, backgroundColor: `${b.color}22`, border: `1px solid ${b.color}55`,
        }}>
          {b.label}
        </span>
      ))}
    </>
  );
}

// The little "grinding ranked 🎮" line under a username, wherever a member's
// custom status should show up.
function StatusLine({ statusText, statusEmoji, style }) {
  if (!statusText) return null;
  return (
    <div style={{ fontSize: '12px', color: colors.textFaint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...style }}>
      {statusEmoji ? `${statusEmoji} ` : ''}{statusText}
    </div>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=Space+Mono:wght@400;700&display=swap');
      
      * { box-sizing: border-box; }
      html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; background: ${colors.bg}; overflow: hidden; }
      body { overscroll-behavior: none; }

      /* Twemoji/animated/custom emoji rendered inline in message text. */
      .msg-emoji { width: 1.25em; height: 1.25em; vertical-align: -0.28em; object-fit: contain; }
      .msg-emoji-animated { width: 1.6em; height: 1.6em; vertical-align: -0.4em; }

      .reaction-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid ${colors.borderSoft}; background: ${colors.panelAlt}; color: ${colors.textMuted}; transition: background 0.12s ease, border-color 0.12s ease; }
      .reaction-pill:hover { border-color: ${colors.brand}; }
      .reaction-pill--mine { background: ${colors.brandDim}; border-color: ${colors.brand}; color: ${colors.brand}; }
      .reaction-pill img.msg-emoji { width: 14px; height: 14px; vertical-align: -2px; }
      .reaction-add-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 999px; border: 1px dashed ${colors.borderSoft}; background: transparent; color: ${colors.textFaint}; cursor: pointer; }
      .reaction-add-btn:hover { color: ${colors.brand}; border-color: ${colors.brand}; }
      
      @keyframes pulseGlow { 0%,100% { box-shadow: 0 0 0 0 rgba(204, 75, 194, 0.4); } 50% { box-shadow: 0 0 0 5px rgba(204, 75, 194, 0); } }
      /* Stage-spotlight glow: a warm gold core with a cooler magenta halo,
         like a follow-spot picking someone out on a dark stage. This is
         Soul's one signature motif — it should be the only "loud" animated
         thing on screen at any given time. */
      @keyframes speakGlow {
        0%,100% { box-shadow: 0 0 0 3px ${colors.gold}, 0 0 18px 4px rgba(212, 162, 76, 0.45), 0 0 36px 10px rgba(204, 75, 194, 0.28); }
        50%     { box-shadow: 0 0 0 3px ${colors.gold}, 0 0 26px 6px rgba(212, 162, 76, 0.7), 0 0 48px 16px rgba(204, 75, 194, 0.45); }
      }
      @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes soundstageIconPulse { 0%, 100% { transform: scale(0.9); opacity: 0.65; } 50% { transform: scale(1.12); opacity: 1; } }
      @keyframes mixerIconShift { 0%, 100% { transform: translateX(-2px); } 50% { transform: translateX(2px); } }
      @keyframes fadeIn { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }
      @keyframes popIn { from { opacity: 0; transform: translateY(8px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes popInCentered { from { opacity: 0; transform: translate(-50%, -50%) translateY(8px) scale(0.97); } to { opacity: 1; transform: translate(-50%, -50%) translateY(0) scale(1); } }
      @keyframes resizeFlash { 0% { box-shadow: 0 0 0 0 ${colors.brand}99; } 100% { box-shadow: 0 0 22px 8px ${colors.brand}00; } }

      /* Ambient stage-light drift — the backdrop glows on Home very slowly
         wander, like the room lights of the "jazz club" identity shifting
         over a long set rather than sitting frozen. Kept slow (18s+) and
         low-amplitude so it reads as atmosphere, not motion you consciously
         notice. */
      @keyframes driftGlowA { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(-26px, 22px) scale(1.08); } }
      @keyframes driftGlowB { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(24px, -18px) scale(1.05); } }

      /* A quiet idle ring for anyone connected to voice but not currently
         speaking — the stage stays "warm" instead of going dead-flat black
         between turns, and the jump to speakGlow reads as someone stepping
         into an already-lit room rather than a light switching on cold. */
      @keyframes idleGlow { 0%, 100% { box-shadow: 0 0 0 3px ${colors.border}, 0 0 0 0 rgba(204, 75, 194, 0); } 50% { box-shadow: 0 0 0 3px ${colors.border}, 0 0 20px 3px rgba(204, 75, 194, 0.18); } }

      /* Gentle float for empty-state glyphs — just enough life that an empty
         screen doesn't feel broken or unfinished, with a touch of drift and
         rotation so it reads as floating rather than simple up-down bobbing. */
      @keyframes floatSoft { 0%, 100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-6px) rotate(-3deg); } }

      /* Soft brand-colored breathing halo behind the wordmark/logo. */
      @keyframes markGlow { 0%, 100% { box-shadow: 0 0 0 0 rgba(204, 75, 194, 0.35); } 50% { box-shadow: 0 0 14px 3px rgba(204, 75, 194, 0.28); } }
      
      @keyframes messagePop {
        0% { opacity: 0; transform: translateY(12px) scale(0.98); }
        100% { opacity: 1; transform: none; }
      }
      
      ::-webkit-scrollbar { width: 8px; } 
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 8px; } 
      ::-webkit-scrollbar-thumb:hover { background: #52525b; }
      
      .scroll-thin { scrollbar-width: thin; scrollbar-color: transparent transparent; }
      .scroll-thin::-webkit-scrollbar { width: 6px; }
      .scroll-thin::-webkit-scrollbar-track { background: transparent; }
      .scroll-thin::-webkit-scrollbar-thumb { background: transparent; border-radius: 8px; }
      .scroll-thin:hover { scrollbar-color: #3f3f46 transparent; }
      .scroll-thin:hover::-webkit-scrollbar-thumb { background: #3f3f46; }
      
      .share-bar { animation: popIn 0.18s ease; }
      .lobby-input:focus, .modal-input:focus { outline: none; border-color: ${colors.brand} !important; box-shadow: 0 0 0 3px ${colors.brandDim}; }
      .chat-input:focus { outline: none !important; border: none !important; box-shadow: none !important; background: transparent !important; }
      .connect-btn:hover { filter: brightness(1.1); }
      .channel-row:hover { background: ${colors.panelAlt} !important; }
      .member-row:hover { background: ${colors.panelAlt}; }
      
      .channel-row .row-delete { opacity: 0; transition: opacity 0.15s; }
      .channel-row:hover .row-delete { opacity: 1; }
      .channel-row .row-mute { opacity: 0; transition: opacity 0.15s, color 0.15s; }
      .channel-row:hover .row-mute, .channel-row .row-mute.is-muted { opacity: 1; }
      
      .server-card { position: relative; overflow: hidden; }
      .server-card::before { content: ''; position: absolute; inset: 0; background: linear-gradient(135deg, ${colors.brandDim}, transparent 60%); opacity: 0; transition: opacity 0.2s; pointer-events: none; }
      .server-card:hover::before { opacity: 1; }
      .server-card:hover { border-color: ${colors.textFaint} !important; transform: translateY(-3px); box-shadow: 0 12px 30px rgba(0,0,0,0.5); }
      
      .server-card .card-delete { opacity: 0; transition: opacity 0.15s, background 0.15s; }
      .server-card:hover .card-delete { opacity: 1; }
      .server-card .card-mute { opacity: 0; transition: opacity 0.15s, background 0.15s, color 0.15s; }
      .server-card:hover .card-mute, .server-card .card-mute.is-muted { opacity: 1; }

      @keyframes alertToastIn { from { opacity: 0; transform: translateX(16px) scale(0.97); } to { opacity: 1; transform: translateX(0) scale(1); } }
      .alert-toast { animation: alertToastIn 0.2s cubic-bezier(0.34, 1.2, 0.64, 1) both; cursor: pointer; }
      .alert-toast:hover { filter: brightness(1.08); }
      
      .pill-btn { transition: filter 0.15s, transform 0.1s; }
      .pill-btn:hover { filter: brightness(1.2); transform: translateY(-1px); }
      .pill-btn:active { transform: scale(0.96); }
      .send-btn:hover { background: #4f46e5 !important; }
      .icon-btn { transition: filter 0.15s ease, transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1), background-color 0.15s ease, color 0.15s ease; }
      .icon-btn:hover { filter: brightness(1.3); transform: scale(1.08); }
      .icon-btn:active { transform: scale(0.86); transition-duration: 0.06s; }
      .round-btn { transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.15s ease, filter 0.15s ease !important; }
      .round-btn:hover { transform: translateY(-2px) scale(1.03); box-shadow: 0 8px 20px rgba(0,0,0,0.35); filter: none; }
      .round-btn:active { transform: scale(0.92); transition-duration: 0.06s; }
      @keyframes breathe { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
      .joining-voice { animation: breathe 1.6s ease-in-out infinite; }
      
      .tab-btn:hover { color: ${colors.text} !important; }
      .settings-tab { transition: color 0.15s, border-color 0.15s; }
      .settings-tab.active { color: ${colors.text} !important; border-bottom-color: ${colors.brand} !important; }
      
      .msg-row { animation: messagePop 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.1); transition: background-color 0.1s; text-align: left; transform-origin: left bottom; }
      .msg-row:hover { background: ${colors.panelAlt}; }
      .msg-row .msg-time { opacity: 0; transition: opacity 0.1s; }
      .msg-row:hover .msg-time { opacity: 1; }
      .msg-row .msg-pin-btn { opacity: 0; }
      .msg-row:hover .msg-pin-btn { opacity: 1 !important; }
      .msg-row .msg-action-btn { opacity: 0; }
      .msg-row:hover .msg-action-btn { opacity: 1 !important; }
      .avatar-tile { animation: fadeIn 0.22s ease; }
      .server-card { animation: fadeUp 0.36s cubic-bezier(0.16, 1, 0.3, 1) both; }
      .dock, .popover-card { animation: popIn 0.16s ease; }
      /* modal-card is always centered via top:50%/left:50%/translate(-50%,-50%).
         popIn's own transform used to completely replace that centering
         transform for the animation's duration, so the card would render
         off-center (down and to the side) for 0.16s and then snap into
         place the instant the animation ended — the "moves from down to
         middle" jump. popInCentered bakes the centering translate into
         every frame so it never leaves its final position, it just fades
         and scales in place. */
      .modal-card { animation: popInCentered 0.16s ease; border-radius: 28px !important; }
      .popover-card { border-radius: 24px !important; }
      .swatch:hover { transform: scale(1.1); }
      .device-select:hover { border-color: ${colors.textMuted} !important; }
      
      h1, h2, h3, h4, h5, h6 { font-family: ${fontDisplay}; letter-spacing: -0.03em; }

      /* ---- Friends panel ---- */
      @keyframes shimmer { 0% { background-position: -200px 0; } 100% { background-position: 200px 0; } }
      @keyframes toastIn { from { opacity: 0; transform: translate(-50%, 10px) scale(0.96); } to { opacity: 1; transform: translate(-50%, 0) scale(1); } }
      @keyframes ringPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(212,162,76,0.5); } 50% { box-shadow: 0 0 0 4px rgba(212,162,76,0); } }
      @keyframes rowIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
      @keyframes bubbleIn { from { opacity: 0; transform: translateY(6px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }

      .skeleton { background: linear-gradient(90deg, ${colors.panelAlt} 25%, ${colors.border} 37%, ${colors.panelAlt} 63%); background-size: 400px 100%; animation: shimmer 1.4s ease infinite; }

      .friend-tab { position: relative; z-index: 1; transition: color 0.25s ease; }
      .friend-tab-indicator { position: absolute; top: 4px; bottom: 4px; border-radius: 8px; background: ${colors.brand}; transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1), width 0.28s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 4px 14px rgba(204,75,194,0.35); }

      .friend-add-btn { transition: transform 0.15s ease, filter 0.15s ease, opacity 0.15s ease; }
      .friend-add-btn:hover:not(:disabled) { filter: brightness(1.15); transform: translateY(-1px); }
      .friend-add-btn:active:not(:disabled) { transform: scale(0.95); }
      .friend-add-btn:disabled { opacity: 0.5; cursor: not-allowed; }

      .friend-row { animation: rowIn 0.22s ease both; transition: background-color 0.15s ease, transform 0.15s ease; position: relative; }
      .friend-row:hover { background: ${colors.panelAlt} !important; transform: translateX(2px); }
      .friend-row .friend-unfriend { opacity: 0; transition: opacity 0.15s ease, background 0.15s ease; }
      .friend-row:hover .friend-unfriend { opacity: 1; }
      .friend-row .friend-msg-hint { opacity: 0; transition: opacity 0.15s ease, transform 0.15s ease; transform: translateX(-4px); }
      .friend-row:hover .friend-msg-hint { opacity: 1; transform: translateX(0); }

      .friend-avatar-ring { transition: box-shadow 0.2s ease; }
      .friend-row:hover .friend-avatar-ring { box-shadow: 0 0 0 2px ${colors.brand}; }
      .friend-row.selected .friend-avatar-ring { box-shadow: 0 0 0 2px ${colors.brand}; }

      .request-card { animation: rowIn 0.22s ease both; transition: background-color 0.15s ease, border-color 0.15s ease; }
      .request-card:hover { background: ${colors.panelAlt}; }
      .request-accept, .request-decline { transition: transform 0.15s ease, filter 0.15s ease; }
      .request-accept:hover, .request-decline:hover { filter: brightness(1.2); transform: scale(1.08); }
      .request-accept:active, .request-decline:active { transform: scale(0.92); }
      .pending-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${colors.gold}; margin-right: 5px; animation: ringPulse 1.8s ease infinite; }

      .friend-toast { animation: toastIn 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) both; }

      .friend-empty { animation: fadeIn 0.3s ease; }
      .friend-empty-icon { animation: fadeIn 0.35s ease, floatSoft 3.4s ease-in-out 0.35s infinite; }

      /* Home screen: header/search/cards drop in one beat after another
         instead of all at once — a single orchestrated entrance rather than
         scattered per-element effects. */
      .stagger-in { animation: fadeUp 0.42s cubic-bezier(0.16, 1, 0.3, 1) both; }

      .soul-mark-wrap { border-radius: 12px; animation: markGlow 3.2s ease-in-out infinite; }


      .dm-bubble { animation: bubbleIn 0.2s cubic-bezier(0.34, 1.2, 0.64, 1) both; }
      .friend-send-btn { transition: filter 0.15s ease, transform 0.12s ease; }
      .friend-send-btn:hover:not(:disabled) { filter: brightness(1.15); }
      .friend-send-btn:active:not(:disabled) { transform: scale(0.94); }
      .friend-send-btn:disabled { opacity: 0.45; cursor: not-allowed; }

      .friend-panel-input:focus { outline: none; border-color: ${colors.brand} !important; box-shadow: 0 0 0 3px ${colors.brandDim}; }



      .server-card {
        content-visibility: auto;
        contain-intrinsic-size: auto 120px;
      }

      .member-row {
        content-visibility: auto;
        contain-intrinsic-size: auto 40px;
      }

    `}</style>
  );
}

// ============================================================================
// SHARED: small confirm dialog
// ============================================================================
function ConfirmModal({ title, body, confirmLabel = 'Delete', onConfirm, onCancel }) {
  return (
    <>
      <div onClick={onCancel} style={{ position: 'fixed', inset: 0, zIndex: 49, backgroundColor: 'rgba(0,0,0,0.7)', WebkitAppRegion: 'no-drag' }} />
      <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 50, width: '320px', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '16px', padding: '24px', boxShadow: '0 24px 60px rgba(0,0,0,0.8)', WebkitAppRegion: 'no-drag' }}>
        <h3 style={{ margin: '0 0 8px', fontWeight: 700, fontSize: '18px', color: colors.text }}>{title}</h3>
        <p style={{ margin: '0 0 24px', fontSize: '13px', color: colors.textMuted, lineHeight: 1.5 }}>{body}</p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onCancel} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={onConfirm} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: colors.danger, color: 'white', fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>{confirmLabel}</button>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// BRAND MARK
// ============================================================================
function SoulMark({ size = 38, radius = 12 }) {
  return (
    <img 
      src={appIcon} 
      alt="Soul Logo" 
      style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover', flexShrink: 0 }} 
    />
  );
}

// ============================================================================
// AUTH SCREEN
// ============================================================================
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const api = useApi(null);

  const submit = async () => {
    if (!username.trim() || !password) { setError('Enter a username and password.'); return; }
    setError(''); setLoading(true);
    try {
      if (mode === 'register') {
        await api('/register', { method: 'POST', body: JSON.stringify({ username: username.trim(), password }) });
      }
      const data = await api('/login', { method: 'POST', body: JSON.stringify({ username: username.trim(), password }) });
      onAuthed({ token: data.authToken, user: { id: data.userId, username: data.username } });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', width: '100%', fontFamily: fontBody, backgroundColor: colors.bg,
      overflow: 'hidden', WebkitAppRegion: 'drag'
    }}>
      <GlobalStyle />

      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="modal-card" style={{
          width: '380px', backgroundColor: colors.panel, border: `1px solid ${colors.borderSoft}`,
          borderRadius: '12px', padding: '32px', boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
          animation: 'fadeUp 0.4s ease', WebkitAppRegion: 'no-drag'
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '24px' }}>
            <SoulMark size={48} radius={14} />
          </div>
          <h2 style={{ margin: '0 0 8px', fontSize: '24px', color: colors.text, textAlign: 'center', fontWeight: 700 }}>
            {mode === 'login' ? 'Welcome back!' : 'Create an account'}
          </h2>
          <p style={{ margin: '0 0 24px', fontSize: '14px', color: colors.textMuted, textAlign: 'center' }}>
            {mode === 'login' ? 'We\'re so excited to see you again!' : 'Pick a username and join the squad.'}
          </p>

          <div style={{ display: 'flex', gap: '4px', padding: '4px', marginBottom: '24px', borderRadius: '10px', backgroundColor: colors.bg, border: `1px solid ${colors.border}` }}>
            {['login', 'register'].map((m) => (
              <button
                key={m}
                className="tab-btn"
                onClick={() => { setMode(m); setError(''); }}
                style={{
                  flex: 1, border: 'none', cursor: 'pointer', padding: '10px 0', borderRadius: '8px',
                  fontFamily: fontDisplay, fontWeight: 700, fontSize: '13.5px',
                  color: mode === m ? 'white' : colors.textFaint,
                  backgroundColor: mode === m ? colors.brand : 'transparent',
                  transition: 'background-color 0.15s, color 0.15s',
                }}
              >
                {m === 'login' ? 'Log In' : 'Register'}
              </button>
            ))}
          </div>

          <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: colors.textMuted, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Username <span style={{ color: colors.danger }}>*</span>
          </label>
          <div style={{ position: 'relative', marginBottom: '16px' }}>
            <span style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: colors.textFaint, display: 'flex' }}><Icon.User size={16} /></span>
            <input
              className="lobby-input"
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              style={{ padding: '12px 14px 12px 42px', width: '100%', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, fontSize: '14px', boxSizing: 'border-box' }}
            />
          </div>

          <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: colors.textMuted, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Password <span style={{ color: colors.danger }}>*</span>
          </label>
          <div style={{ position: 'relative', marginBottom: '24px' }}>
            <span style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: colors.textFaint, display: 'flex' }}><Icon.Lock size={16} /></span>
            <input
              className="lobby-input"
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              style={{ padding: '12px 44px 12px 42px', width: '100%', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, fontSize: '14px', boxSizing: 'border-box' }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', color: colors.textFaint, cursor: 'pointer', display: 'flex', padding: '4px' }}
            >
              {showPassword ? <Icon.EyeOff size={16} /> : <Icon.Eye size={16} />}
            </button>
          </div>

          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', marginBottom: '20px', borderRadius: '8px', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: colors.danger, flexShrink: 0 }} />
              <p style={{ color: colors.danger, fontSize: '13px', fontWeight: 500, margin: 0 }}>{error}</p>
            </div>
          )}

          <button
            className="connect-btn"
            onClick={submit}
            disabled={loading}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '14px 20px', width: '100%', background: colors.brand, color: 'white', border: 'none', borderRadius: '8px', cursor: loading ? 'default' : 'pointer', fontWeight: 700, fontFamily: fontDisplay, fontSize: '14px', opacity: loading ? 0.7 : 1 }}
          >
            {loading ? 'Please wait…' : (mode === 'login' ? 'Log In' : 'Create Account')}
          </button>
          
          <p style={{ textAlign: 'center', margin: '20px 0 0', fontSize: '13px', color: colors.textFaint }}>
            {mode === 'login' ? "New here? " : 'Already have an account? '}
            <span
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
              style={{ color: colors.brand, fontWeight: 600, cursor: 'pointer' }}
            >
              {mode === 'login' ? 'Create an account' : 'Log in'}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SERVER LIST / DISCOVERY
// ============================================================================
// REVIEW: two gaps worth flagging for this screen and the app in general —
// 1) No unread badges: server cards below show name/icon but nothing
//    signals which server has new activity since you last opened it. One of
//    the most-used signals in Discord's sidebar; would need a per-member
//    "last read" timestamp/messageId per channel, compared against each
//    channel's latest message, then rolled up per-server for the card.
// 2) No message/channel/member search anywhere in the app — `search` below
//    only filters the server list itself, not content inside a server.
//    There's no way to find an old message, a channel, or a member by name
//    once you're inside a server.
function ServerListScreen({ authToken, user, onOpenServer, onOpenFriends, onLogout }) {
  const api = useApi(authToken);
  const [servers, setServers] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [showJoin, setShowJoin] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const [joining, setJoining] = useState(false);

  const joinByInvite = async () => {
    const code = inviteCode.trim();
    if (!code) return;
    setJoining(true);
    setJoinError('');
    try {
      const info = await api(`/invites/${code}`);
      const result = await api(`/invites/${code}/join`, { method: 'POST' });
      setShowJoin(false);
      setInviteCode('');
      onOpenServer(result.serverId, info.serverName, 'member');
    } catch (e) {
      setJoinError(e.message);
    } finally {
      setJoining(false);
    }
  };

  const load = async (q) => {
    setLoading(true);
    try {
      const data = await api(`/servers${q ? `?search=${encodeURIComponent(q)}` : ''}`);
      setServers(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(''); }, []); // eslint-disable-line
  useEffect(() => {
    const t = setTimeout(() => load(search), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line

  const createServer = async () => {
    if (!newName.trim()) return;
    try {
      const created = await api('/servers', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) });
      setShowCreate(false);
      setNewName('');
      onOpenServer(created.id, created.name, 'owner');
    } catch (e) {
      setError(e.message);
    }
  };

  const joinAndOpen = async (s) => {
    try {
      const membership = await api(`/servers/${s.id}/join`, { method: 'POST' });
      onOpenServer(s.id, s.name, membership.role || 'member');
    } catch (e) {
      setError(e.message);
    }
  };

  const leaveServer = async (s, e) => {
    e.stopPropagation();
    try {
      await api(`/servers/${s.id}/leave`, { method: 'POST' });
      load(search);
    } catch (e2) {
      setError(e2.message);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState(null);

  // Per-server mute — a local preference, not synced to the backend. Muting
  // a server suppresses desktop notifications, toasts, and sounds for every
  // room inside it (see the global notification listener in App()).
  const [mutedServerIds, setMutedServerIds] = useState(() => readMutedIds('Servers', user.username));
  const toggleMuteServer = (s, e) => {
    e.stopPropagation();
    toggleMutedId('Servers', user.username, s.id);
    setMutedServerIds(readMutedIds('Servers', user.username));
  };

  const deleteServer = async () => {
    const s = confirmDelete;
    setConfirmDelete(null);
    try {
      await api(`/servers/${s.id}`, { method: 'DELETE' });
      load(search);
    } catch (e2) {
      setError(e2.message);
    }
  };

  const myServers = servers.filter((s) => s.isMember);
  const totalMembers = myServers.reduce((sum, s) => sum + (s.memberCount || 0), 0);
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div style={{ height: '100vh', width: '100%', backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      <GlobalStyle />

      {/* Ambient stage light — the same spotlight identity used for speaking
          participants elsewhere in the app, dialed down to a quiet backdrop,
          drifting slowly like a room's key light shifting over a long set. */}
      <div style={{ position: 'absolute', top: '-220px', right: '-160px', width: '560px', height: '560px', borderRadius: '50%', background: `radial-gradient(circle, ${colors.brandDim} 0%, transparent 70%)`, pointerEvents: 'none', zIndex: -1, animation: 'driftGlowA 22s ease-in-out infinite' }} />
      <div style={{ position: 'absolute', bottom: '-260px', left: '-180px', width: '600px', height: '600px', borderRadius: '50%', background: `radial-gradient(circle, ${colors.goldDim} 0%, transparent 70%)`, pointerEvents: 'none', zIndex: -1, animation: 'driftGlowB 26s ease-in-out infinite' }} />

          {/* Slim drag strip — keeps the frameless window movable without any
          buttons living up here to accidentally intercept the drag. */}
      <div style={{ height: '38px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: '20px', borderBottom: `1px solid ${colors.border}`, WebkitAppRegion: 'drag' }}>
        <span style={{ fontFamily: fontDisplay, fontWeight: 700, fontSize: '12px', color: colors.textFaint, letterSpacing: '0.02em' }}>Soul</span>
        <WindowControls />
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Icon rail — home mark up top, quick access to Friends, account at
            the bottom. This is the app's "you are here" anchor. */}
        <div style={{ width: '76px', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '18px 0', gap: '10px', backgroundColor: colors.panelAlt, borderRight: `1px solid ${colors.border}`, WebkitAppRegion: 'no-drag' }}>
          <div><SoulMark size={40} radius={12} /></div>
          <div style={{ width: '26px', height: '1px', backgroundColor: colors.border, margin: '4px 0 6px' }} />

          <button
            onClick={onOpenFriends}
            className="icon-btn"
            title="Friends"
            style={{ width: '44px', height: '44px', borderRadius: '14px', border: 'none', backgroundColor: colors.brandDim, color: colors.brand, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon.MessageCircle size={19} />
          </button>
          <span style={{ fontSize: '10px', fontWeight: 700, color: colors.textFaint }}>Friends</span>

          <div style={{ flex: 1 }} />

          <div title={user.username} style={{ width: '38px', height: '38px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: colorForName(user.username), display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '13px', color: '#fff' }}>
            {initialsForName(user.username)}
          </div>
          <button
            onClick={onLogout}
            className="icon-btn"
            title="Log out"
            style={{ width: '34px', height: '34px', borderRadius: '10px', border: 'none', background: 'transparent', color: colors.textFaint, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon.LogOut size={16} />
          </button>
        </div>

      <div className="scroll-thin" style={{ flex: 1, overflowY: 'auto', padding: '40px 28px', minWidth: 0 }}>
        <div style={{ maxWidth: '880px', margin: '0 auto' }}>
          <div className="stagger-in" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px', gap: '16px', flexWrap: 'wrap' }}>
            <div style={{ borderLeft: `3px solid ${colors.brand}`, paddingLeft: '14px' }}>
              <h1 style={{ margin: 0, fontSize: '28px' }}>{greeting}, {user.username}</h1>
              <p style={{ margin: '6px 0 0', fontSize: '14px', color: colors.textMuted }}>
                {myServers.length > 0
                  ? `In ${myServers.length} server${myServers.length === 1 ? '' : 's'} · ${totalMembers} people around you`
                  : 'Join a community, or start your own.'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setShowJoin(true)}
                className="pill-btn"
                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 18px', borderRadius: '10px', border: `1px solid ${colors.border}`, backgroundColor: 'transparent', color: colors.text, fontFamily: fontDisplay, fontWeight: 700, fontSize: '14px', cursor: 'pointer' }}
              >
                <Icon.Link size={16} /> Join via Invite
              </button>
              <button
                onClick={() => setShowCreate(true)}
                className="pill-btn"
                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 18px', borderRadius: '10px', border: 'none', backgroundColor: colors.brand, color: 'white', fontFamily: fontDisplay, fontWeight: 700, fontSize: '14px', cursor: 'pointer', boxShadow: `0 6px 18px ${colors.brandDim}` }}
              >
                <Icon.Plus size={16} /> Create Server
              </button>
            </div>
          </div>

          <div className="stagger-in" style={{ position: 'relative', marginBottom: '32px', animationDelay: '60ms' }}>
            <span style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', color: colors.textFaint }}><Icon.Search size={16} /></span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search servers…"
              style={{ width: '100%', padding: '14px 16px 14px 44px', borderRadius: '12px', border: `1px solid ${colors.border}`, backgroundColor: colors.panel, color: colors.text, fontFamily: fontBody, fontSize: '14px', boxSizing: 'border-box' }}
            />
          </div>

          {error && <p style={{ color: colors.danger, fontSize: '13px' }}>{error}</p>}
          {loading && <p style={{ color: colors.textFaint, fontSize: '14px' }}>Loading servers…</p>}
          {!loading && servers.length === 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '14px',
              padding: '56px 24px', borderRadius: '16px', border: `1px dashed ${colors.border}`, backgroundColor: colors.panel,
            }}>
              <div className="friend-empty-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textFaint }}>
                <Icon.Users size={30} />
              </div>
              <div>
                <p style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: colors.text }}>
                  {search ? `No servers match "${search}"` : 'No servers yet'}
                </p>
                <p style={{ margin: '4px 0 0', fontSize: '13px', color: colors.textMuted }}>
                  {search ? 'Try a different name, or start a fresh one.' : 'Create your first server or join one with an invite code.'}
                </p>
              </div>
              <button
                onClick={() => setShowCreate(true)}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', borderRadius: '10px', border: 'none', backgroundColor: colors.brand, color: 'white', fontFamily: fontDisplay, fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
              >
                <Icon.Plus size={14} /> Create Server
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px' }}>
            {servers.map((s, i) => (
              <div
                key={s.id}
                className="server-card"
                onClick={() => (s.isMember ? onOpenServer(s.id, s.name, s.myRole) : joinAndOpen(s))}
                style={{
                  cursor: 'pointer', backgroundColor: colors.panel, border: `1px solid ${colors.border}`,
                  borderRadius: '14px', padding: '20px', transition: 'border-color 0.2s, transform 0.2s, box-shadow 0.2s',
                  animationDelay: `${Math.min(i, 10) * 45}ms`,
                }}
              >
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', borderRadius: '14px 14px 0 0', background: colorForName(s.name) }} />
                {s.myRole === 'owner' && (
                  <button
                    className="icon-btn card-delete"
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(s); }}
                    title="Delete server"
                    style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 1, width: '28px', height: '28px', borderRadius: '8px', border: 'none', backgroundColor: 'rgba(239, 68, 68, 0.15)', color: colors.danger, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon.Trash size={13} />
                  </button>
                )}
                {s.isMember && (
                  <button
                    className={`icon-btn card-mute${mutedServerIds.has(s.id) ? ' is-muted' : ''}`}
                    onClick={(e) => toggleMuteServer(s, e)}
                    title={mutedServerIds.has(s.id) ? 'Unmute server' : 'Mute server'}
                    style={{
                      position: 'absolute', top: '12px', right: s.myRole === 'owner' ? '48px' : '12px', zIndex: 1,
                      width: '28px', height: '28px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      backgroundColor: mutedServerIds.has(s.id) ? colors.brandDim : 'rgba(255,255,255,0.06)',
                      color: mutedServerIds.has(s.id) ? colors.brand : colors.textMuted,
                    }}
                  >
                    {mutedServerIds.has(s.id) ? <Icon.BellOff size={13} /> : <Icon.Bell size={13} />}
                  </button>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '16px' }}>
                  <div style={{
                    width: '48px', height: '48px', borderRadius: '12px', flexShrink: 0,
                    background: colorForName(s.name), display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: fontDisplay, fontWeight: 800, fontSize: '18px', color: '#fff',
                  }}>
                    {initialsForName(s.name)}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: fontDisplay, fontWeight: 700, fontSize: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
                    <div style={{ fontSize: '12px', color: colors.textMuted, marginTop: '2px' }}>{s.memberCount} member{s.memberCount === 1 ? '' : 's'} · {s.channelCount} room{s.channelCount === 1 ? '' : 's'}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <RoleBadge role={s.myRole} />
                  {s.isMember ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: 'auto' }}>
                      {s.myRole !== 'owner' && (
                        <button
                          className="pill-btn"
                          onClick={(e) => leaveServer(s, e)}
                          style={{ background: 'rgba(239, 68, 68, 0.1)', border: `1px solid rgba(239, 68, 68, 0.25)`, color: colors.danger, fontSize: '12px', fontWeight: 600, fontFamily: fontBody, cursor: 'pointer', padding: '7px 12px', borderRadius: '8px' }}
                        >
                          Leave
                        </button>
                      )}
                      <span className="pill-btn" style={{ fontSize: '12px', color: colors.text, fontWeight: 600, backgroundColor: colors.brand, border: 'none', padding: '8px 14px', borderRadius: '8px' }}>Open</span>
                    </div>
                  ) : (
                    <span className="pill-btn" style={{ fontSize: '12px', color: '#fff', fontWeight: 600, marginLeft: 'auto', backgroundColor: colors.online, border: 'none', padding: '8px 14px', borderRadius: '8px' }}>Join</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title={`Delete "${confirmDelete.name}"?`}
          body="This permanently deletes the server, its rooms, and every membership. This can't be undone."
          onConfirm={deleteServer}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {showJoin && (
        <>
          <div onClick={() => setShowJoin(false)} style={{ position: 'fixed', inset: 0, zIndex: 39, backgroundColor: 'rgba(0,0,0,0.7)', WebkitAppRegion: 'no-drag' }} />
          <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 40, width: '340px', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '16px', padding: '24px', boxShadow: '0 24px 60px rgba(0,0,0,0.8)', WebkitAppRegion: 'no-drag' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: '18px' }}>Join via Invite</h3>
            <p style={{ margin: '0 0 20px', fontSize: '13px', color: colors.textMuted }}>Paste the invite code someone shared with you.</p>
            <input
              className="modal-input"
              autoFocus
              placeholder="Invite code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && joinByInvite()}
              style={{ width: '100%', padding: '12px 14px', borderRadius: '10px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontMono, fontSize: '14px', boxSizing: 'border-box', marginBottom: '14px' }}
            />
            {joinError && <p style={{ color: colors.danger, fontSize: '13px', margin: '0 0 12px' }}>{joinError}</p>}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setShowJoin(false)} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={joinByInvite} disabled={joining} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: 'none', background: colors.brand, color: 'white', fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer', opacity: joining ? 0.7 : 1 }}>{joining ? 'Joining…' : 'Join'}</button>
            </div>
          </div>
        </>
      )}

      {showCreate && (
        <>
          <div onClick={() => setShowCreate(false)} style={{ position: 'fixed', inset: 0, zIndex: 39, backgroundColor: 'rgba(0,0,0,0.7)', WebkitAppRegion: 'no-drag' }} />
          <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 40, width: '340px', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '16px', padding: '24px', boxShadow: '0 24px 60px rgba(0,0,0,0.8)', WebkitAppRegion: 'no-drag' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: '18px' }}>Create a Server</h3>
            <p style={{ margin: '0 0 20px', fontSize: '13px', color: colors.textMuted }}>You'll be the owner, with a General room to start.</p>
            <input
              className="modal-input"
              autoFocus
              placeholder="Server name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createServer()}
              style={{ width: '100%', padding: '12px 14px', borderRadius: '10px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, fontSize: '14px', boxSizing: 'border-box', marginBottom: '18px' }}
            />
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setShowCreate(false)} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={createServer} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: 'none', background: colors.brand, color: 'white', fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>Create</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// MEMBERS / ROLES MODAL
// ============================================================================
function MembersModal({ authToken, serverId, myRole, onClose, onSelectUser }) {
  const api = useApi(authToken);
  const [members, setMembers] = useState([]);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(null);
  const canManage = myRole === 'owner' || myRole === 'admin';

  const load = () => api(`/servers/${serverId}/members`).then(setMembers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line

  const setRole = async (userId, role) => {
    try {
      await api(`/servers/${serverId}/members/${userId}/role`, { method: 'POST', body: JSON.stringify({ role }) });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const removeMember = async () => {
    const m = confirmRemove;
    setConfirmRemove(null);
    try {
      await api(`/servers/${serverId}/members/${m.userId}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 39, backgroundColor: 'rgba(0,0,0,0.7)', WebkitAppRegion: 'no-drag' }} />
      <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 40, width: '380px', maxHeight: '75vh', display: 'flex', flexDirection: 'column', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '16px', boxShadow: '0 24px 60px rgba(0,0,0,0.8)', WebkitAppRegion: 'no-drag' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${colors.border}` }}>
          <h3 style={{ margin: 0, fontSize: '18px' }}>Members</h3>
          <button onClick={onClose} className="icon-btn" style={{ border: 'none', background: 'transparent', color: colors.textMuted, cursor: 'pointer', display: 'flex' }}><Icon.X size={18} /></button>
        </div>
        <div className="scroll-thin" style={{ overflowY: 'auto', padding: '12px' }}>
          {error && <p style={{ color: colors.danger, fontSize: '13px', padding: '0 8px' }}>{error}</p>}
          {members.map((m) => (
            <div key={m.id} className="member-row" style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 8px', borderRadius: '10px' }}>
              <div onClick={() => onSelectUser?.(m)} style={{ width: '34px', height: '34px', borderRadius: '50%', background: m.avatarUrl ? 'transparent' : colorForName(m.username), overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '13px', color: '#fff', flexShrink: 0, cursor: 'pointer' }}>
                {m.avatarUrl ? <img src={m.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(m.username)}
              </div>
              <div onClick={() => onSelectUser?.(m)} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {m.username}
                  <UserBadges badges={m.badges} />
                </div>
                <StatusLine statusText={m.statusText} statusEmoji={m.statusEmoji} />
              </div>
              <RoleBadge role={m.role} />
              {canManage && m.role !== 'owner' && (
                <>
                  <select
                    value={m.role}
                    onChange={(e) => setRole(m.userId, e.target.value)}
                    style={{ backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: '8px', fontSize: '12px', fontFamily: fontBody, padding: '6px 8px' }}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    className="icon-btn row-delete"
                    onClick={() => setConfirmRemove(m)}
                    title="Remove from server"
                    style={{ border: 'none', background: 'transparent', color: colors.danger, cursor: 'pointer', display: 'flex', flexShrink: 0, padding: '4px' }}
                  >
                    <Icon.Trash size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {confirmRemove && (
        <ConfirmModal
          title={`Remove ${confirmRemove.username}?`}
          body="They'll lose access to this server and have to be invited or rejoin on their own."
          confirmLabel="Remove"
          onConfirm={removeMember}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </>
  );
}

// ============================================================================
// CREATE CHANNEL MODAL
// ============================================================================
function CreateChannelModal({ authToken, serverId, onCreated, onClose }) {
  const api = useApi(authToken);
  const [name, setName] = useState('');
  const [type, setType] = useState('voice'); // 'voice' | 'text'
  const [isEphemeral, setIsEphemeral] = useState(false); // 1. Added State
  const [error, setError] = useState('');

  const create = async () => {
    if (!name.trim()) return;
    try {
      // 2. Added isEphemeral to the API payload
      const channel = await api(`/servers/${serverId}/channels`, { 
        method: 'POST', 
        body: JSON.stringify({ name: name.trim(), type, isEphemeral }) 
      });
      onCreated(channel);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 39, backgroundColor: 'rgba(0,0,0,0.7)', WebkitAppRegion: 'no-drag' }} />
      <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 40, width: '320px', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '16px', padding: '24px', boxShadow: '0 24px 60px rgba(0,0,0,0.8)', WebkitAppRegion: 'no-drag' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: '18px' }}>New Channel</h3>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <button
            type="button"
            onClick={() => setType('text')}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '10px', borderRadius: '10px', border: `1px solid ${type === 'text' ? colors.brand : colors.border}`, background: type === 'text' ? colors.brandDim : 'transparent', color: type === 'text' ? colors.text : colors.textMuted, fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
          >
            <Icon.MessageCircle size={14} /> Text
          </button>
          <button
            type="button"
            onClick={() => setType('voice')}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '10px', borderRadius: '10px', border: `1px solid ${type === 'voice' ? colors.brand : colors.border}`, background: type === 'voice' ? colors.brandDim : 'transparent', color: type === 'voice' ? colors.text : colors.textMuted, fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
          >
            <Icon.Volume size={14} /> Voice
          </button>
          <button
            type="button"
            onClick={() => setType('focus')}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '10px', borderRadius: '10px', border: `1px solid ${type === 'focus' ? colors.brand : colors.border}`, background: type === 'focus' ? colors.brandDim : 'transparent', color: type === 'focus' ? colors.text : colors.textMuted, fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
          >
            <Icon.Clock size={14} /> Focus
          </button>
        </div>

        <input
          className="modal-input"
          autoFocus
          placeholder={type === 'text' ? 'Channel name' : 'Room name'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          style={{ width: '100%', padding: '12px 14px', borderRadius: '10px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, fontSize: '14px', boxSizing: 'border-box', marginBottom: '16px' }}
        />

        {/* 3. Added Ephemeral Checkbox UI */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: colors.textMuted, cursor: 'pointer', marginBottom: '16px' }}>
          <input
            type="checkbox"
            checked={isEphemeral}
            onChange={(e) => setIsEphemeral(e.target.checked)}
            style={{ width: '16px', height: '16px', accentColor: colors.brand, cursor: 'pointer', flexShrink: 0 }}
          />
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ color: colors.text, fontWeight: 500 }}>Ephemeral Room</span>
            <span style={{ fontSize: '11px' }}>{type === 'text' ? 'Messages auto-delete after 24 hours.' : 'Room deletes when everyone leaves.'}</span>
          </span>
        </label>

        {error && <p style={{ color: colors.danger, fontSize: '13px', margin: '0 0 12px' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={create} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: colors.brand, color: 'white', fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>Create</button>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// INVITE MODAL — create/copy/revoke shareable join links
// ============================================================================
function InviteModal({ authToken, serverId, onClose }) {
  const api = useApi(authToken);
  const [invites, setInvites] = useState([]);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState('');

  const load = () => api(`/servers/${serverId}/invites`).then(setInvites).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line

  const create = async () => {
    try {
      const invite = await api(`/servers/${serverId}/invites`, { method: 'POST', body: JSON.stringify({}) });
      setInvites((prev) => [invite, ...prev]);
    } catch (e) {
      setError(e.message);
    }
  };

  const revoke = async (id) => {
    try {
      await api(`/servers/${serverId}/invites/${id}`, { method: 'DELETE' });
      setInvites((prev) => prev.filter((i) => i.id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  const copy = (invite) => {
    navigator.clipboard?.writeText(invite.code).catch(() => {});
    setCopiedId(invite.id);
    setTimeout(() => setCopiedId(''), 1500);
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 39, backgroundColor: 'rgba(0,0,0,0.7)' }} />
      <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 40, width: '400px', maxHeight: '70vh', display: 'flex', flexDirection: 'column', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '16px', padding: '24px', boxShadow: '0 24px 60px rgba(0,0,0,0.8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
          <h3 style={{ margin: 0, fontSize: '18px' }}>Invite People</h3>
          <button onClick={onClose} className="icon-btn" style={{ border: 'none', background: 'transparent', color: colors.textFaint, cursor: 'pointer', display: 'flex' }}><Icon.X size={18} /></button>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: '13px', color: colors.textMuted }}>Share a code — anyone with it can join this server.</p>

        <button onClick={create} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '11px', borderRadius: '10px', border: 'none', background: colors.brand, color: 'white', fontFamily: fontDisplay, fontWeight: 700, fontSize: '13.5px', cursor: 'pointer', marginBottom: '16px' }}>
          <Icon.Plus size={14} /> Generate New Invite
        </button>

        {error && <p style={{ color: colors.danger, fontSize: '13px', margin: '0 0 12px' }}>{error}</p>}

        <div className="scroll-thin" style={{ overflowY: 'auto', flex: 1 }}>
          {invites.length === 0 && <p style={{ color: colors.textFaint, fontSize: '13px' }}>No active invites yet.</p>}
          {invites.map((inv) => (
            <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '10px', border: `1px solid ${colors.borderSoft}`, marginBottom: '8px' }}>
              <span style={{ flex: 1, fontFamily: fontMono, fontSize: '13.5px', fontWeight: 700, color: colors.brand, letterSpacing: '0.03em' }}>{inv.code}</span>
              <span style={{ fontSize: '11px', color: colors.textFaint, fontFamily: fontMono }}>{inv.uses}{inv.maxUses ? `/${inv.maxUses}` : ''} used</span>
              <button onClick={() => copy(inv)} className="icon-btn" style={{ border: 'none', background: 'transparent', color: copiedId === inv.id ? colors.online : colors.textMuted, cursor: 'pointer', display: 'flex' }} title="Copy code">
                {copiedId === inv.id ? <Icon.Check size={14} /> : <Icon.Link size={14} />}
              </button>
              <button onClick={() => revoke(inv.id)} className="icon-btn" style={{ border: 'none', background: 'transparent', color: colors.danger, cursor: 'pointer', display: 'flex' }} title="Revoke">
                <Icon.Trash size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ============================================================================
// VOICE: status dock
// ============================================================================
function VoiceStatusDock({ roomName, deafened, onToggleDeafen, onToggleMic, soundboardOpen, onToggleSoundboard, dockAnchor }) {
  const { isMicrophoneEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const [ping, setPing] = useState(null);

  useEffect(() => {
    const handlePong = (sentAt) => setPing(Date.now() - sentAt);
    socket.on('pong_check', handlePong);
    const sendPing = () => socket.emit('ping_check', Date.now());
    sendPing();
    const interval = setInterval(sendPing, 3000);
    return () => { clearInterval(interval); socket.off('pong_check', handlePong); };
  }, []);

  const pingColor = ping == null ? colors.textFaint : ping < 100 ? colors.online : ping < 250 ? colors.speak : colors.danger;

  // Small, borderless icon buttons — sit on the same surface as the dock itself, no black fill.
  const iconBtnStyle = (isOn, iconColor) => ({
    flex: 1, height: '34px', borderRadius: '9px', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: isOn ? colors.brandDim : 'transparent',
    color: iconColor || (isOn ? colors.brand : colors.textMuted),
    transition: 'background-color 0.15s, color 0.15s',
  });

  const content = (
    <div className="dock" style={{ width: '100%', backgroundColor: colors.panel, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '10px', WebkitAppRegion: 'no-drag' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.online, flexShrink: 0, animation: 'pulseGlow 2s infinite' }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '12.5px', fontWeight: 700, color: colors.online, lineHeight: 1.2 }}>Voice Connected</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, marginTop: '3px' }}>
            <span style={{ fontSize: '12px', color: colors.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{roomName}</span>
            <span style={{ fontSize: '11px', fontWeight: 700, color: pingColor, flexShrink: 0 }}>· {ping == null ? '…' : `${ping}ms`}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '4px' }}>
        <button className="icon-btn" onClick={onToggleMic} style={iconBtnStyle(false, isMicrophoneEnabled ? colors.textMuted : colors.danger)} aria-label="Toggle microphone" title={isMicrophoneEnabled ? "Mute" : "Unmute"}>
          {isMicrophoneEnabled ? <Icon.Mic size={16} /> : <Icon.MicOff size={16} />}
        </button>
        <button className="icon-btn" onClick={onToggleDeafen} style={iconBtnStyle(false, deafened ? colors.danger : colors.textMuted)} aria-label="Toggle deafen" title={deafened ? "Undeafen" : "Deafen"}>
          {deafened ? <Icon.HeadphonesOff size={16} /> : <Icon.Headphones size={16} />}
        </button>
        <button className="icon-btn" onClick={onToggleSoundboard} style={iconBtnStyle(soundboardOpen)} aria-label="Toggle soundboard" title="Soundboard">
          <Icon.Radio size={16} />
        </button>
        <button className="icon-btn" onClick={() => room?.disconnect()} style={{ flex: 1, height: '34px', borderRadius: '9px', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(239, 68, 68, 0.15)', color: colors.danger }} aria-label="Disconnect" title="Disconnect">
          <Icon.PhoneOff size={16} />
        </button>
      </div>
    </div>
  );

  // Rendered via a portal into an anchor sitting right above the account bar in the
  // sidebar, so it reads as one connected surface instead of a floating card.
  if (!dockAnchor) return null;
  return createPortal(content, dockAnchor);
}

// ============================================================================
// VOICE: Spectral denoiser (AudioWorklet)
// ----------------------------------------------------------------------------
// The gate+EQ approach only mutes noise between words. This is a proper
// FFT-based noise suppressor (spectral subtraction): it continuously learns
// the noise floor per frequency bin and subtracts it out in real time, which
// is the same family of technique real noise-suppression tools use — this is
// a hand-rolled DSP version rather than a trained ML model like Krisp, but it
// runs on every incoming track, not just your own mic, and is far stronger
// than a simple gate. It runs in an AudioWorklet (its own audio thread), so
// it can't stall the UI or reintroduce the glitching from before.
const DENOISE_WORKLET_SOURCE = `
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const tRe = re[i + j + half] * curWr - im[i + j + half] * curWi;
        const tIm = re[i + j + half] * curWi + im[i + j + half] * curWr;
        re[i + j] = uRe + tRe; im[i + j] = uIm + tIm;
        re[i + j + half] = uRe - tRe; im[i + j + half] = uIm - tIm;
        const nWr = curWr * wr0 - curWi * wi0;
        const nWi = curWr * wi0 + curWi * wr0;
        curWr = nWr; curWi = nWi;
      }
    }
  }
}
function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fftSize = 1024;
    this.hop = this.fftSize / 2;

    this.window = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.fftSize - 1));
    }

    this.prevRaw = new Float32Array(this.hop);
    this.curRaw = new Float32Array(this.hop);
    this.curFill = 0;
    this.outputCarry = new Float32Array(this.hop);

    this.re = new Float32Array(this.fftSize);
    this.im = new Float32Array(this.fftSize);

    this.numBins = this.fftSize / 2 + 1;
    this.noiseFloor = new Float32Array(this.numBins).fill(0.0008);

    this.strength = 1.4;
    this.gateFloor = 0.08;
    this.enabled = true;

    this.fifo = new Float32Array(this.hop * 4);
    this.fifoWrite = 0;
    this.fifoRead = 0;
    this.fifoCount = 0;

    this.port.onmessage = (e) => {
      if (typeof e.data.strength === 'number') this.strength = e.data.strength;
      if (typeof e.data.enabled === 'boolean') this.enabled = e.data.enabled;
    };
  }

  pushOutput(arr) {
    for (let i = 0; i < arr.length; i++) {
      this.fifo[this.fifoWrite] = arr[i];
      this.fifoWrite = (this.fifoWrite + 1) % this.fifo.length;
      if (this.fifoCount < this.fifo.length) this.fifoCount++;
    }
  }

  popOutput(n, out) {
    for (let i = 0; i < n; i++) {
      if (this.fifoCount > 0) {
        out[i] = this.fifo[this.fifoRead];
        this.fifoRead = (this.fifoRead + 1) % this.fifo.length;
        this.fifoCount--;
      } else {
        out[i] = 0;
      }
    }
  }

  runFrame() {
    for (let i = 0; i < this.hop; i++) {
      this.re[i] = this.prevRaw[i] * this.window[i];
      this.im[i] = 0;
      this.re[this.hop + i] = this.curRaw[i] * this.window[this.hop + i];
      this.im[this.hop + i] = 0;
    }

    fft(this.re, this.im);

        if (!this.rawGain) this.rawGain = new Float32Array(this.numBins);
    if (!this.smoothGain) this.smoothGain = new Float32Array(this.numBins).fill(1);

    for (let k = 0; k < this.numBins; k++) {
      const re = this.re[k], im = this.im[k];
      const mag = Math.sqrt(re * re + im * im);

      if (mag < this.noiseFloor[k]) this.noiseFloor[k] = mag;
      else this.noiseFloor[k] += (mag - this.noiseFloor[k]) * 0.05;

      let gain = 1;
      if (this.enabled) {
        const target = Math.max(mag - this.strength * this.noiseFloor[k], this.gateFloor * mag);
        gain = mag > 1e-8 ? target / mag : 1;
      }
      this.rawGain[k] = gain;
    }

    // Smooth gain across neighboring bins + across time. Without this,
    // isolated bins jump gain independently frame to frame — that's what
    // produces the metallic/"electric" musical-noise artifact.
    for (let k = 0; k < this.numBins; k++) {
      const prev = k > 0 ? this.rawGain[k - 1] : this.rawGain[k];
      const next = k < this.numBins - 1 ? this.rawGain[k + 1] : this.rawGain[k];
      const smoothed = (prev + this.rawGain[k] * 2 + next) / 4;
      this.smoothGain[k] += (smoothed - this.smoothGain[k]) * 0.5;
    }

    for (let k = 0; k < this.numBins; k++) {
      const gain = this.smoothGain[k];
      this.re[k] *= gain;
      this.im[k] *= gain;
      if (k > 0 && k < this.fftSize / 2) {
        const mirror = this.fftSize - k;
        this.re[mirror] = this.re[k];
        this.im[mirror] = -this.im[k];
      }
    }

    ifft(this.re, this.im);

    const out = new Float32Array(this.hop);
    for (let i = 0; i < this.hop; i++) {
      out[i] = this.outputCarry[i] + this.re[i] * this.window[i] * (2 / 3);
    }
    for (let i = 0; i < this.hop; i++) {
      this.outputCarry[i] = this.re[this.hop + i] * this.window[this.hop + i] * (2 / 3);
    }

    this.pushOutput(out);
    this.prevRaw.set(this.curRaw);
    this.curFill = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }

    for (let i = 0; i < input.length; i++) {
      this.curRaw[this.curFill++] = input[i];
      if (this.curFill === this.hop) this.runFrame();
    }
    this.popOutput(output.length, output);
    return true;
  }
}
registerProcessor('denoise-processor', DenoiseProcessor);
`;

let denoiseWorkletUrl = null;
function getDenoiseWorkletUrl() {
  if (!denoiseWorkletUrl) {
    const blob = new Blob([DENOISE_WORKLET_SOURCE], { type: 'application/javascript' });
    denoiseWorkletUrl = URL.createObjectURL(blob);
  }
  return denoiseWorkletUrl;
}

// ============================================================================
// TELESTRATOR CANVAS (Multiplayer Drawing)
// ============================================================================
export function TelestratorCanvas({ channelId, trackSid, isScreenShare }) {
  const canvasRef = useRef(null);
  const [isShiftDown, setIsShiftDown] = useState(false);
  const strokesRef = useRef(new Map());
  const currentStrokeId = useRef(null);
  const myColor = colors.danger; // Drawing color

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Shift') setIsShiftDown(true); };
    const onKeyUp = (e) => { if (e.key === 'Shift') setIsShiftDown(false); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, []);

  useEffect(() => {
    const onDraw = (data) => {
      if (data.channelId !== channelId || data.trackSid !== trackSid) return;
      if (!strokesRef.current.has(data.strokeId)) {
        strokesRef.current.set(data.strokeId, { color: data.color, points: [] });
      }
      strokesRef.current.get(data.strokeId).points.push(data.pt);
    };
    socket.on('telestrator_draw', onDraw);
    return () => socket.off('telestrator_draw', onDraw);
  }, [channelId, trackSid]);

  useEffect(() => {
    let raf;
    const render = () => {
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx || !canvasRef.current) return;
      const w = canvasRef.current.width;
      const h = canvasRef.current.height;
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 5;

      const now = Date.now();
      strokesRef.current.forEach((stroke, id) => {
        stroke.points = stroke.points.filter(p => now - p.ts < 3000); // 3 second fade
        if (stroke.points.length === 0) {
          strokesRef.current.delete(id);
          return;
        }
        
        ctx.beginPath();
        stroke.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x * w, p.y * h);
          else ctx.lineTo(p.x * w, p.y * h);
        });
        
        const latestTs = stroke.points[stroke.points.length - 1].ts;
        const alpha = Math.max(0, 1 - (now - latestTs) / 3000);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = stroke.color;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      });
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  const handlePointerDown = (e) => {
    if (!isShiftDown) return;
    currentStrokeId.current = Math.random().toString(36).substr(2, 9);
    handlePointerMove(e);
  };

  const handlePointerMove = (e) => {
    if (!isShiftDown || e.buttons !== 1 || !currentStrokeId.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const pt = { x, y, ts: Date.now() };

    if (!strokesRef.current.has(currentStrokeId.current)) {
      strokesRef.current.set(currentStrokeId.current, { color: myColor, points: [] });
    }
    strokesRef.current.get(currentStrokeId.current).points.push(pt);
    socket.emit('telestrator_draw', { channelId, trackSid, pt, strokeId: currentStrokeId.current, color: myColor });
  };

  if (!isScreenShare) return null;

  return (
    <canvas
      ref={canvasRef}
      width={1280} height={720}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: isShiftDown ? 'auto' : 'none', zIndex: 10,
        cursor: isShiftDown ? 'crosshair' : 'default'
      }}
    />
  );
}

// ============================================================================
// PiP View (Rendered in separate floating window)
// ============================================================================
export function PiPView({ token, trackSid, channelId }) {
  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', backgroundColor: 'transparent', borderRadius: '12px' }}>
      <LiveKitRoom token={token} serverUrl={serverUrl} video={false} audio={false}>
        <PiPRenderer trackSid={trackSid} channelId={channelId} />
      </LiveKitRoom>
    </div>
  );
}

function PiPRenderer({ trackSid, channelId }) {
  const tracks = useTracks();
  const target = tracks.find(t => t.publication.trackSid === trackSid);
  
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', borderRadius: '12px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.5)' }}>
      {target && <VideoTrack trackRef={target} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
      <TelestratorCanvas channelId={channelId} trackSid={trackSid} isScreenShare={true} />
    </div>
  );
}

// ============================================================================
export function SmartAudioLeveler({ deafened, levelerEnabled, speakerDeviceId, voiceSettings, remoteVolumes, username, remotePositions = {} }) {
  const micTracks = useTracks([Track.Source.Microphone], { onlySubscribed: true });
  const screenAudioTracks = useTracks([Track.Source.ScreenShareAudio], { onlySubscribed: true });
  const ctxRef = useRef(null);
  const chainsRef = useRef(new Map());

  const masterRef = useRef(null);
  const [workletReady, setWorkletReady] = useState(false);

  const getCtx = () => {
    // FIX 1: If the context is dead/closed from a previous render, create a fresh one
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      // RNNoise is trained on 48kHz audio and doesn't correct for a mismatch —
      // running the context at your hardware's default rate (often 44.1kHz)
      // makes it noticeably worse at separating voice from noise.
      ctxRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    }
    if (ctxRef.current.state === 'suspended') ctxRef.current.resume().catch(() => {});

    if (ctxRef.current.setSinkId && speakerDeviceId !== undefined) {
      ctxRef.current.setSinkId(speakerDeviceId || '').catch(() => {});
    }

    if (!masterRef.current || masterRef.current.ctx !== ctxRef.current || !masterRef.current.reverbGain) {
      const masterLimiter = ctxRef.current.createDynamicsCompressor();
      masterLimiter.threshold.value = -3;
      masterLimiter.knee.value = 0;
      masterLimiter.ratio.value = 20;
      masterLimiter.attack.value = 0.002;
      masterLimiter.release.value = 0.15;
      
      const masterGain = ctxRef.current.createGain();
      masterGain.gain.value = 1;
      
      // Parallel routing for the Reverb effect
      const convolver = ctxRef.current.createConvolver();
      const reverbGain = ctxRef.current.createGain();
      reverbGain.gain.value = 0; 
      
      masterLimiter.connect(masterGain);
      masterGain.connect(ctxRef.current.destination);
      
      masterLimiter.connect(convolver);
      convolver.connect(reverbGain);
      reverbGain.connect(ctxRef.current.destination);

      masterRef.current = { 
        ctx: ctxRef.current, input: masterLimiter, gain: masterGain, 
        convolver, reverbGain, currentPreset: null 
      };
    }

    return ctxRef.current;
  };

  const rnnoiseWasmRef = useRef(null);
  useEffect(() => {
    const ctx = getCtx();
    (async () => {
      try {
        rnnoiseWasmRef.current = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseWasmSimdPath });
         await ctx.audioWorklet.addModule(rnnoiseWorkletPath);
        await ctx.audioWorklet.addModule(noiseGateWorkletPath); // add this line
        setWorkletReady(true);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('RNNoise worklet failed to load — falling back to filter/gate only:', err);
      }
    })();
  }, []);

  useEffect(() => {
    if (ctxRef.current && ctxRef.current.setSinkId && speakerDeviceId !== undefined) {
      ctxRef.current.setSinkId(speakerDeviceId || '').catch(() => {});
    }
  }, [speakerDeviceId]);

  useEffect(() => {
    const resume = () => { if (ctxRef.current?.state === 'suspended') ctxRef.current.resume().catch(() => {}); };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    return () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
  }, []);

  useEffect(() => () => {
    chainsRef.current.forEach((chain) => { 
      try { chain.gate.onaudioprocess = null; } catch (e) {}
      try { chain.declicker.onaudioprocess = null; } catch (e) {}
      [chain.source, chain.monoInput, chain.highpass, chain.lowpass, chain.declicker, chain.denoiseNode, chain.noiseGateNode, chain.gate]
        .filter(Boolean)
        .forEach((node) => { try { node.disconnect(); } catch (e) {} });
      try { chain.dummyAudio.srcObject = null; } catch (e) {}
    });
    chainsRef.current.clear();
    masterRef.current = null;
    if (ctxRef.current) {
      ctxRef.current.close().catch(() => {});
      // FIX 3: Nullify the reference so it clears from memory on unmount
      ctxRef.current = null;
    }
  }, []);


  useEffect(() => {
    const ctx = getCtx();
    const liveTracks = [...micTracks, ...screenAudioTracks];
    const liveSids = new Set();

    liveTracks.forEach((t) => {

      if (t.participant.isLocal) return;

      const pub = t.publication;
      const mst = pub?.track?.mediaStreamTrack;
      if (!pub || !mst) return;
      liveSids.add(pub.trackSid);

      let chain = chainsRef.current.get(pub.trackSid);

      // The worklet may not have finished loading yet when a track first
      // shows up. Once it's ready, rebuild any chain that was built without
      // it so every track ends up with real denoising, not just the filter/gate.
      if (chain && workletReady && !chain.hasDenoise) {
        try { chain.gate.onaudioprocess = null; } catch (e) {}
        try { chain.declicker.onaudioprocess = null; } catch (e) {}
        [chain.source, chain.monoInput, chain.highpass, chain.lowpass, chain.declicker, chain.denoiseNode, chain.noiseGateNode, chain.gate, chain.compressor, chain.makeupGain, chain.limiter, chain.outputGain]
          .filter(Boolean)
          .forEach((node) => { try { node.disconnect(); } catch (e) {} });
        chainsRef.current.delete(pub.trackSid);
        chain = null;
      }

      if (!chain) {
        // Screen-share audio is someone's raw system/game audio, not their
        // voice — it's already far louder and more full-range than a mic
        // signal. Running it through the same voice-tuned +5dB makeup gain
        // and hard limiter as a microphone is what turned it into crackling
        // noise. Give it its own, much gentler settings instead.
        const isScreenAudio = t.source === Track.Source.ScreenShareAudio;

        try {
          const stream = new MediaStream([mst]);

          // CRITICAL FIX: Chromium silently drops WebRTC audio unless it's attached to an HTML element
          const dummyAudio = new Audio();
          dummyAudio.srcObject = stream;
          dummyAudio.muted = true; // We mute this because the Web Audio graph handles the real sound
          dummyAudio.play().catch((err) => console.warn('Audio element playback failed for', pub.trackSid, err));

          const source = ctx.createMediaStreamSource(stream);
          // Remote tracks can briefly arrive with an uneven stereo layout when
          // someone joins. Downmix before processing so center pan is truly centered.
          const monoInput = ctx.createGain();
          monoInput.channelCount = 1;
          monoInput.channelCountMode = 'explicit';
          monoInput.channelInterpretation = 'speakers';

          // SPEAKER-SIDE NOISE FILTER: Krisp only cleans up your own outgoing
          // mic before it's sent — it does nothing for what you *receive*, so
          // background hum/hiss/fan noise from the other end was still coming
          // through untouched. This adds real filtering on that incoming path.
          const highpass = ctx.createBiquadFilter();
          highpass.type = 'highpass';
          highpass.frequency.value = 110; // cuts low rumble/hum/background voices (fans, AC, desk bumps)

          const lowpass = ctx.createBiquadFilter();
          lowpass.type = 'lowpass';
          lowpass.frequency.value = isScreenAudio ? 11000 : 7500; // trims hiss and background voices above the voice band

          // CLICK/TRANSIENT SUPPRESSOR: mouse clicks, keyboard clacks, desk
          // taps, etc. are sharp, very short broadband spikes — the FFT
          // denoiser below can't remove them (they're far louder than the
          // noise floor it tracks), and worse, its ~21ms analysis window
          // smears a 2ms click across that whole window, turning a short
          // click into an audible crackle. So this catches it here, in the
          // time domain, sample-by-sample, before it ever reaches the FFT.
          // It compares a near-instant envelope against a slower "normal
          // level" envelope — a sudden spike well above the recent normal
          // level gets ducked hard for a few milliseconds, then recovers.
          const declicker = ctx.createScriptProcessor(2048, 1, 1);
          const declickState = { fastEnv: 0, slowEnv: 0, duck: 1 };
          declicker.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            const output = e.outputBuffer.getChannelData(0);
            for (let i = 0; i < input.length; i++) {
              const abs = Math.abs(input[i]);
              declickState.fastEnv += (abs - declickState.fastEnv) * 0.18;
              declickState.slowEnv += (abs - declickState.slowEnv) * 0.003;

              const isClick =
                abs > 0.7 &&
                declickState.fastEnv > 0.2 &&
                declickState.fastEnv > declickState.slowEnv * 9 &&
                declickState.slowEnv < 0.05;

              const target = isClick ? 0.28 : 1;
              const speed = target < declickState.duck ? 0.22 : 0.05;
              declickState.duck += (target - declickState.duck) * speed;
              output[i] = input[i] * declickState.duck;
            }
          };

          // Real FFT-based noise suppression (spectral subtraction) — this is
          // the strong pass. It learns the noise floor per frequency and
          // subtracts it out continuously, rather than just muting between
          // words. Runs mono; screen-share/system audio gets summed to mono
          // for this stage, which is the right trade for voice clarity.
          let denoiseNode = null;
          if (workletReady && rnnoiseWasmRef.current) {
            denoiseNode = new RnnoiseWorkletNode(ctx, {
              wasmBinary: rnnoiseWasmRef.current,
              maxChannels: 1,
            });
          }

           const noiseGateNode = workletReady ? new NoiseGateWorkletNode(ctx, {
            openThreshold: -32,
            closeThreshold: -54,
            holdMs: 320,
            maxChannels: 1,
          }) : null;

          // Adaptive noise gate: ducks the signal during gaps between words,
          // which is where constant background noise is most noticeable.
          // Runs after the spectral denoiser as a second, cheap pass to clean
          // up whatever residual is left.
                const gate = ctx.createScriptProcessor(2048, 1, 1);
      const gateState = { envelope: 0, gain: 1, floor: 0.18 };
      gate.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const output = e.outputBuffer.getChannelData(0);
        const threshold = isScreenAudio ? 0.016 : 0.012;
        for (let i = 0; i < input.length; i++) {
          const abs = Math.abs(input[i]);
          gateState.envelope += (abs - gateState.envelope) * 0.0017;
          const target = gateState.envelope > threshold ? 1 : gateState.floor;
          const speed = target > gateState.gain ? 0.05 : 0.015;
          gateState.gain += (target - gateState.gain) * speed;
          output[i] = input[i] * gateState.gain;
        }
      };

          const compressor = ctx.createDynamicsCompressor();
compressor.threshold.value = isScreenAudio ? -20 : -28;
compressor.knee.value = 12;
compressor.ratio.value = isScreenAudio ? 2.8 : 5.5;
compressor.attack.value = 0.002;
compressor.release.value = 0.2;

const makeupGain = ctx.createGain();
makeupGain.gain.value = isScreenAudio ? 1 : 1.12;

          const limiter = ctx.createDynamicsCompressor();
          limiter.threshold.value = -5;
          limiter.knee.value = 0;
          limiter.ratio.value = 20;
          limiter.attack.value = 0.001;
          limiter.release.value = 0.08;

          const outputGain = ctx.createGain();

          source.connect(monoInput);
          monoInput.connect(highpass);
          highpass.connect(lowpass);
          if (isScreenAudio) {
            lowpass.connect(declicker);
            if (denoiseNode && noiseGateNode) {
              declicker.connect(denoiseNode);
              denoiseNode.connect(noiseGateNode);
              noiseGateNode.connect(compressor);
            } else if (denoiseNode) {
              declicker.connect(denoiseNode);
              denoiseNode.connect(gate);
            } else {
              declicker.connect(gate);
            }
          } else if (denoiseNode && noiseGateNode) {
            lowpass.connect(denoiseNode);
            denoiseNode.connect(noiseGateNode);
            noiseGateNode.connect(compressor);
          } else if (denoiseNode) {
            lowpass.connect(denoiseNode);
            denoiseNode.connect(gate);
          } else {
            lowpass.connect(gate);
          }
          gate.connect(compressor);
          compressor.connect(makeupGain);
          makeupGain.connect(limiter);
          
                   const panner = ctx.createStereoPanner();

          limiter.connect(outputGain);
          outputGain.connect(panner);
          panner.connect(masterRef.current.input);

          chain = { source, monoInput, highpass, lowpass, declicker, declickState, denoiseNode, noiseGateNode, hasDenoise: !!denoiseNode, gate, gateState, compressor, makeupGain, limiter, outputGain, panner, dummyAudio, isScreenAudio };          chainsRef.current.set(pub.trackSid, chain);
        
        } catch (err) {
          console.error('Failed to set up audio chain for track', pub.trackSid, err);
          return;
        }
      }

// Apply custom mixer settings dynamically
      const mix = voiceSettings?.mixerOverrides?.[t.participant.identity] || {};
      
      // Get YOUR local volume preference for them
      const personalMixVolume = chain.isScreenAudio ? (mix.stream ?? 1) : (mix.voice ?? 1);
      
      // Get THEIR requested global input volume
      const theirInputVolume = remoteVolumes?.[t.participant.identity] ?? 1;
      
      // Stack them together based on relative distance
      let pan = 0;
      let spatialFalloff = 1;

      if (voiceSettings?.spatialAudioEnabled) {
        const myPos = voiceSettings?.roomPositions?.[username] || { x: 0, y: 0 };
        const theirPos = remotePositions[t.participant.identity] || voiceSettings?.roomPositions?.[t.participant.identity] || { x: 0, y: -0.45 };
        
        const dx = theirPos.x - myPos.x;
        const dy = theirPos.y - myPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // Panning is based strictly on horizontal separation
        pan = Math.max(-0.8, Math.min(0.8, dx * 0.7));
        // Falloff is linear based on distance, dropping heavily across zones
        spatialFalloff = Math.max(0.1, 1 - (dist * 0.55));
      }

      // Whisper/Huddle Overrides
      if (voiceSettings?.huddleTarget) {
        if (t.participant.identity === voiceSettings.huddleTarget) {
          spatialFalloff = 1; // Full volume for whispered target
          pan = 0; // Center them perfectly in your ears
        } else {
          spatialFalloff = 0.03; // Severely duck everyone else
        }
      }

      const targetVolume = personalMixVolume * theirInputVolume * spatialFalloff;

      chain.panner.pan.value = pan;
      chain.outputGain.gain.value = deafened ? 0 : targetVolume;
      chain.highpass.frequency.value = mix.bassCut || 90; // Adjust bass
      chain.lowpass.frequency.value = mix.trebleCut || 8000; // Adjust treble

      if (levelerEnabled) {
  chain.compressor.ratio.value = chain.isScreenAudio ? 3 : 4; // Lowered from 8
  chain.makeupGain.gain.value = chain.isScreenAudio ? 1 : 1.1; // Lowered from 1.8
  
  chain.limiter.ratio.value = 20;
  chain.gateState.floor = chain.isScreenAudio ? 0.10 : 0.02; // Keep fallback suppression gentle enough for word endings
} else {
        chain.compressor.ratio.value = 1;
        chain.makeupGain.gain.value = 1;
        chain.limiter.ratio.value = 1;
        chain.gateState.floor = 1; // gate fully open — no gating applied
      }
    });

    chainsRef.current.forEach((chain, sid) => {
      if (!liveSids.has(sid)) {
        try { chain.gate.onaudioprocess = null; } catch (e) {}
        try { chain.declicker.onaudioprocess = null; } catch (e) {}
        [chain.source, chain.monoInput, chain.highpass, chain.lowpass, chain.declicker, chain.denoiseNode, chain.noiseGateNode, chain.gate, chain.compressor, chain.makeupGain, chain.limiter, chain.outputGain]
          .filter(Boolean)
          .forEach((node) => { try { node.disconnect(); } catch (e) {} });
        try { chain.dummyAudio.srcObject = null; } catch(e) {}
        chainsRef.current.delete(sid);
      }
    });

    if (masterRef.current) {
      const preset = voiceSettings?.roomReverb;
      if (preset && preset !== masterRef.current.currentPreset) {
         masterRef.current.currentPreset = preset;
         // Generate the synthetic space environment 
         if (preset === 'bathroom') masterRef.current.convolver.buffer = createReverbImpulse(ctxRef.current, 0.4, 2);
         else if (preset === 'stadium') masterRef.current.convolver.buffer = createReverbImpulse(ctxRef.current, 2.5, 3);
         else if (preset === 'void') masterRef.current.convolver.buffer = createReverbImpulse(ctxRef.current, 6.0, 5);
      }
      
      const targetReverbLevel = preset ? (preset === 'bathroom' ? 0.35 : preset === 'stadium' ? 0.25 : 0.4) : 0;
      if (masterRef.current.reverbGain) {
        masterRef.current.reverbGain.gain.setTargetAtTime(targetReverbLevel, ctxRef.current.currentTime, 0.1);
      }
    }
  }, [micTracks, screenAudioTracks, deafened, levelerEnabled, workletReady, voiceSettings?.roomReverb, voiceSettings?.huddleTarget]);

  return null;
}
// ============================================================================
// VOICE: Soundboard
// ============================================================================
function SoundboardDock({ serverId, channelId, authToken, username, voiceSettings, onVoiceSettingsChange, canManage }) {
  const participants = useParticipants();
  const [clips, setClips] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const mutedSenders = voiceSettings.mutedSoundboardSenders || [];
  const soundboardMuted = !!voiceSettings.soundboardMuted;
  const soundboardVolume = voiceSettings.soundboardVolume ?? 0.8;

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/servers/${serverId}/soundboard`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setClips(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [serverId, authToken]);

  const playLocally = useCallback((clip) => {
    if (soundboardMuted) return;
    const url = clip.url.startsWith('http') ? clip.url : `${API_BASE}${clip.url}`;
    const audio = new Audio(url);
    audio.volume = soundboardVolume;
    audio.play().catch(() => {});
  }, [soundboardMuted, soundboardVolume]);

  useEffect(() => {
    const handler = (payload) => {
      if (!payload || payload.channelId !== channelId) return;
      if (mutedSenders.includes(payload.sender)) return;
      playLocally(payload);
    };
    socket.on('play_soundboard', handler);
    return () => socket.off('play_soundboard', handler);
  }, [channelId, mutedSenders, playLocally]);

  const trigger = (clip) => {
    if (!channelId || !canManage) return;
    const payload = { channelId, clipId: clip.id, name: clip.name, url: clip.url, sender: username };
    socket.emit('play_soundboard', payload);
    playLocally(payload);
    // Drive the shared "now playing" bar for everyone in the room. No easy way
    // to know the exact clip duration without loading it up front, so we clear
    // it after a generous fallback window — short soundboard clips easily fit.
    socket.emit('now_playing_update', { channelId, title: clip.name, sender: username, isPlaying: true });
    setTimeout(() => {
      socket.emit('now_playing_update', { channelId, title: null });
    }, 6000);
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^audio\/(mpeg|mp3)$/.test(file.type)) { setError('Only MP3 clips are supported.'); e.target.value = ''; return; }
    if (file.size > 2 * 1024 * 1024) { setError('Keep clips under 2MB.'); e.target.value = ''; return; }
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', file.name.replace(/\.mp3$/i, ''));
      const res = await fetch(`${API_BASE}/servers/${serverId}/soundboard`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      setClips((prev) => [...prev, data]);
    } catch (err) {
      setError(err.message || 'Upload failed.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const toggleMuteSoundboard = () => onVoiceSettingsChange({ ...voiceSettings, soundboardMuted: !soundboardMuted });
  const setVolume = (v) => onVoiceSettingsChange({ ...voiceSettings, soundboardVolume: v });
  const toggleSenderMuted = (identity) => {
    const next = mutedSenders.includes(identity) ? mutedSenders.filter((u) => u !== identity) : [...mutedSenders, identity];
    onVoiceSettingsChange({ ...voiceSettings, mutedSoundboardSenders: next });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: '4px 0 12px', borderBottom: `1px solid ${colors.borderSoft}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Icon.Volume size={14} color={colors.textMuted} />
        <input type="range" min="0" max="1" step="0.02" value={soundboardVolume} onInput={(e) => setVolume(Number(e.target.value))} style={{ flex: 1, accentColor: colors.brand, cursor: 'pointer' }} disabled={soundboardMuted} />
        <button className="icon-btn" onClick={toggleMuteSoundboard} title={soundboardMuted ? 'Unmute soundboard' : 'Mute soundboard'} style={{ border: 'none', background: 'transparent', color: soundboardMuted ? colors.danger : colors.textMuted, cursor: 'pointer', display: 'flex' }}>
          {soundboardMuted ? <Icon.HeadphonesOff size={16} /> : <Icon.Headphones size={16} />}
        </button>
      </div>

      <div className="scroll-thin" style={{ flex: 1, overflowY: 'auto', padding: '8px 0', minHeight: '140px' }}>
        {error && <p style={{ margin: '4px 0', color: colors.danger, fontSize: '12px', fontWeight: 500 }}>{error}</p>}
        {clips.length === 0 && <p style={{ margin: '10px 0', color: colors.textFaint, fontSize: '12px' }}>No clips yet.</p>}
        {clips.map((clip) => (
          <button
            key={clip.id}
            onClick={() => trigger(clip)}
            className="channel-row"
            disabled={!canManage}
            style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 10px', borderRadius: '9px', border: 'none', background: 'transparent', color: canManage ? colors.text : colors.textFaint, fontSize: '13px', fontWeight: 500, cursor: canManage ? 'pointer' : 'default', marginBottom: '4px' }}
          >
            <Icon.Volume size={13} color={canManage ? colors.brand : colors.textFaint} /> {clip.name}
          </button>
        ))}
      </div>

      {canManage && (
        <div style={{ paddingTop: '10px', borderTop: `1px solid ${colors.borderSoft}` }}>
          <input ref={fileRef} type="file" accept="audio/mpeg,.mp3" onChange={handleUpload} style={{ display: 'none' }} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading} style={{ width: '100%', padding: '9px', borderRadius: '9px', border: `1px dashed ${colors.borderSoft}`, background: 'rgba(255,255,255,0.03)', color: colors.textMuted, fontSize: '12px', fontWeight: 600, cursor: uploading ? 'default' : 'pointer' }}>
            {uploading ? 'Uploading…' : '+ Upload MP3 clip'}
          </button>
        </div>
      )}
    </div>
  );
}

function RoundButton({ active, danger, onClick, icon, label, showLabel = true }) {
  const onColor = danger ? colors.danger : colors.brand;
  const onBg = danger ? 'rgba(239, 68, 68, 0.12)' : colors.brandDim;
  const onBorder = danger ? 'rgba(239, 68, 68, 0.35)' : 'rgba(99, 102, 241, 0.35)';
  return (
    <button
      className="icon-btn round-btn"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: showLabel ? '8px' : 0,
        padding: showLabel ? '11px 18px' : '0', width: showLabel ? 'auto' : '42px', height: showLabel ? 'auto' : '42px',
        borderRadius: showLabel ? '12px' : '50%',
        border: `1px solid ${active ? onBorder : colors.borderSoft}`,
        backgroundColor: active ? onBg : colors.panelAlt,
        color: active ? onColor : colors.text,
        fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer',
        transition: 'background-color 0.15s, border-color 0.15s, box-shadow 0.2s',
        boxShadow: active ? `0 0 0 1px ${onBorder}, 0 4px 16px ${danger ? 'rgba(239, 68, 68, 0.2)' : 'rgba(204, 75, 194, 0.25)'}` : 'none',
        WebkitAppRegion: 'no-drag',
      }}
    >
      {icon} {showLabel && label}
    </button>
  );
}

// ============================================================================
// VOICE: main stage
// ============================================================================
// Change this line:
// Shared behavior for every icon-triggered floating panel: tracks the
// trigger button's position, closes on outside click, and lets the panel
// be dragged away from its anchored spot (resets to the icon when reopened).
function useIconMenu() {
  const anchorRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragState = useRef(null);

  useEffect(() => {
    const update = () => {
      if (anchorRef.current) {
        const r = anchorRef.current.getBoundingClientRect();
        setRect(prev => (prev && prev.top === r.top && prev.left === r.left) ? prev : r);
      }
    };
    update();
    window.addEventListener('resize', update);
    const interval = setInterval(update, 100);
    return () => { window.removeEventListener('resize', update); clearInterval(interval); };
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (!open || !document.body.contains(e.target)) return;
      if (anchorRef.current && !anchorRef.current.contains(e.target) && (!menuRef.current || !menuRef.current.contains(e.target))) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const clampMenu = () => {
      const current = menuRef.current?.getBoundingClientRect();
      if (!current) return;
      const margin = 8;
      const correctionX = Math.max(margin - current.left, Math.min(0, window.innerWidth - margin - current.right));
      const correctionY = Math.max(margin - current.top, Math.min(0, window.innerHeight - margin - current.bottom));
      if (!correctionX && !correctionY) return;
      setDragOffset((previous) => ({ x: previous.x + correctionX, y: previous.y + correctionY }));
    };
    const frame = requestAnimationFrame(clampMenu);
    window.addEventListener('resize', clampMenu);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampMenu);
    if (observer && menuRef.current) observer.observe(menuRef.current);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', clampMenu);
      observer?.disconnect();
    };
  }, [open, rect]);

  const openMenu = () => { setDragOffset({ x: 0, y: 0 }); setOpen(true); }; // re-anchors on reopen
  const closeMenu = () => setOpen(false);
  const toggleMenu = () => (open ? closeMenu() : openMenu());

  const onDragHandlePointerDown = (e) => {
    e.preventDefault();
    const menuRect = menuRef.current?.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: dragOffset.x,
      baseY: dragOffset.y,
      menuLeft: menuRect?.left ?? 0,
      menuTop: menuRect?.top ?? 0,
      menuWidth: menuRect?.width ?? 0,
      menuHeight: menuRect?.height ?? 0,
    };
    const onMove = (ev) => {
      if (!dragState.current) return;
      const state = dragState.current;
      const margin = 8;
      const deltaX = ev.clientX - state.startX;
      const deltaY = ev.clientY - state.startY;
      const requestedLeft = state.menuLeft + deltaX;
      const requestedTop = state.menuTop + deltaY;
      const minLeft = margin;
      const maxLeft = Math.max(minLeft, window.innerWidth - state.menuWidth - margin);
      const minTop = margin;
      const maxTop = Math.max(minTop, window.innerHeight - state.menuHeight - margin);
      const left = Math.max(minLeft, Math.min(maxLeft, requestedLeft));
      const top = Math.max(minTop, Math.min(maxTop, requestedTop));

      setDragOffset({
        x: state.baseX + deltaX + (left - requestedLeft),
        y: state.baseY + deltaY + (top - requestedTop),
      });
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return { anchorRef, menuRef, open, toggleMenu, closeMenu, rect, dragOffset, onDragHandlePointerDown };
}

export function VoiceChannelView({
  username,
  roomName,
  channelType,
  profile,
  streamSettings,
  memberMap,
  onAvatarClick,
  deafened,
  onToggleDeafen,
  onToggleMic,
  minimized,
  isDragging,
  channelId,
  token,
  voiceSettings,
  onVoiceSettingsChange,
  authToken,
  backgroundTrackTitle,
  myRole,
  serverId,
  remotePositions
}) {
  const participants = useParticipants();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], { onlySubscribed: false });
  const [hoveredSid, setHoveredSid] = useState(null);
  const [isDiscHovered, setIsDiscHovered] = useState(false);
  const ambienceMenu = useIconMenu();
  const spatialMenu = useIconMenu();
  const mixerMenu = useIconMenu();
  const [ambienceTab, setAmbienceTab] = useState('music');
  const canManage = myRole === 'owner' || myRole === 'admin';

  const [timerEnd, setTimerEnd] = useState(null);
  const [timerMode, setTimerMode] = useState('focus'); 
  const [ambientNoise, setAmbientNoise] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const int = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(int);
  }, []);

  useEffect(() => {
    const handler = (data) => {
      if (data.channelId === channelId) {
        setTimerEnd(data.endTime);
        setTimerMode(data.mode);
      }
    };
    socket.on('timer_update', handler);
    return () => socket.off('timer_update', handler);
  }, [channelId]);

  const triggerTimer = (mins, mode) => {
    const endTime = Date.now() + mins * 60000;
    setTimerEnd(endTime);
    setTimerMode(mode);
    socket.emit('timer_update', { channelId, endTime, mode });
  };

  // Ambient Noise Generator (Brown Noise for focus)
  useEffect(() => {
    if (!ambientNoise) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const bufferSize = 2 * ctx.sampleRate;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      output[i] = (lastOut + (0.02 * white)) / 1.02; // Simple Brown Noise approximation
      lastOut = output[i];
      output[i] *= 3.5; // Compensate for gain drop
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.15; // Keep it low and atmospheric
    noise.connect(gain);
    gain.connect(ctx.destination);
    noise.start();

    return () => {
      try {
        noise.stop();
        noise.disconnect();
        ctx.close();
      } catch (e) {}
    };
  }, [ambientNoise]);

  useEffect(() => {
    if (!room) return;
    if (streamSettings.micDeviceId) {
      room.switchActiveDevice('audioinput', streamSettings.micDeviceId).catch(() => {});
    }
    if (streamSettings.speakerDeviceId) {
      room.switchActiveDevice('audiooutput', streamSettings.speakerDeviceId).catch(() => {});
    }
  }, [room, streamSettings.micDeviceId, streamSettings.speakerDeviceId]);

  const trackFor = (identity, source) =>
    tracks.find((t) => t.participant?.identity === identity && t.source === source && !t.publication?.isMuted);

  const [fullscreenSid, setFullscreenSid] = useState(null);
  const toggleFullscreen = (sid) => setFullscreenSid((cur) => (cur === sid ? null : sid));

  useEffect(() => {
    if (!fullscreenSid) return;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreenSid(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreenSid]);

  useEffect(() => {
    if (!fullscreenSid) return;
    const stillSharing = tracks.some((t) => t.participant?.sid === fullscreenSid && t.source === Track.Source.ScreenShare);
    if (!stillSharing) setFullscreenSid(null);
  }, [tracks, fullscreenSid]);

  const [showShareSetup, setShowShareSetup] = useState(false);

  const stopScreenShare = async () => {
    if (!localParticipant) return;

    const pubs = localParticipant.getTrackPublications();
    pubs.forEach((pub) => {
      if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
        if (pub.track && pub.track.mediaStreamTrack) {
          pub.track.mediaStreamTrack.stop();
        }
      }
    });

    await localParticipant.setScreenShareEnabled(false);
    playChime('share-off');
  };

  const startScreenShare = async (opts, sourceId) => {
    setShowShareSetup(false);
    try {
      let stream;

      if (window.electronAPI && sourceId) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: opts.audio ? {
            mandatory: { chromeMediaSource: 'desktop' }
          } : false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxFrameRate: opts.fps || 60,
              maxHeight: opts.res || 1080
            }
          }
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: opts.res || 1080 },
            height: { ideal: (opts.res || 1080) * 0.5625 },
            frameRate: { ideal: opts.fps || 60 },
          },
          audio: opts.audio ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          } : false,
        });
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        await localParticipant?.publishTrack(videoTrack, {
          source: Track.Source.ScreenShare,
          name: 'screen_share'
        });
      }

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        await localParticipant?.publishTrack(audioTrack, {
          source: Track.Source.ScreenShareAudio,
          name: 'screen_share_audio'
        });
      }

      if (videoTrack) {
        videoTrack.onended = () => {
          stopScreenShare();
        };
      }

      playChime('share-on');
    } catch (e) {
      console.error('Screen capture failed:', e);
    }
  };

  const onShareClick = () => {
    if (isScreenShareEnabled) stopScreenShare();
    else setShowShareSetup(true);
  };


  // 👇 PASTE THIS RIGHT HERE 👇
  useEffect(() => {
    const handleShare = () => onShareClick();
    window.addEventListener('trigger-share', handleShare);
    return () => window.removeEventListener('trigger-share', handleShare);
  }, [isScreenShareEnabled]); 
  // 👆 ---------------------- 👆




 return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      
      {/* Focus Timer Header */}
      {channelType === 'focus' && !minimized && (
        <div style={{ position: 'absolute', top: '16px', right: '16px', zIndex: 30, display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(24, 24, 27, 0.8)', backdropFilter: 'blur(12px)', border: `1px solid ${colors.borderSoft}`, borderRadius: '24px', padding: '6px 8px 6px 14px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', animation: 'popIn 0.3s ease' }}>
           <span style={{ color: timerMode === 'focus' ? colors.brand : colors.online, display: 'flex' }}><Icon.Clock size={16} /></span>
           <span style={{ fontFamily: fontMono, fontSize: '15px', fontWeight: 700, color: colors.text, fontVariantNumeric: 'tabular-nums' }}>
             {timerEnd && timerEnd > now ? (() => {
               const r = Math.floor((timerEnd - now) / 1000);
               return `${Math.floor(r / 60).toString().padStart(2, '0')}:${(r % 60).toString().padStart(2, '0')}`;
             })() : '00:00'}
           </span>
           <div style={{ display: 'flex', gap: '4px', marginLeft: '6px', borderLeft: `1px solid ${colors.border}`, paddingLeft: '8px' }}>
              <button 
                onClick={() => setAmbientNoise(!ambientNoise)} 
                title="Toggle ambient noise"
                style={{ background: ambientNoise ? colors.brandDim : 'transparent', color: ambientNoise ? colors.brand : colors.textFaint, border: 'none', borderRadius: '12px', padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              >
                <Icon.CloudRain size={13} />
              </button>
              {canManage && (
                <>
                  <button onClick={() => triggerTimer(25, 'focus')} style={{ background: colors.brandDim, color: colors.brand, border: 'none', borderRadius: '12px', padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>25m</button>
                  <button onClick={() => triggerTimer(5, 'break')} style={{ background: 'rgba(126,231,135,0.15)', color: colors.online, border: 'none', borderRadius: '12px', padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>5m</button>
                </>
              )}
           </div>
        </div>
      )}

      {/* 1. Dynamic positioning: stack and center when minimized */}
      <div style={{
        position: 'absolute', 
        top: '16px', 
        left: minimized ? '50%' : '16px', 
        transform: minimized ? 'translateX(-50%)' : 'none',
        zIndex: 20, 
        display: 'flex', 
        flexDirection: minimized ? 'column' : 'row', 
        alignItems: 'center', 
        gap: '8px',
        transition: isDragging ? 'none' : 'all 0.3s ease'
      }}>
        
        {/* 'In voice' counter pill */}
        <div 
          title={`${participants.length} in voice`}
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            gap: minimized ? '0' : '8px', 
            backgroundColor: 'rgba(24, 24, 27, 0.8)', 
            backdropFilter: 'blur(12px)', 
            border: `1px solid ${colors.borderSoft}`, 
            borderRadius: minimized ? '50%' : '24px', 
            padding: minimized ? '0' : '8px 14px 8px 12px', 
            width: minimized ? '36px' : 'auto',
            height: '36px',
            fontFamily: fontBody, 
            fontSize: '13px', 
            fontWeight: 600, 
            color: colors.textMuted, 
            boxSizing: 'border-box', 
            animation: 'popIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) both' 
          }}
        >
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.online, animation: 'pulseGlow 2s infinite' }} />
          {!minimized && `${participants.length} in voice`}
        </div>

{/* Room Ambience Button & Now Playing */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '8px' }} ref={ambienceMenu.anchorRef}>
  <button
    onClick={() => { ambienceMenu.toggleMenu(); spatialMenu.closeMenu(); mixerMenu.closeMenu(); }}
    onMouseEnter={() => setIsDiscHovered(true)}
    onMouseLeave={() => setIsDiscHovered(false)}
    title="Room Ambience"
    style={{
      width: '36px', height: '36px', borderRadius: '50%',
      backgroundColor: ambienceMenu.open ? colors.brand : 'rgba(24, 24, 27, 0.8)',
      border: `1px solid ${ambienceMenu.open || isDiscHovered ? colors.brand : colors.borderSoft}`,
              backdropFilter: 'blur(12px)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
              transition: 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
              transform: isDiscHovered ? 'scale(1.12)' : 'scale(1)',
              boxShadow: isDiscHovered ? `0 0 16px ${colors.brand}` : 'none'
            }}
          >
            <div style={{ display: 'flex', animation: 'spin 4s linear infinite' }}>
              <img src={customDiscIcon} alt="music" style={{ width: '18px', height: '18px', objectFit: 'contain', transition: 'filter 0.2s', filter: ambienceMenu.open || isDiscHovered ? 'invert(1) drop-shadow(0 0 2px rgba(255,255,255,0.5))' : 'invert(0.6)' }} />
            </div>
          </button>

          {/* Persistent "Now Playing" Tag */}
          {backgroundTrackTitle && !minimized && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              backgroundColor: 'rgba(24, 24, 27, 0.6)', backdropFilter: 'blur(12px)',
              border: `1px solid ${colors.borderSoft}`, borderRadius: '20px',
              padding: '6px 14px', fontSize: '12px', fontWeight: 700, color: colors.text,
              maxWidth: '200px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              animation: 'popIn 0.3s ease'
            }}>
              <span style={{ fontSize: '12px' }}>🎵</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: colors.brand }}>
                {backgroundTrackTitle}
              </span>
            </div>
          )}
        </div>
        {/* Spatial Radar Button (Positioned to the right of Music) */}
        <div style={{ position: 'relative' }} ref={spatialMenu.anchorRef}>
  <button
    id="spatial-room-btn"
    onClick={() => { spatialMenu.toggleMenu(); ambienceMenu.closeMenu(); mixerMenu.closeMenu(); }}
    title="Open Soundstage"
    style={{
      width: '36px', height: '36px', borderRadius: '50%',
      backgroundColor: spatialMenu.open ? colors.brand : 'rgba(24, 24, 27, 0.8)',
      border: `1px solid ${spatialMenu.open ? colors.brand : colors.borderSoft}`,
      backdropFilter: 'blur(12px)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxSizing: 'border-box', transition: 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
      color: spatialMenu.open ? '#fff' : colors.textMuted
    }}
  >
    <div style={{ display: 'flex', willChange: 'transform, filter', animation: 'soundstageIconPulse 1.8s ease-in-out infinite', filter: 'drop-shadow(0 0 3px currentColor)' }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
        <path d="M5 9v6M8 6v12M16 6v12M19 9v6M8 12h8" />
      </svg>
    </div>
  </button>
</div>

{/* Audio Mixer Button (next to Soundstage) */}
<div style={{ position: 'relative' }} ref={mixerMenu.anchorRef}>
  <button
    onClick={() => { mixerMenu.toggleMenu(); ambienceMenu.closeMenu(); spatialMenu.closeMenu(); }}
    title="Audio Mixer"
    style={{
      width: '36px', height: '36px', borderRadius: '50%',
      backgroundColor: mixerMenu.open ? colors.brand : 'rgba(24, 24, 27, 0.8)',
      border: `1px solid ${mixerMenu.open ? colors.brand : colors.borderSoft}`,
      backdropFilter: 'blur(12px)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxSizing: 'border-box', transition: 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
      color: mixerMenu.open ? '#fff' : colors.textMuted
    }}
  >
    <div style={{ display: 'flex', willChange: 'transform, filter', animation: 'mixerIconShift 1.1s ease-in-out infinite alternate', filter: 'drop-shadow(0 0 3px currentColor)' }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M4 7h16M4 12h16M4 17h16" />
        <circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" />
        <circle cx="16" cy="12" r="2" fill="currentColor" stroke="none" />
        <circle cx="11" cy="17" r="2" fill="currentColor" stroke="none" />
      </svg>
    </div>
  </button>
</div>
      </div>


{/* Portaled Ambience: Permanently mounted so music keeps playing, but visually hidden when closed */}
      {ambienceMenu.rect && createPortal(
  <div
    ref={ambienceMenu.menuRef}
    style={{
      position: 'fixed',
      top: ambienceMenu.rect.bottom + 12 + ambienceMenu.dragOffset.y,
      left: Math.max(16, Math.min(ambienceMenu.rect.left - 130, window.innerWidth - 316)) + ambienceMenu.dragOffset.x,
      width: '300px',
      zIndex: 999999,
      opacity: ambienceMenu.open ? 1 : 0,
      pointerEvents: ambienceMenu.open ? 'auto' : 'none',
      transform: ambienceMenu.open ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.96)',
      transition: 'opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
      background: 'rgba(20, 23, 42, 0.85)', backdropFilter: 'blur(24px)', padding: '20px', borderRadius: '28px', border: '1px solid rgba(204, 75, 194, 0.15)', display: 'flex', flexDirection: 'column', gap: '14px', boxSizing: 'border-box', boxShadow: '0 24px 60px rgba(0,0,0,0.6)'
    }}
  >
    <div onPointerDown={ambienceMenu.onDragHandlePointerDown} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'grab', touchAction: 'none' }}>
      <span style={{ color: '#f1edf7', fontSize: '13.5px', fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif" }}>Room Ambience</span>
      {!canManage && <span style={{ fontSize: '10px', color: colors.gold, background: colors.goldDim, padding: '2px 6px', borderRadius: '8px', fontWeight: 700 }}>Owner Only</span>}
    </div>
    
    <div style={{ display: 'flex', borderBottom: `1px solid ${colors.borderSoft}`, marginBottom: '4px' }}>
      <button onClick={() => setAmbienceTab('music')} style={{ flex: 1, padding: '8px 0', border: 'none', background: 'transparent', color: ambienceTab === 'music' ? colors.brand : colors.textMuted, borderBottom: ambienceTab === 'music' ? `2px solid ${colors.brand}` : '2px solid transparent', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>Music</button>
      <button onClick={() => setAmbienceTab('soundboard')} style={{ flex: 1, padding: '8px 0', border: 'none', background: 'transparent', color: ambienceTab === 'soundboard' ? colors.brand : colors.textMuted, borderBottom: ambienceTab === 'soundboard' ? `2px solid ${colors.brand}` : '2px solid transparent', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>Soundboard</button>
    </div>

    <div style={{ display: ambienceTab === 'music' ? 'flex' : 'none', flexDirection: 'column', gap: '14px' }}>
      <CollaborativePlayer
        channelId={channelId}
        serverId={serverId}
        socket={socket}
        authToken={authToken}
        ducking={participants.some(p => p.isSpeaking && p.identity !== username)}
        canManage={canManage}
        username={username}
      />
    </div>
    
    {ambienceTab === 'soundboard' && (
      <SoundboardDock
        serverId={serverId}
        channelId={channelId}
        authToken={authToken}
        username={username}
        voiceSettings={voiceSettings}
        onVoiceSettingsChange={onVoiceSettingsChange}
        canManage={canManage}
      />
    )}
  </div>,
  document.body
)}

     {/* Portaled Spatial Room Radar */}
      {spatialMenu.open && spatialMenu.rect && createPortal(
  <div
    ref={spatialMenu.menuRef}
    style={{
      position: 'fixed',
      top: spatialMenu.rect.bottom + 12 + spatialMenu.dragOffset.y,
      left: Math.max(16, Math.min(spatialMenu.rect.left + 18 - 160, window.innerWidth - 336)) + spatialMenu.dragOffset.x,
      zIndex: 999999,
      animation: 'popIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
    }}
  >
    <SpatialRoom
      participants={participants}
      memberMap={memberMap}
      voiceSettings={voiceSettings}
      onVoiceSettingsChange={onVoiceSettingsChange}
      username={username}
      onClose={spatialMenu.closeMenu}
      onDragHandlePointerDown={spatialMenu.onDragHandlePointerDown}
      socket={socket}
      channelId={channelId}
      remotePositions={remotePositions}
    />
  </div>,
  document.body
)}

{mixerMenu.open && mixerMenu.rect && createPortal(
  <div
  ref={mixerMenu.menuRef}
  style={{
    position: 'fixed',
    top: mixerMenu.rect.bottom + 12 + mixerMenu.dragOffset.y,
    left: Math.max(16, Math.min(mixerMenu.rect.left + 18 - 160, window.innerWidth - 336)) + mixerMenu.dragOffset.x,
    zIndex: 999999,
    animation: 'popIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
  }}
>
  <AudioMixer
    participants={participants}
    username={username}
    voiceSettings={voiceSettings}
    onVoiceSettingsChange={onVoiceSettingsChange}
    onClose={mixerMenu.closeMenu}
    onDragHandlePointerDown={mixerMenu.onDragHandlePointerDown}
  />
</div>,
  document.body
)}



      {showShareSetup && (
        <SharePickerModal
          defaults={streamSettings}
          onCancel={() => setShowShareSetup(false)}
          onStart={startScreenShare}
        />
      )}

      <div className="scroll-thin" style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignContent: 'center', justifyContent: 'center', gap: '24px', padding: '70px 24px 24px', overflowY: 'auto', overflowX: 'visible', minWidth: '280px', position: 'relative' }}>
        {participants.length === 0 && (
          <p className="joining-voice" style={{ color: colors.textFaint, fontSize: '14px', fontWeight: 500 }}>
            Joining voice…
          </p>
        )}

        {participants.map((p) => {
          const isMe = p.identity === username;
          const micOn = p.isMicrophoneEnabled;
          const screenTrack = trackFor(p.identity, Track.Source.ScreenShare);
          const camTrack = trackFor(p.identity, Track.Source.Camera);
          const videoTrack = screenTrack || camTrack;
          const remoteMember = memberMap?.[p.identity];
          const avatarUrl = isMe ? profile.avatarUrl : (remoteMember?.avatarUrl || null);

          const openProfile = () =>
            onAvatarClick?.(
              isMe
                ? { username: p.identity, avatarUrl: profile.avatarUrl, bannerUrl: profile.bannerUrl, bannerColor: profile.bannerColor }
                : (remoteMember || { username: p.identity, avatarUrl: null })
            );

          if (videoTrack) {
            const isFs = screenTrack && fullscreenSid === p.sid;

            const mix = voiceSettings?.mixerOverrides?.[p.identity] || { voice: 1, stream: 1 };
            const setMix = (kind, val) => {
              onVoiceSettingsChange?.({
                ...voiceSettings,
                mixerOverrides: {
                  ...(voiceSettings.mixerOverrides || {}),
                  [p.identity]: { ...mix, [kind]: parseFloat(val) }
                }
              });
            };

            return (
              <div
                key={p.sid}
                onMouseEnter={() => setHoveredSid(p.sid)}
                onMouseLeave={() => setHoveredSid(null)}
                className="avatar-tile"
                style={isFs ? {
                  position: 'fixed', inset: 0, zIndex: 90, borderRadius: 0, border: 'none',
                  backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center'
                } : {
                  width: screenTrack ? '560px' : '240px',
                  maxWidth: '100%',
                  aspectRatio: '16/9',
                  borderRadius: '16px',
                  overflow: 'hidden',
                  position: 'relative',
                  border: p.isSpeaking ? `2px solid ${colors.speak}` : `1px solid ${colors.border}`,
                  backgroundColor: '#000',
                  boxShadow: '0 8px 30px rgba(0,0,0,0.5)'
                }}
              >
                <VideoTrack trackRef={videoTrack} style={{ width: '100%', height: '100%', objectFit: screenTrack ? 'contain' : 'cover' }} />

                {screenTrack && <TelestratorCanvas channelId={channelId} trackSid={screenTrack.sid} isScreenShare={true} />}

                <div
                  onClick={(e) => { e.stopPropagation(); openProfile(); }}
                  style={{
                    position: 'absolute',
                    bottom: isFs ? '24px' : '10px',
                    left: isFs ? '24px' : '10px',
                    backgroundColor: 'rgba(9, 9, 11, 0.85)',
                    backdropFilter: 'blur(8px)',
                    borderRadius: '8px',
                    padding: '6px 12px',
                    fontSize: '13px',
                    fontWeight: 600,
                    color: colors.text,
                    fontFamily: fontBody,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    WebkitAppRegion: 'no-drag'
                  }}
                >
                  {!micOn && <Icon.MicOff size={13} color={colors.danger} />}
                  {screenTrack ? `${p.identity} — sharing screen` : (isMe ? `${p.identity} (you)` : p.identity)}
                </div>

                <div
                  style={{
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    background: 'rgba(9,9,11,0.85)',
                    backdropFilter: 'blur(8px)',
                    padding: '10px',
                    borderRadius: '10px',
                    zIndex: 20,
                    WebkitAppRegion: 'no-drag',
                    opacity: hoveredSid === p.sid && !isMe ? 1 : 0,
                    pointerEvents: hoveredSid === p.sid && !isMe ? 'auto' : 'none',
                    transition: 'opacity 0.2s'
                  }}
                >
                  <label style={{ fontSize: '10px', color: colors.textMuted, display: 'flex', flexDirection: 'column', gap: '4px', fontWeight: 600 }}>
                    🎤 Voice Vol
                   <input type="range" min="0" max="2" step="0.05" value={mix.voice} onInput={(e) => setMix('voice', e.target.value)} style={{ width: '80px', accentColor: colors.brand, cursor: 'pointer' }} />
                  </label>

                  {screenTrack && (
                    <>
                      <label style={{ fontSize: '10px', color: colors.textMuted, display: 'flex', flexDirection: 'column', gap: '4px', fontWeight: 600 }}>
                        📺 Game Vol
                        <input type="range" min="0" max="2" step="0.1" value={mix.stream} onChange={(e) => setMix('stream', e.target.value)} style={{ width: '80px', accentColor: colors.gold }} />
                      </label>

                      <button
                        onClick={() => window.electronAPI.windowControls.togglePiP({ token, channelId, trackSid: screenTrack.sid, show: true })}
                        style={{ marginTop: '4px', padding: '6px', borderRadius: '6px', border: `1px solid ${colors.borderSoft}`, background: colors.panelAlt, color: colors.text, fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                      >
                        Pop Out (PiP)
                      </button>
                    </>
                  )}
                </div>

                {screenTrack && (
                  <button
                    className="icon-btn"
                    onClick={() => toggleFullscreen(p.sid)}
                    title={isFs ? 'Exit full screen (Esc)' : 'Full screen'}
                    style={{ position: 'absolute', bottom: isFs ? '24px' : '10px', right: isFs ? '24px' : '10px', border: 'none', borderRadius: '8px', backgroundColor: 'rgba(9, 9, 11, 0.85)', backdropFilter: 'blur(8px)', color: colors.text, padding: '8px', cursor: 'pointer', display: 'flex', WebkitAppRegion: 'no-drag' }}
                  >
                    {isFs ? <Icon.Shrink size={16} /> : <Icon.Expand size={16} />}
                  </button>
                )}
              </div>
            );
          }

 return (
              <div
              key={p.sid}
              className="avatar-tile"
              onMouseEnter={() => setHoveredSid(p.sid)}
              onMouseLeave={() => setHoveredSid(null)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: minimized ? '6px' : '12px', width: minimized ? '60px' : '100px', WebkitAppRegion: 'no-drag', position: 'relative', transition: isDragging ? 'none' : 'width 0.3s ease, gap 0.3s ease', animation: `floatSoft 4s ease-in-out infinite alternate ${hoveredSid === p.sid ? 'paused' : 'running'}`, overflow: 'visible', zIndex: hoveredSid === p.sid ? 50 : 1 }}>
              
              {/* 1. Avatar Circle Container */}
              <div onClick={openProfile} style={{ position: 'relative', width: minimized ? '50px' : '90px', height: minimized ? '50px' : '90px', cursor: 'pointer', transition: isDragging ? 'none' : 'all 0.3s ease', transform: p.isSpeaking ? 'scale(1.12)' : 'scale(1)', zIndex: 2 }}>
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    background: avatarUrl ? 'transparent' : colorForName(p.identity),
                    fontFamily: fontDisplay,
                    fontWeight: 700,
                    fontSize: '30px',
                    color: '#fff',
                    animation: p.isSpeaking ? 'speakGlow 1.3s ease-in-out infinite' : 'idleGlow 3.6s ease-in-out infinite'
                  }}
                >
                  {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(p.identity)}
                </div>

                {/* Mute icon goes INSIDE the avatar circle container so it pins to the bottom right */}
                {!micOn && (
                  <span style={{ position: 'absolute', bottom: '-2px', right: '-2px', zIndex: 2, width: '28px', height: '28px', borderRadius: '50%', backgroundColor: colors.danger, border: `3px solid ${colors.stage}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white' }}>
                    <Icon.MicOff size={13} />
                  </span>
                )}
              </div>

              {/* 2. Username goes OUTSIDE the avatar circle container */}
              {!minimized && (
                <span style={{ fontSize: '14px', fontWeight: 600, color: colors.text, maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {isMe ? `${p.identity} (you)` : p.identity}
                </span>
              )}

              {/* 3. Hover Volume Control */}
              {/* Invisible bridge to keep hover state alive while moving to menu */}
              {hoveredSid === p.sid && (
                <div
                  onMouseEnter={() => setHoveredSid(p.sid)}
                  onMouseLeave={() => setHoveredSid(null)}
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '95%',
                    width: '200px',
                    height: '60px',
                    transform: 'translateY(-50%)',
                    pointerEvents: 'auto',
                    zIndex: 99998
                  }}
                />
              )}
              <div
                onMouseEnter={() => setHoveredSid(p.sid)}
                onMouseLeave={() => setHoveredSid(null)}
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '100%',
                  transform: 'translateY(-50%)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  background: colors.panel,
                  border: `1px solid ${colors.border}`,
                  backdropFilter: 'blur(12px)',
                  padding: '12px 14px',
                  borderRadius: '12px',
                  minWidth: '140px',
                  marginLeft: '8px',
                  zIndex: 99999,
                  opacity: hoveredSid === p.sid ? 1 : 0,
                  pointerEvents: hoveredSid === p.sid ? 'auto' : 'none',
                  transition: 'opacity 0.15s ease',
                  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.8)',
                  whiteSpace: 'nowrap'
                }}
              >
                <label style={{ fontSize: '11px', color: colors.textMuted, display: 'flex', flexDirection: 'column', gap: '6px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Icon.Volume size={12} /> Voice
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={voiceSettings?.mixerOverrides?.[p.identity]?.voice ?? 1}
                    onChange={(e) =>
                      onVoiceSettingsChange?.({
                        ...voiceSettings,
                        mixerOverrides: {
                          ...(voiceSettings.mixerOverrides || {}),
                          [p.identity]: {
                            ...(voiceSettings?.mixerOverrides?.[p.identity] || { stream: 1 }),
                            voice: parseFloat(e.target.value)
                          }
                        }
                      })
                    }
                    style={{ width: '100%', accentColor: colors.brand, cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '10px', color: colors.textFaint, textAlign: 'center' }}>
                    {Math.round((voiceSettings?.mixerOverrides?.[p.identity]?.voice ?? 1) * 100)}%
                  </span>
                </label>
                
                {canManage && !isMe && (
                  <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${colors.borderSoft}`, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <p style={{ fontSize: '10px', color: colors.gold, fontWeight: 700, textTransform: 'uppercase', margin: 0, display: 'flex', alignItems: 'center', gap: '4px' }}><Icon.Shield size={10} /> Mod Actions</p>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button onClick={() => socket.emit('room_command', { channelId, target: p.identity, command: 'mute' })} style={{ flex: 1, padding: '6px', borderRadius: '6px', border: `1px solid ${colors.borderSoft}`, background: 'rgba(255,255,255,0.06)', color: colors.text, fontSize: '11px', fontWeight: 600, cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e => e.currentTarget.style.backgroundColor='rgba(255,255,255,0.1)'} onMouseLeave={e => e.currentTarget.style.backgroundColor='rgba(255,255,255,0.06)'}>Mute</button>
                      <button onClick={() => socket.emit('room_command', { channelId, target: p.identity, command: 'kick' })} style={{ flex: 1, padding: '6px', borderRadius: '6px', border: `1px solid rgba(239, 68, 68, 0.2)`, background: 'rgba(239, 68, 68, 0.15)', color: colors.danger, fontSize: '11px', fontWeight: 600, cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e => e.currentTarget.style.backgroundColor='rgba(239, 68, 68, 0.25)'} onMouseLeave={e => e.currentTarget.style.backgroundColor='rgba(239, 68, 68, 0.15)'}>Kick</button>
                    </div>
                  </div>
                )}

              </div>
            </div>
          );
        })}
      </div>

    </div>
  );


function VoiceSession({ username, roomName, channelType, profile, streamSettings, memberMap, onAvatarClick, voiceSettings, onVoiceSettingsChange, serverId, channelId, authToken, dockAnchor, minimized, isDragging, onOpenSettings, token, myRole }) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const [deafened, setDeafened] = useState(false);
  const [micError, setMicError] = useState(null);
  const [serverMuted, setServerMuted] = useState(false);
  const [remotePositions, setRemotePositions] = useState({});
  const preDeafenMicRef = useRef(true);
  const micWasOnBeforeTestRef = useRef(false); 

  useEffect(() => {
    const handleMove = (data) => {
      if (data.channelId === channelId && data.username !== username) {
        setRemotePositions((prev) => ({ ...prev, [data.username]: { x: data.x, y: data.y } }));
      }
    };
    socket.on('spatial_move', handleMove);
    return () => socket.off('spatial_move', handleMove);
  }, [channelId, username]);

  useEffect(() => {
    const handler = (data) => {
      if (data.channelId === channelId && data.target === username) {
        if (data.command === 'mute') {
          setServerMuted(true);
          localParticipant?.setMicrophoneEnabled(false);
          setMicError("A moderator has muted your microphone for this room.");
          playChime('error');
        } else if (data.command === 'unmute') {
          setServerMuted(false);
        } else if (data.command === 'kick') {
          room?.disconnect();
          setMicError("You were removed from the room by a moderator.");
          playChime('error');
        }
      }
    };
    socket.on('room_command', handler);
    return () => socket.off('room_command', handler);
  }, [channelId, username, localParticipant, room]);
   const { isNoiseFilterEnabled, setNoiseFilterEnabled, isNoiseFilterPending } = useKrispNoiseFilter();
  useEffect(() => {
    console.log('[Soul] Krisp pending:', isNoiseFilterPending, '| enabled:', isNoiseFilterEnabled);
  }, [isNoiseFilterPending, isNoiseFilterEnabled]);

  const [remoteVolumes, setRemoteVolumes] = useState({});

  // 2. BROADCAST YOUR VOLUME TO THE ROOM
  useEffect(() => {
    if (channelId && username && streamSettings.inputVolume !== undefined) {
      socket.emit('user_volume_update', { 
        channelId, 
        username, 
        volume: streamSettings.inputVolume 
      });
    }
  }, [streamSettings.inputVolume, channelId, username]);

  // 3. LISTEN FOR OTHER PEOPLES' VOLUME CHANGES
  useEffect(() => {
    const handleVol = (data) => {
      if (data.channelId === channelId) {
        setRemoteVolumes((prev) => ({ ...prev, [data.username]: data.volume }));
      }
    };
    socket.on('user_volume_update', handleVol);
    return () => socket.off('user_volume_update', handleVol);
  }, [channelId]);

  
  useEffect(() => {
    setNoiseFilterEnabled(voiceSettings.krispEnabled !== false);
  }, [voiceSettings.krispEnabled, setNoiseFilterEnabled]);

  useEffect(() => {
    if (!room) return undefined;
    const onMediaError = (err) => {
      console.error('[Soul] Microphone/camera device error:', err);
      setMicError(`${err?.name || 'Error'}: ${err?.message || 'Could not access your microphone.'}`);
    };
    room.on(RoomEvent.MediaDevicesError, onMediaError);
    return () => room.off(RoomEvent.MediaDevicesError, onMediaError);
  }, [room]);

  const toggleMic = useCallback(async () => {
    if (serverMuted) {
      setMicError("A moderator has muted your microphone for this room.");
      playChime('error');
      return;
    }
    if (!localParticipant) return;
    const turningOn = !isMicrophoneEnabled;
    if (turningOn && deafened) setDeafened(false);
    try {
      await localParticipant.setMicrophoneEnabled(turningOn);
      if (turningOn) setMicError(null);
    } catch (err) {
      console.error('[Soul] setMicrophoneEnabled failed:', err);
      setMicError(`${err?.name || 'Error'}: ${err?.message || 'Could not enable your microphone.'}`);
    }
  }, [localParticipant, isMicrophoneEnabled, deafened]);

  const toggleDeafen = useCallback(() => {
    setDeafened((was) => {
      const next = !was;
      if (next) {
        preDeafenMicRef.current = isMicrophoneEnabled;
        localParticipant?.setMicrophoneEnabled(false);
      } else {
        localParticipant?.setMicrophoneEnabled(preDeafenMicRef.current);
      }
      return next;
    });
  }, [isMicrophoneEnabled, localParticipant]);

  useEffect(() => {
    if (!window.electronAPI?.hotkeys) return undefined;
    const offMute = window.electronAPI.hotkeys.onToggleMute(() => {
      playChime(isMicrophoneEnabled ? 'mute' : 'unmute');
      toggleMic();
    });
    const offDeafen = window.electronAPI.hotkeys.onToggleDeafen(() => {
      playChime(deafened ? 'undeafen' : 'deafen');
      toggleDeafen();
    });
    const offPttDown = window.electronAPI.hotkeys.onPttDown(() => {
      if (!voiceSettings.pttMode || !localParticipant) return;
      playChime('ptt-on');
      localParticipant.setMicrophoneEnabled(true);
    });
    const offPttUp = window.electronAPI.hotkeys.onPttUp(() => {
      if (!voiceSettings.pttMode || !localParticipant) return;
      playChime('ptt-off');
      localParticipant.setMicrophoneEnabled(false);
    });
    return () => { offMute?.(); offDeafen?.(); offPttDown?.(); offPttUp?.(); };
  }, [toggleMic, toggleDeafen, isMicrophoneEnabled, deafened, voiceSettings.pttMode, localParticipant]);

  useEffect(() => {
    if (voiceSettings.pttMode) localParticipant?.setMicrophoneEnabled(false);
  }, [voiceSettings.pttMode, localParticipant]);


useEffect(() => {
  const handleForceMute = () => {
    micWasOnBeforeTestRef.current = !!localParticipant?.isMicrophoneEnabled;
    if (localParticipant?.isMicrophoneEnabled) {
      localParticipant.setMicrophoneEnabled(false);
    }
  };

const handleForceUnmute = () => {
      if (localParticipant && micWasOnBeforeTestRef.current) {
        localParticipant.setMicrophoneEnabled(true);
      }
      micWasOnBeforeTestRef.current = false;
    };

  window.addEventListener('force-mute-mic', handleForceMute);
  window.addEventListener('force-unmute-mic', handleForceUnmute);

  return () => {
    window.removeEventListener('force-mute-mic', handleForceMute);
    window.removeEventListener('force-unmute-mic', handleForceUnmute);
  };
}, [localParticipant]);

  const [nowPlaying, setNowPlaying] = useState(null);
  useEffect(() => {
    const handler = (data) => {
      if (!data || data.channelId !== channelId) return;
      setNowPlaying(data.title ? data : null);
    };
    socket.on('now_playing_update', handler);
    return () => socket.off('now_playing_update', handler);
  }, [channelId]);

  return (
    <>
      {nowPlaying && (
        <div
          style={{
            position: 'absolute',
            top: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 150,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            backgroundColor: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: '999px',
            padding: '7px 16px 7px 10px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            animation: 'fadeUp 0.2s ease'
          }}
        >
          <span style={{ width: '22px', height: '22px', borderRadius: '50%', backgroundColor: colors.brandDim, color: colors.brand, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon.Disc size={12} />
          </span>
          <span style={{ fontSize: '12.5px', fontWeight: 600, color: colors.text, whiteSpace: 'nowrap' }}>
            <span style={{ color: colors.brand, fontWeight: 700 }}>{nowPlaying.sender}</span> played &ldquo;{nowPlaying.title}&rdquo;
          </span>
        </div>
      )}

      {micError && (
        <div
          style={{
            position: 'absolute',
            top: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 200,
            backgroundColor: 'rgba(239, 68, 68, 0.95)',
            color: '#fff',
            fontFamily: fontBody,
            fontSize: '13px',
            fontWeight: 600,
            padding: '10px 16px',
            borderRadius: '10px',
            maxWidth: '90%',
            textAlign: 'center',
            boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
          }}
        >
          <span>Microphone error: {micError}</span>
          <button
            onClick={() => setMicError(null)}
            style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}
          >
            ✕
          </button>
        </div>
      )}

<VoiceChannelView
        username={username}
        roomName={roomName}
        channelType={channelType}
        profile={profile}
        streamSettings={streamSettings}
        memberMap={memberMap}
        onAvatarClick={onAvatarClick}
        deafened={deafened}
        onToggleDeafen={toggleDeafen}
        onToggleMic={toggleMic}
        minimized={minimized}
        isDragging={isDragging} // <--- PASS IT HERE
        channelId={channelId}
        authToken={authToken}
        token={token}
        voiceSettings={voiceSettings}
        onVoiceSettingsChange={onVoiceSettingsChange}
        myRole={myRole}
        serverId={serverId}
        remotePositions={remotePositions}
      />
      <CommandCapsule
        username={username}
        profile={profile}
        roomName={roomName}
        deafened={deafened}
        onToggleDeafen={toggleDeafen}
        onToggleMic={toggleMic}
        onOpenSettings={onOpenSettings}
        minimized={minimized}
        isDragging={isDragging}
      />

      <SmartAudioLeveler
        deafened={deafened}
        levelerEnabled={voiceSettings.levelerEnabled !== false}
        speakerDeviceId={streamSettings.speakerDeviceId}
        voiceSettings={voiceSettings}
        remoteVolumes={remoteVolumes}
        username={username}
        remotePositions={remotePositions}
      />
    </>
  );
}



// ============================================================================
// SCREEN SHARE: Custom Electron Picker
// ============================================================================
const qualityPresets = { SD: { res: 720, fps: 30 }, HD: { res: 1080, fps: 60 } };

function SharePickerModal({ defaults, onCancel, onStart }) {
  const [tab, setTab] = useState('windows');
  const [windows, setWindows] = useState([]);
  const [monitors, setMonitors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [quality, setQuality] = useState(defaults.res >= 1080 ? 'HD' : 'SD');
  const [audio, setAudio] = useState(defaults.audio ?? true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [fps, setFps] = useState(defaults.fps || qualityPresets.HD.fps);

  const refreshSources = async () => {
    if (!window.electronAPI) {
      console.warn('Electron API not found. Falling back to browser screen-share picker.');
      setWindows([]);
      setMonitors([]);
      setLoading(false);
      return;
    }
    try {
      const sources = await window.electronAPI.getSources();
      setWindows(sources.filter((s) => !s.isScreen));
      setMonitors(sources.filter((s) => s.isScreen));
      setLoading(false);
    } catch (e) {
      console.error('Could not list screen sources:', e);
      setLoading(false);
    }
  };

// Refresh once when opened, and whenever switching between Windows & Screens tabs
  useEffect(() => {
    refreshSources();
  }, [tab]);

  const list = tab === 'windows' ? windows : monitors;

  const handleStart = () => {
    const preset = qualityPresets[quality];
    if (!window.electronAPI || !selected) {
      onStart({ res: preset.res, fps, audio }, null);
      return;
    }
    onStart({ res: preset.res, fps, audio }, selected.id);
  };

  return (
    <>
      <div onClick={onCancel} style={{ position: 'fixed', inset: 0, zIndex: 49, backgroundColor: 'rgba(0,0,0,0.8)', WebkitAppRegion: 'no-drag' }} />
      <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 50, width: '700px', maxWidth: '92vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '20px', overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.8)', WebkitAppRegion: 'no-drag' }}>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, flexShrink: 0, padding: '0 12px' }}>
          {[
            { key: 'windows', label: 'Applications', icon: <Icon.Layers size={15} /> },
            { key: 'monitors', label: 'Entire Screen', icon: <Icon.Monitor size={15} /> },
          ].map((t) => (
            <button
              key={t.key}
              className="tab-btn"
              onClick={() => { setTab(t.key); setSelected(null); }}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                padding: '16px 10px', border: 'none', background: 'transparent', cursor: 'pointer',
                fontFamily: fontBody, fontWeight: 600, fontSize: '14px',
                color: tab === t.key ? colors.text : colors.textMuted,
                borderBottom: `2px solid ${tab === t.key ? colors.brand : 'transparent'}`,
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* Source grid */}
        <div className="scroll-thin" style={{ flex: 1, minHeight: '300px', overflowY: 'auto', padding: '24px' }}>
          {loading ? (
            <p style={{ color: colors.textFaint, fontSize: '14px', textAlign: 'center', marginTop: '60px', fontWeight: 500 }}>Looking for windows and screens…</p>
          ) : list.length === 0 ? (
            <p style={{ color: colors.textFaint, fontSize: '14px', textAlign: 'center', marginTop: '60px', fontWeight: 500 }}>Nothing to show here right now.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '16px' }}>
              {list.map((item) => {
                const key = `${tab}-${item.id}`;
                const isSel = selected?.kind === tab && selected?.id === item.id;
                const label = tab === 'windows' ? (item.name || 'Untitled window') : (item.name || `Display ${item.id}`);
                return (
                  <button
                    key={key}
                    onClick={() => setSelected({ kind: tab, id: item.id })}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px',
                      padding: '10px', borderRadius: '12px', cursor: 'pointer', textAlign: 'left',
                      background: isSel ? colors.brandDim : colors.panelAlt,
                      border: `2px solid ${isSel ? colors.brand : 'transparent'}`,
                      transition: 'border-color 0.1s, background-color 0.1s'
                    }}
                  >
                    <div style={{ position: 'relative', width: '100%', aspectRatio: '16/10', borderRadius: '8px', overflow: 'hidden', backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
                      {item.thumbnail ? (
                        <img src={item.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span style={{ color: colors.textFaint }}><Icon.Monitor size={24} /></span>
                      )}
                      {isSel && (
                        <span style={{ position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px', borderRadius: '50%', background: colors.brand, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>
                          <Icon.Check size={14} />
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: colors.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer: quality toggle, advanced settings, start */}
        <div style={{ borderTop: `1px solid ${colors.border}`, padding: '16px 24px', flexShrink: 0, backgroundColor: colors.panel }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '10px' }}>
            <div style={{ display: 'flex', border: `1px solid ${colors.border}`, borderRadius: '10px', overflow: 'hidden', backgroundColor: colors.bg }}>
              {['SD', 'HD'].map((q) => (
                <button key={q} onClick={() => { setQuality(q); setFps(qualityPresets[q].fps); }} style={{ padding: '8px 20px', border: 'none', cursor: 'pointer', fontFamily: fontBody, fontWeight: 700, fontSize: '13px', background: quality === q ? colors.brand : 'transparent', color: quality === q ? 'white' : colors.textMuted }}>
                  {q}
                </button>
              ))}
            </div>
            <div style={{ position: 'relative' }}>
              <button className="icon-btn" onClick={() => setShowAdvanced((v) => !v)} title="More options" style={{ width: '38px', height: '38px', borderRadius: '10px', border: `1px solid ${colors.border}`, background: colors.bg, color: colors.textMuted, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.Settings size={16} />
              </button>
              {showAdvanced && (
                <div className="popover-card" style={{ position: 'absolute', bottom: '48px', right: 0, width: '240px', backgroundColor: colors.panelAlt, border: `1px solid ${colors.border}`, borderRadius: '12px', padding: '16px', boxShadow: '0 16px 40px rgba(0,0,0,0.6)' }}>
                  <p style={{ margin: '0 0 10px', fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', color: colors.textFaint, textTransform: 'uppercase' }}>Frame rate</p>
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
                    {[15, 30, 60].map((f) => (
                      <button key={f} onClick={() => setFps(f)} style={{ flex: 1, padding: '8px 0', borderRadius: '8px', cursor: 'pointer', fontFamily: fontBody, fontWeight: 600, fontSize: '13px', border: `1px solid ${fps === f ? colors.brand : colors.border}`, background: fps === f ? colors.brandDim : colors.bg, color: fps === f ? colors.text : colors.textMuted }}>
                        {f}
                      </button>
                    ))}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                    <span style={{ fontSize: '13px', fontWeight: 500, color: colors.text }}>Share system audio</span>
                    <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} style={{ width: '16px', height: '16px', accentColor: colors.brand, cursor: 'pointer' }} />
                  </label>
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button onClick={onCancel} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, fontFamily: fontBody, fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>Cancel</button>
            <button
              className="connect-btn"
              disabled={!selected}
              onClick={handleStart}
              style={{ flex: 2, padding: '12px', borderRadius: '12px', border: 'none', background: selected ? colors.brand : colors.border, color: selected ? 'white' : colors.textFaint, fontFamily: fontBody, fontWeight: 700, fontSize: '14px', cursor: selected ? 'pointer' : 'not-allowed' }}
            >
              {selected ? 'Start Streaming' : 'Pick a screen'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SharingBar({ onStop }) {
  return (
    <div className="share-bar" style={{ position: 'absolute', bottom: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: 25, display: 'flex', alignItems: 'center', gap: '16px', backgroundColor: 'rgba(24, 24, 27, 0.95)', backdropFilter: 'blur(12px)', border: `1px solid ${colors.border}`, borderRadius: '999px', padding: '10px 12px 10px 20px', boxShadow: '0 16px 40px rgba(0,0,0,0.6)', pointerEvents: 'auto', WebkitAppRegion: 'no-drag' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: fontBody, fontWeight: 600, fontSize: '13.5px', color: colors.text, whiteSpace: 'nowrap' }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.danger, animation: 'pulseGlow 1.6s infinite' }} />
        You are sharing your screen
      </span>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStop(); }}
        style={{ display: 'flex', alignItems: 'center', gap: '6px', border: 'none', borderRadius: '999px', padding: '8px 16px', backgroundColor: colors.danger, color: 'white', fontFamily: fontBody, fontWeight: 600, fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap' }}
      >
        <Icon.Monitor size={14} /> Stop sharing
      </button>
    </div>
  );
}

// ============================================================================
// PROFILE: popover + settings modal
// ============================================================================
function ProfilePopover({ username, profile, onEdit, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 29, WebkitAppRegion: 'no-drag' }} />
      <div className="popover-card" style={{ position: 'fixed', left: '12px', bottom: '116px', width: '280px', zIndex: 30, backgroundColor: colors.panelAlt, border: `1px solid ${colors.border}`, borderRadius: '16px', overflow: 'hidden', boxShadow: '0 16px 40px rgba(0,0,0,0.6)', WebkitAppRegion: 'no-drag' }}>
        <div style={{ height: '72px', background: profile.bannerUrl ? `url(${profile.bannerUrl}) center/cover` : profile.bannerColor }} />
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '50%', marginTop: '-32px', marginBottom: '12px', border: `4px solid ${colors.panelAlt}`, overflow: 'hidden', backgroundColor: colorForName(username), display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '20px', color: '#fff' }}>
            {profile.avatarUrl ? <img src={profile.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(username)}
          </div>
          <div style={{ fontFamily: fontDisplay, fontWeight: 700, fontSize: '18px', color: colors.text }}>{username}</div>
          <div style={{ fontSize: '13px', fontWeight: 500, color: colors.online, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: colors.online }} /> Online
          </div>
          <button onClick={onEdit} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, fontWeight: 600, fontSize: '13.5px', cursor: 'pointer' }}>Edit Profile</button>
        </div>
      </div>
    </>
  );
}

// MINI/FULL PROFILE: click any avatar
function AddFriendButton({ targetUsername, currentUsername, authToken, full }) {
  const api = useApi(authToken);
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [errorMsg, setErrorMsg] = useState('');

  if (!authToken || !targetUsername || targetUsername.toLowerCase() === (currentUsername || '').toLowerCase()) {
    return null;
  }

  const send = async () => {
    if (status === 'sending' || status === 'sent') return;
    setStatus('sending');
    setErrorMsg('');
    try {
      await api('/friends/requests', { method: 'POST', body: JSON.stringify({ username: targetUsername }) });
      setStatus('sent');
    } catch (e) {
      setStatus('error');
      setErrorMsg(e.message || 'Could not send request.');
    }
  };

  const label = status === 'sent' ? 'Request sent' : status === 'sending' ? 'Sending…' : status === 'error' ? 'Try again' : 'Add Friend';

  return (
    <button
      onClick={send}
      disabled={status === 'sending' || status === 'sent'}
      title={errorMsg || undefined}
      style={{
        width: full ? '100%' : undefined,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        padding: full ? '10px' : '9px 14px', borderRadius: '10px',
        border: status === 'sent' ? `1px solid ${colors.online}` : 'none',
        backgroundColor: status === 'sent' ? 'rgba(126,231,135,0.12)' : colors.brand,
        color: status === 'sent' ? colors.online : '#fff',
        fontFamily: fontBody, fontWeight: 600, fontSize: '13.5px',
        cursor: status === 'sending' || status === 'sent' ? 'default' : 'pointer',
      }}
    >
      {status === 'sent' ? <Icon.Check size={14} /> : <Icon.UserPlus size={14} />}
      {label}
    </button>
  );
}

function UserMiniProfile({ user, currentUsername, authToken, onViewFull, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 49, WebkitAppRegion: 'no-drag' }} />
      <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '280px', zIndex: 50, backgroundColor: colors.panelAlt, border: `1px solid ${colors.border}`, borderRadius: '16px', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.6)', WebkitAppRegion: 'no-drag' }}>
        <div style={{ height: '72px', background: user.bannerUrl ? `url(${user.bannerUrl}) center/cover` : (user.bannerColor || colors.brandDim) }} />
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '50%', marginTop: '-32px', marginBottom: '12px', border: `4px solid ${colors.panelAlt}`, overflow: 'hidden', background: user.avatarUrl ? 'transparent' : colorForName(user.username), display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '20px', color: '#fff' }}>
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(user.username)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <span style={{ fontFamily: fontDisplay, fontWeight: 700, fontSize: '18px', color: colors.text }}>{user.username}</span>
            <RoleBadge role={user.role} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <AddFriendButton targetUsername={user.username} currentUsername={currentUsername} authToken={authToken} full />
            <button onClick={onViewFull} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, fontWeight: 600, fontSize: '13.5px', cursor: 'pointer' }}>View Full Profile</button>
          </div>
        </div>
      </div>
    </>
  );
}

function UserFullProfileModal({ user, currentUsername, authToken, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 49, backgroundColor: 'rgba(0,0,0,0.8)', WebkitAppRegion: 'no-drag' }} />
      <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 50, width: '420px', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '20px', boxShadow: '0 30px 80px rgba(0,0,0,0.8)', overflow: 'hidden', WebkitAppRegion: 'no-drag' }}>
        <div style={{ height: '140px', position: 'relative', background: user.bannerUrl ? `url(${user.bannerUrl}) center/cover` : (user.bannerColor || colors.brandDim) }}>
          <button onClick={onClose} className="icon-btn" style={{ position: 'absolute', top: '12px', right: '12px', border: 'none', background: 'rgba(9, 9, 11, 0.6)', backdropFilter: 'blur(8px)', color: 'white', cursor: 'pointer', display: 'flex', borderRadius: '50%', padding: '8px' }} aria-label="Close"><Icon.X size={16} /></button>
        </div>
        <div style={{ padding: '0 24px 28px', position: 'relative', zIndex: 1 }}>
          <div style={{ width: '100px', height: '100px', borderRadius: '50%', border: `6px solid ${colors.panel}`, marginTop: '-50px', overflow: 'hidden', background: user.avatarUrl ? 'transparent' : colorForName(user.username), display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '32px', color: '#fff' }}>
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(user.username)}
          </div>
          <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h2 style={{ margin: 0, fontSize: '24px', color: colors.text }}>{user.username}</h2>
            <RoleBadge role={user.role} />
          </div>
          <div style={{ marginTop: '18px' }}>
            <AddFriendButton targetUsername={user.username} currentUsername={currentUsername} authToken={authToken} />
          </div>
        </div>
      </div>
    </>
  );
}

const PTT_KEY_OPTIONS = [
  { value: 'Space', label: 'Space' },
  { value: 'CapsLock', label: 'Caps Lock' },
  { value: 'Backquote', label: '` (backtick)' },
  { value: 'AltRight', label: 'Right Alt' },
  { value: 'CtrlRight', label: 'Right Ctrl' },
];

function HotkeyRecorder({ label, value, onChange, disabled }) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return undefined;
    const handler = (e) => {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      onChange(parts.join('+'));
      setRecording(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording, onChange]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
      <span style={{ fontSize: '13px', color: colors.text, fontWeight: 500 }}>{label}</span>
      <button
        onClick={() => setRecording(true)}
        disabled={disabled}
        style={{ minWidth: '160px', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${recording ? colors.brand : colors.border}`, background: colors.bg, color: recording ? colors.brand : colors.textMuted, fontFamily: 'monospace', fontSize: '12px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}
      >
        {recording ? 'Press keys…' : (value || 'Not set')}
      </button>
    </div>
  );
}

function SettingsModal({ authToken, username, profile, streamSettings, voiceSettings, onSave, onClose }) {
  const [draftProfile, setDraftProfile] = useState(profile);
  const [draftStream, setDraftStream] = useState({ micDeviceId: '', speakerDeviceId: '', inputVolume: 1, ...streamSettings });
  const [draftVoice, setDraftVoice] = useState({ levelerEnabled: true, krispEnabled: true, pttMode: false, hotkeys: { toggleMute: 'CommandOrControl+Shift+M', toggleDeafen: 'CommandOrControl+Shift+D', pushToTalk: 'Space' }, ...voiceSettings });
  const hasElectronHotkeys = typeof window !== 'undefined' && !!window.electronAPI?.hotkeys;
  const [tab, setTab] = useState('profile');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [mics, setMics] = useState([]);
  const [speakers, setSpeakers] = useState([]);
  const [deviceError, setDeviceError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // --- NEW: Mic Test State ---
const [isTestingMic, setIsTestingMic] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const hasMutedRoomMicRef = useRef(false);
  const testAudioRef = useRef({ ctx: null, stream: null, animId: null, gainNode: null, gateNode: null });
  const avatarInputRef = useRef(null);
  const bannerInputRef = useRef(null);

  useEffect(() => {
    if (tab !== 'devices') return;
    (async () => {
      try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        if (devices.every((d) => !d.label)) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
        }
        setMics(devices.filter((d) => d.kind === 'audioinput'));
        setSpeakers(devices.filter((d) => d.kind === 'audiooutput'));
      } catch (e) {
        setDeviceError("Couldn't access your microphone list — check mic permissions.");
      }
    })();
  }, [tab]);

const stopMicTest = useCallback(() => {
  const shouldUnmute = hasMutedRoomMicRef.current;
  hasMutedRoomMicRef.current = false;

  if (testAudioRef.current.animId) cancelAnimationFrame(testAudioRef.current.animId);
  if (testAudioRef.current.stream) {
    testAudioRef.current.stream.getTracks().forEach((t) => t.stop());
  }
  if (testAudioRef.current.ctx) {
    testAudioRef.current.ctx.close().catch(() => {});
  }
  testAudioRef.current = { ctx: null, stream: null, animId: null, gainNode: null, gateNode: null };
  setIsTestingMic(false);
  setMicLevel(0);

  if (shouldUnmute) {
    window.dispatchEvent(new CustomEvent('force-unmute-mic'));
  }
}, []);

  const startMicTest = async () => {
    stopMicTest();
    hasMutedRoomMicRef.current = true;
    window.dispatchEvent(new CustomEvent('force-mute-mic'));
    try {
      const voiceConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: draftStream.micDeviceId
            ? { ...voiceConstraints, deviceId: { exact: draftStream.micDeviceId } }
            : voiceConstraints,
        });
      } catch (err) {
        // A previously selected device can disappear after reconnecting a headset.
        if (draftStream.micDeviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: voiceConstraints });
        } else {
          throw err;
        }
      }
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx({ sampleRate: 48000 })
      if (ctx.state === 'suspended') await ctx.resume();

      if (ctx.setSinkId && draftStream.speakerDeviceId) {
        ctx.setSinkId(draftStream.speakerDeviceId).catch(() => {});
      }

      const source = ctx.createMediaStreamSource(stream);
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 110;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 7500;
      let denoiseNode = null;
      let noiseGateWorklet = null;
      try {
        const wasm = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseWasmSimdPath });
        await ctx.audioWorklet.addModule(rnnoiseWorkletPath);
        denoiseNode = new RnnoiseWorkletNode(ctx, { wasmBinary: wasm, maxChannels: 1 });
        await ctx.audioWorklet.addModule(noiseGateWorkletPath);
        noiseGateWorklet = new NoiseGateWorkletNode(ctx, {
          openThreshold: -45,
          closeThreshold: -55,
          holdMs: 220,
          maxChannels: 1,
        });
      } catch (err) {
        console.warn('Advanced mic test suppression unavailable; using adaptive gate.', err);
      }
      const gateNode = ctx.createScriptProcessor(2048, 1, 1);
      const gateState = { envelope: 0, gain: 1 };
      gateNode.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const output = event.outputBuffer.getChannelData(0);
        for (let i = 0; i < input.length; i++) {
          const level = Math.abs(input[i]);
          gateState.envelope += (level - gateState.envelope) * 0.0017;
          const target = gateState.envelope > 0.006 ? 1 : 0.05;
          const speed = target > gateState.gain ? 0.05 : 0.008;
          gateState.gain += (target - gateState.gain) * speed;
          output[i] = input[i] * gateState.gain;
        }
      };
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -28;
      compressor.knee.value = 12;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.2;
      const makeupGain = ctx.createGain();
      makeupGain.gain.value = 2.4; // compensate for what the compressor squashes out
      const gainNode = ctx.createGain();
      gainNode.gain.value = draftStream.inputVolume ?? 1;
      const centerOutput = ctx.createChannelMerger(2);

      const analyser = ctx.createAnalyser();
      gainNode.connect(centerOutput, 0, 0);
      gainNode.connect(centerOutput, 0, 1);
      centerOutput.connect(analyser);
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;

      source.connect(highpass);
      highpass.connect(lowpass);
      if (denoiseNode && noiseGateWorklet) {
        lowpass.connect(denoiseNode);
        denoiseNode.connect(noiseGateWorklet);
        noiseGateWorklet.connect(compressor);
      } else {
        lowpass.connect(gateNode);
        gateNode.connect(compressor);
      }
      compressor.connect(makeupGain);
      makeupGain.connect(gainNode);
      analyser.connect(ctx.destination);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateMeter = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        setMicLevel(Math.min(100, Math.round((avg / 128) * 100)));
        testAudioRef.current.animId = requestAnimationFrame(updateMeter);
      };

      testAudioRef.current = { ctx, stream, gainNode, gateNode, animId: requestAnimationFrame(updateMeter) };
      setIsTestingMic(true);
    } catch (err) {
      console.error('Mic test failed:', err);
      const reason = err?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow microphone access and try again.'
        : err?.name === 'NotFoundError'
          ? 'No microphone was found. Connect a microphone and try again.'
          : `Could not start mic test (${err?.name || 'unknown error'}).`;
      setDeviceError(reason);
      stopMicTest();
    }
  };

  const toggleMicTest = () => {
    if (isTestingMic) stopMicTest();
    else startMicTest();
  };

  useEffect(() => {
    if (testAudioRef.current.gainNode) {
      testAudioRef.current.gainNode.gain.value = draftStream.inputVolume ?? 1;
    }
  }, [draftStream.inputVolume]);

  useEffect(() => {
    return () => stopMicTest();
  }, [tab, stopMicTest]);
  // ---------------------------

  const uploadProfileFile = async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/profile/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    return data.url.startsWith('http') ? data.url : `${API_BASE}${data.url}`;
  };

  const handleAvatarFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const url = await uploadProfileFile(file);
      setDraftProfile((prev) => ({ ...prev, avatarUrl: url }));
    } catch (err) {
      console.error(err);
    } finally {
      setUploadingAvatar(false);
      e.target.value = '';
    }
  };

  const handleBannerFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingBanner(true);
    try {
      const url = await uploadProfileFile(file);
      setDraftProfile((prev) => ({ ...prev, bannerUrl: url, bannerColor: null }));
    } catch (err) {
      console.error(err);
    } finally {
      setUploadingBanner(false);
      e.target.value = '';
    }
  };

  const tabs = [
    { id: 'profile', label: 'Profile' },
    { id: 'devices', label: 'Mic & Speakers' },
    { id: 'stream', label: 'Stream' },
    { id: 'voice', label: 'Voice' },
  ];

  const updateHotkey = (key, value) => setDraftVoice((prev) => ({ ...prev, hotkeys: { ...prev.hotkeys, [key]: value } }));

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 39, backgroundColor: 'rgba(0,0,0,0.7)', WebkitAppRegion: 'no-drag' }} />
      <div className="modal-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 40, width: '440px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '20px', overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.8)', WebkitAppRegion: 'no-drag' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: fontDisplay, fontWeight: 700, fontSize: '18px', color: colors.text }}>Settings</span>
          <button onClick={onClose} className="icon-btn" style={{ border: 'none', background: 'transparent', color: colors.textMuted, cursor: 'pointer', display: 'flex' }}><Icon.X size={20} /></button>
        </div>

        <div style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, flexShrink: 0, padding: '0 12px' }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`settings-tab${tab === t.id ? ' active' : ''}`}
              style={{ padding: '14px 16px', background: 'none', border: 'none', borderBottom: '2px solid transparent', color: tab === t.id ? colors.text : colors.textMuted, fontFamily: fontBody, fontWeight: 600, fontSize: '13.5px', cursor: 'pointer' }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="scroll-thin" style={{ overflowY: 'auto' }}>
          {tab === 'profile' && (
            <>
              <div style={{ height: '120px', position: 'relative', background: draftProfile.bannerUrl ? `url(${draftProfile.bannerUrl}) center/cover` : draftProfile.bannerColor }}>
                <button onClick={() => bannerInputRef.current?.click()} className="icon-btn" disabled={uploadingBanner} style={{ position: 'absolute', top: '12px', right: '12px', border: 'none', borderRadius: '8px', backgroundColor: 'rgba(9, 9, 11, 0.7)', backdropFilter: 'blur(8px)', color: 'white', padding: '8px 12px', fontSize: '12px', fontFamily: fontBody, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Icon.Image size={14} /> {uploadingBanner ? 'Uploading…' : 'Change banner'}
                </button>
                <input ref={bannerInputRef} type="file" accept="image/*,image/gif" onChange={handleBannerFile} style={{ display: 'none' }} />

                <div style={{ position: 'absolute', left: '24px', bottom: '-40px' }}>
                  <div onClick={() => avatarInputRef.current?.click()} style={{ width: '80px', height: '80px', borderRadius: '50%', border: `6px solid ${colors.panel}`, backgroundColor: colorForName(username), overflow: 'hidden', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                    {draftProfile.avatarUrl ? <img src={draftProfile.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontFamily: fontDisplay, fontWeight: 800, fontSize: '28px', color: '#fff' }}>{initialsForName(username)}</span>}
                    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', opacity: 0, transition: 'opacity 0.2s' }} onMouseEnter={(e) => e.currentTarget.style.opacity = '1'} onMouseLeave={(e) => e.currentTarget.style.opacity = '0'}>
                      {uploadingAvatar ? <span style={{ fontSize: '10px', fontWeight: 700 }}>...</span> : <Icon.Image size={20} />}
                    </div>
                  </div>
                  <input ref={avatarInputRef} type="file" accept="image/*,image/gif" onChange={handleAvatarFile} style={{ display: 'none' }} />
                </div>
              </div>

              <div style={{ padding: '54px 24px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <p style={{ margin: 0, fontSize: '13px', color: colors.textFaint, fontWeight: 500 }}>GIFs work for both — they'll animate for everyone.</p>
                <div style={{ display: 'flex', gap: '10px' }}>
                  {bannerSwatches.map((c) => (
                    <button key={c} className="swatch" onClick={() => setDraftProfile((prev) => ({ ...prev, bannerColor: c, bannerUrl: null }))} style={{ width: '28px', height: '28px', borderRadius: '50%', backgroundColor: c, cursor: 'pointer', border: draftProfile.bannerColor === c && !draftProfile.bannerUrl ? `2px solid ${colors.text}` : '2px solid transparent', transition: 'transform 0.1s' }} />
                  ))}
                </div>

                <div>
                  <p style={{ fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: '0 0 8px' }}>Status</p>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      value={draftProfile.statusEmoji || ''}
                      onChange={(e) => setDraftProfile((prev) => ({ ...prev, statusEmoji: e.target.value.slice(0, 2) }))}
                      placeholder="🎷"
                      maxLength={2}
                      style={{ width: '48px', textAlign: 'center', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, fontSize: '16px', boxSizing: 'border-box' }}
                    />
                    <input
                      value={draftProfile.statusText || ''}
                      onChange={(e) => setDraftProfile((prev) => ({ ...prev, statusText: e.target.value.slice(0, 100) }))}
                      placeholder="What are you up to?"
                      style={{ flex: 1, padding: '10px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, fontSize: '14px', boxSizing: 'border-box' }}
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {tab === 'devices' && (
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {deviceError && <p style={{ margin: 0, color: colors.danger, fontSize: '13px', fontWeight: 500 }}>{deviceError}</p>}

              <div>
                <p style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: '0 0 10px' }}><Icon.Mic size={14} /> Microphone</p>
                <select
                  className="device-select"
                  value={draftStream.micDeviceId}
                  onChange={(e) => setDraftStream((prev) => ({ ...prev, micDeviceId: e.target.value }))}
                  style={{ width: '100%', backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '12px', fontFamily: fontBody, fontSize: '14px' }}
                >
                  <option value="">System default</option>
                  {mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
                </select>
              </div>

              {/* NEW: Input Volume & Mic Test UI */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <p style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: 0 }}>
                    <Icon.Volume size={14} /> Input Volume
                  </p>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: colors.brand }}>
                    {Math.round((draftStream.inputVolume ?? 1) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={draftStream.inputVolume ?? 1}
                  onChange={(e) => setDraftStream((prev) => ({ ...prev, inputVolume: parseFloat(e.target.value) }))}
                  style={{ width: '100%', accentColor: colors.brand, cursor: 'pointer' }}
                />
              </div>

              <div style={{ backgroundColor: colors.panelAlt, padding: '16px', borderRadius: '12px', border: `1px solid ${colors.borderSoft}` }}>
                <p style={{ fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: '0 0 8px' }}>
                  Mic Test
                </p>
                <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: isTestingMic ? colors.brand : colors.textMuted }}>
  {isTestingMic 
    ? "Your room mic is currently muted so others cannot hear you testing." 
    : "Having mic trouble? Click below to hear yourself and test your volume."}
</p>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button
                    type="button"
                    onClick={toggleMicTest}
                    style={{
                      padding: '9px 16px',
                      borderRadius: '8px',
                      border: 'none',
                      background: isTestingMic ? colors.danger : colors.brand,
                      color: '#fff',
                      fontFamily: fontBody,
                      fontWeight: 700,
                      fontSize: '13px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      transition: 'background-color 0.15s ease',
                      flexShrink: 0
                    }}
                  >
                    {isTestingMic ? <Icon.MicOff size={15} /> : <Icon.Mic size={15} />}
                    {isTestingMic ? 'Stop Test' : "Let's Check"}
                  </button>

                  <div style={{ flex: 1, height: '12px', backgroundColor: colors.bg, borderRadius: '6px', overflow: 'hidden', border: `1px solid ${colors.border}` }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.min(100, micLevel)}%`,
                        backgroundColor: micLevel > 80 ? colors.danger : micLevel > 50 ? colors.gold : colors.online,
                        borderRadius: '6px',
                        transition: 'width 0.05s ease-out',
                      }}
                    />
                  </div>
                </div>
              </div>

              <div>
                <p style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: '0 0 10px' }}><Icon.Headphones size={14} /> Speakers</p>
                <select
                  className="device-select"
                  value={draftStream.speakerDeviceId}
                  onChange={(e) => setDraftStream((prev) => ({ ...prev, speakerDeviceId: e.target.value }))}
                  style={{ width: '100%', backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '12px', fontFamily: fontBody, fontSize: '14px' }}
                >
                  <option value="">System default</option>
                  {speakers.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Speaker'}</option>)}
                </select>
              </div>
              <p style={{ margin: 0, fontSize: '13px', color: colors.textFaint, lineHeight: 1.5 }}>Changes apply the moment you're connected to voice.</p>
            </div>
          )}

          {tab === 'stream' && (
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <p style={{ fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: 0 }}>Screen Share Quality</p>
              <div style={{ display: 'flex', gap: '12px' }}>
                <select
                  value={draftStream.fps}
                  onChange={(e) => setDraftStream((prev) => ({ ...prev, fps: Number(e.target.value) }))}
                  style={{ flex: 1, backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '12px', fontFamily: fontBody, fontSize: '14px' }}
                >
                  <option value={30}>30 FPS</option>
                  <option value={60}>60 FPS</option>
                </select>

                <select
                  value={draftStream.res}
                  onChange={(e) => setDraftStream((prev) => ({ ...prev, res: Number(e.target.value) }))}
                  style={{ flex: 1, backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '12px', fontFamily: fontBody, fontSize: '14px' }}
                >
                  <option value={720}>720p HD</option>
                  <option value={1024}>1024p HD</option>
                  <option value={1080}>1080p FHD</option>
                </select>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', color: colors.text, cursor: 'pointer', fontWeight: 500 }}>
                <input type="checkbox" checked={draftStream.audio} onChange={(e) => setDraftStream((prev) => ({ ...prev, audio: e.target.checked }))} style={{ width: '16px', height: '16px', accentColor: colors.brand }} />
                Capture System Audio
              </label>
            </div>
          )}

          {tab === 'voice' && (
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              <div>
                <p style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: '0 0 10px' }}><Icon.Mic size={14} /> Noise Suppression</p>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', color: colors.text, cursor: 'pointer', fontWeight: 500, marginBottom: '20px' }}>
                  <input 
                    type="checkbox" 
                    checked={draftVoice.krispEnabled} 
                    onChange={(e) => setDraftVoice((prev) => ({ ...prev, krispEnabled: e.target.checked }))} 
                    style={{ width: '16px', height: '16px', accentColor: colors.brand }} 
                  />
                  Krisp Enhanced Noise Cancellation
                </label>
              </div>

              <div>
                <p style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: '0 0 10px' }}><Icon.Sliders size={14} /> Audio Leveler</p>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', color: colors.text, cursor: 'pointer', fontWeight: 500 }}>
                  <input type="checkbox" checked={draftVoice.levelerEnabled} onChange={(e) => setDraftVoice((prev) => ({ ...prev, levelerEnabled: e.target.checked }))} style={{ width: '16px', height: '16px', accentColor: colors.brand }} />
                  Smart Limiter (auto-boost quiet mics, tame loud spikes)
                </label>
              </div>

              <div>
                <p style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: '0 0 10px' }}><Icon.Mic size={14} /> Push-to-Talk</p>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', color: colors.text, cursor: 'pointer', fontWeight: 500, marginBottom: '10px' }}>
                  <input type="checkbox" checked={draftVoice.pttMode} onChange={(e) => setDraftVoice((prev) => ({ ...prev, pttMode: e.target.checked }))} style={{ width: '16px', height: '16px', accentColor: colors.brand }} />
                  Enable push-to-talk (mic starts muted, hold key to speak)
                </label>
                <select
                  className="device-select"
                  value={draftVoice.hotkeys.pushToTalk}
                  onChange={(e) => updateHotkey('pushToTalk', e.target.value)}
                  disabled={!draftVoice.pttMode || !hasElectronHotkeys}
                  style={{ width: '100%', backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: '10px', padding: '12px', fontFamily: fontBody, fontSize: '14px', opacity: (!draftVoice.pttMode || !hasElectronHotkeys) ? 0.5 : 1 }}
                >
                  {PTT_KEY_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              </div>

              <div>
                <p style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, color: colors.textFaint, textTransform: 'uppercase', margin: '0 0 10px' }}><Icon.Keyboard size={14} /> Global Hotkeys</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <HotkeyRecorder label="Toggle Mute" value={draftVoice.hotkeys.toggleMute} onChange={(v) => updateHotkey('toggleMute', v)} disabled={!hasElectronHotkeys} />
                  <HotkeyRecorder label="Toggle Deafen" value={draftVoice.hotkeys.toggleDeafen} onChange={(v) => updateHotkey('toggleDeafen', v)} disabled={!hasElectronHotkeys} />
                </div>
                {!hasElectronHotkeys && (
                  <p style={{ margin: '12px 0 0', fontSize: '12px', color: colors.textFaint, lineHeight: 1.5 }}>Global hotkeys and sound cues only work in the desktop app, even while another game is full screen.</p>
                )}
              </div>
            </div>
          )}

          <div style={{ padding: '8px 24px 24px' }}>
            {saveError && <p style={{ margin: '0 0 12px', fontSize: '13px', fontWeight: 500, color: colors.danger }}>{saveError}</p>}
            <button
              className="connect-btn"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setSaveError('');
                try {
                  if (hasElectronHotkeys) await window.electronAPI.hotkeys.update(draftVoice.hotkeys);
                  await onSave(draftProfile, draftStream, draftVoice);
                } catch (e) {
                  setSaveError(e.message || 'Could not save — please try again.');
                } finally {
                  setSaving(false);
                }
              }}
              style={{ width: '100%', padding: '14px', marginTop: '10px', borderRadius: '12px', border: 'none', background: colors.brand, color: 'white', fontFamily: fontDisplay, fontWeight: 700, fontSize: '14px', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// VOICE: Extracts the connected users to show in the sidebar
// ============================================================================
function VoiceReporter({ setVoiceUsers }) {
  const participants = useParticipants();
  useEffect(() => {
    const identities = participants.map(p => p.identity).sort();
    setVoiceUsers(prev => (prev.join() === identities.join() ? prev : identities));
  }, [participants, setVoiceUsers]);
  return null;
}


const ChatMessageItem = memo(({ 
  msg, isMe, grouped, isPending, isEditing, canDelete, user,
  editDraft, setEditDraft, handleEditKeyDown, cancelEditMessage, saveEditMessage,
  startEditMessage, setConfirmDeleteMessage, togglePin,
  openUserProfile, memberMap, customEmojiMap,
  emojiPickerOpenFor, emojiPickerAnchorEl, openEmojiPicker, closeEmojiPicker, toggleReaction,
  customEmojis
}) => {
  const isAnotherMenuOpen = emojiPickerOpenFor && emojiPickerOpenFor !== msg.id;
return (<div data-msg-text={msg.text || ''} data-msg-id={msg.id || msg.clientId || ''} data-msg-isme={isMe ? 'true' : 'false'} data-msg-candelete={canDelete ? 'true' : 'false'} data-msg-pinned={msg.pinned ? 'true' : 'false'} className="msg-row" style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', padding: grouped ? '2px 8px' : '16px 8px 2px', borderRadius: '8px', position: 'relative', opacity: isPending ? 0.65 : 1, transition: 'opacity 0.15s' }}>
      {msg.id && !isEditing && !isAnotherMenuOpen && (
        <div className="msg-action-btn" style={{ position: 'absolute', top: '-16px', right: '16px', display: 'flex', alignItems: 'center', gap: '2px', backgroundColor: colors.panel, border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '2px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', zIndex: 10, opacity: emojiPickerOpenFor === msg.id ? 1 : undefined }}>
          <button className="icon-btn" onClick={(e) => openEmojiPicker(msg.id, e)} title="Add Reaction" style={{ border: 'none', cursor: 'pointer', borderRadius: '6px', padding: '6px', display: 'flex', background: emojiPickerOpenFor === msg.id ? colors.brandDim : 'transparent', color: emojiPickerOpenFor === msg.id ? colors.brand : colors.textMuted }}>
            <Icon.Smile size={14} />
          </button>
          {isMe && (
            <button className="icon-btn" onClick={() => startEditMessage(msg)} title="Edit" style={{ border: 'none', cursor: 'pointer', borderRadius: '6px', padding: '6px', display: 'flex', background: 'transparent', color: colors.textMuted }}>
              <Icon.Edit size={14} />
            </button>
          )}
          <button className="icon-btn" onClick={() => togglePin(msg)} title={msg.pinned ? 'Unpin' : 'Pin'} style={{ border: 'none', cursor: 'pointer', borderRadius: '6px', padding: '6px', display: 'flex', background: msg.pinned ? colors.goldDim : 'transparent', color: msg.pinned ? colors.gold : colors.textMuted }}>
            <Icon.Pin size={14} />
          </button>
          {canDelete && (
            <>
              <div style={{ width: '1px', height: '14px', backgroundColor: colors.borderSoft, margin: '0 2px' }} />
              <button className="icon-btn" onClick={() => setConfirmDeleteMessage(msg)} title="Delete" style={{ border: 'none', cursor: 'pointer', borderRadius: '6px', padding: '6px', display: 'flex', background: 'transparent', color: colors.danger }}>
                <Icon.Trash size={14} />
              </button>
            </>
          )}
        </div>
      )}

      <div style={{ width: '44px', flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {!grouped ? (
          <div onClick={() => openUserProfile(memberMap[msg.sender] || { username: msg.sender, avatarUrl: msg.senderAvatarUrl })} style={{ width: '40px', height: '40px', borderRadius: '50%', overflow: 'hidden', background: msg.senderAvatarUrl ? 'transparent' : colorForName(msg.sender), display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '15px', color: '#fff', cursor: 'pointer', marginTop: '2px' }}>
            {msg.senderAvatarUrl ? <img src={msg.senderAvatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(msg.sender)}
          </div>
        ) : (
          <span className="msg-time" style={{ fontSize: '10px', color: colors.textFaint, fontWeight: 600, whiteSpace: 'nowrap', lineHeight: '22px' }}>{formatMsgTime(msg.at)}</span>
        )}
      </div>
      <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
        {!grouped && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '2px' }}>
            <span style={{ fontSize: '15px', fontWeight: 700, color: isMe ? colors.brand : colors.text }}>{msg.sender}</span>
            <span style={{ fontSize: '11px', color: colors.textFaint, fontWeight: 500 }}>{formatMsgTime(msg.at)}</span>
          </div>
        )}
        {isEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' }}>
            <textarea autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)} onKeyDown={(e) => handleEditKeyDown(e, msg)} onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)} rows={Math.min(6, Math.max(1, editDraft.split('\n').length))} style={{ width: '100%', resize: 'none', fontFamily: fontBody, fontSize: '14.5px', lineHeight: '22px', color: colors.text, background: colors.panelAlt, border: `1px solid ${colors.brand}`, borderRadius: '8px', padding: '6px 10px', outline: 'none' }} />
            <div style={{ display: 'flex', gap: '8px', fontSize: '11px', fontWeight: 600, color: colors.textFaint }}>
              <span>escape to cancel • enter to save</span>
              <button onClick={cancelEditMessage} style={{ border: 'none', background: 'transparent', color: colors.textMuted, cursor: 'pointer', fontWeight: 700, fontSize: '11px', padding: 0 }}>Cancel</button>
              <button onClick={() => saveEditMessage(msg)} style={{ border: 'none', background: 'transparent', color: colors.brand, cursor: 'pointer', fontWeight: 700, fontSize: '11px', padding: 0 }}>Save</button>
            </div>
          </div>
        ) : (
          msg.text && <div style={{ fontSize: '14.5px', color: colors.text, lineHeight: '22px', wordBreak: 'break-word' }} dangerouslySetInnerHTML={{ __html: renderMessageHtml(msg.text, customEmojiMap) }} />
        )}
        {msg.text && msg.editedAt && !isEditing && (
          <span style={{ fontSize: '10.5px', color: colors.textFaint, fontWeight: 500, marginLeft: '2px' }}>(edited)</span>
        )}
        {msg.attachment && (
          msg.attachment.kind === 'video' ? (
            <video src={msg.attachment.url} controls style={{ width: '100%', maxWidth: '440px', borderRadius: '14px', marginTop: '8px', display: 'block', border: `1px solid ${colors.borderSoft}`, boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }} />
          ) : (
            <img src={msg.attachment.url} alt="shared clip" style={{ width: '100%', maxWidth: '440px', borderRadius: '14px', marginTop: '8px', display: 'block', cursor: 'pointer', objectFit: 'cover', border: `1px solid ${colors.borderSoft}`, boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }} onClick={() => window.open(msg.attachment.url, '_blank')} />
          )
        )}
        {msg.id && (Boolean(msg.reactions?.length) || emojiPickerOpenFor === msg.id) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '5px', position: 'relative' }}>
            {Object.values((msg.reactions || []).reduce((acc, r) => {
              acc[r.emoji] = acc[r.emoji] || { emoji: r.emoji, count: 0, mine: false, names: [] };
              acc[r.emoji].count += 1;
              acc[r.emoji].names.push(r.username);
              if (r.userId === user.id) acc[r.emoji].mine = true;
              return acc;
            }, {})).map((group) => (
              <button key={group.emoji} className={`reaction-pill${group.mine ? ' reaction-pill--mine' : ''}`} title={group.names.join(', ')} onClick={() => toggleReaction(msg, group.emoji)} dangerouslySetInnerHTML={{ __html: `${renderMessageHtml(group.emoji, customEmojiMap)} <span>${group.count}</span>` }} />
            ))}
            <button className="reaction-add-btn" title="Add reaction" onClick={(e) => openEmojiPicker(msg.id, e)}><Icon.Smile size={12} /></button>
            {emojiPickerOpenFor === msg.id && (
              <EmojiPicker customEmojis={customEmojis} canUpload={false} anchorEl={emojiPickerAnchorEl} onPick={(token) => toggleReaction(msg, token)} onClose={closeEmojiPicker} />
            )}
          </div>
        )}
      </div>
    </div>
  );
});
// ============================================================================
// SERVER VIEW
// ============================================================================
function ServerView({ authToken, user, serverId, serverName, myRole, onBack, profile, onSaveProfile, streamSettings, onSaveStream, voiceSettings, onSaveVoiceSettings, onActiveChannelChange, onChannelsChange }) {
  const api = useApi(authToken);
  // Layout prefs (panel widths, swap side, minimized) are saved per logged-in
  // account. Without this, two different users signed into the same device/
  // app instance would read and write the exact same global localStorage
  // keys — so one person's resize would silently show up for the other the
  // next time their layout loads. Scoping the key by username keeps it
  // strictly private to whoever is actually logged in.
  const layoutKey = (name) => `${name}:${user.username}`;
  const [channels, setChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [token, setToken] = useState('');
  const [chat, setChat] = useState([]);
  const [message, setMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showPopover, setShowPopover] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
const [confirmDeleteChannel, setConfirmDeleteChannel] = useState(null); 
  const [dragCount, setDragCount] = useState(0);
  const isDraggingFile = dragCount > 0;
  const [showSidebar, setShowSidebar] = useState(true);
  const [showChat, setShowChat] = useState(false); // Chat hidden by default to prioritize voice

  // Per-channel mute (local preference — see readMutedIds/toggleMutedId).
  const [mutedChannelIds, setMutedChannelIds] = useState(() => readMutedIds('Channels', user.username));
  const toggleMuteChannel = (channel, e) => {
    e.stopPropagation();
    toggleMutedId('Channels', user.username, channel.id);
    setMutedChannelIds(readMutedIds('Channels', user.username));
  };

  // Let the app shell know which room is currently open (and stop knowing
  // when we leave this server) so the global notification listener can tell
  // "already looking at it" apart from "elsewhere" and skip needless alerts.
  useEffect(() => {
    return () => onActiveChannelChange?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prevent Electron from opening the file if dropped outside the chat zone
  useEffect(() => {
    const preventNav = (e) => e.preventDefault();
    window.addEventListener('dragover', preventNav);
    window.addEventListener('drop', preventNav);
    return () => {
      window.removeEventListener('dragover', preventNav);
      window.removeEventListener('drop', preventNav);
    };
  }, []);
  const [pendingUploads, setPendingUploads] = useState([]); 
  const [members, setMembers] = useState([]); 
  const [profileCard, setProfileCard] = useState(null); 

  // Chat history pagination ("load more" on scroll up)
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const loadingMoreRef = useRef(false);

  // Message edit/delete
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDeleteMessage, setConfirmDeleteMessage] = useState(null);

  const chatScrollRef = useRef(null);
  const autoScrollRef = useRef(true);
  const [typingUsers, setTypingUsers] = useState({});
  const [voiceUsers, setVoiceUsers] = useState([]);

  // Resizable Panel States
  const [leftWidth, setLeftWidth] = useState(() => parseInt(localStorage.getItem(layoutKey('soulLeftWidth'))) || 260);
  const [chatWidth, setChatWidth] = useState(() => parseInt(localStorage.getItem(layoutKey('soulChatWidth'))) || 340);
  const [voiceWidth, setVoiceWidth] = useState(() => parseInt(localStorage.getItem(layoutKey('soulVoiceWidth'))) || 340);
  const [isDraggingLeft, setIsDraggingLeft] = useState(false);
  const [isDraggingRight, setIsDraggingRight] = useState(false);

  // Refs used to mutate panel width directly on the DOM while dragging, instead
  // of pushing through React state on every mousemove — see the drag effect
  // below for why this is what actually fixes resize lag.
  const leftPanelRef = useRef(null);
  const chatPanelRef = useRef(null);
  const voicePanelRef = useRef(null);
 const dragRef = useRef({ raf: null, leftW: null, rightW: null, mouseX: 0, isNarrow: false });
  const [resizeFlash, setResizeFlash] = useState(null); 
  const [isSwapping, setIsSwapping] = useState(false); 

  // --- PERMANENT BACKGROUND MUSIC PLAYER ---
  const backgroundPlayerRef = useRef(null);
const [backgroundTrack, setBackgroundTrack] = useState(null);
  const [backgroundTrackTitle, setBackgroundTrackTitle] = useState(null); // <--- ADD THIS
  const [backgroundPlaying, setBackgroundPlaying] = useState(false);
  const [backgroundVolume, setBackgroundVolume] = useState(50);
  
  const postBackgroundCommand = useCallback((func, args = []) => {
    if (backgroundPlayerRef.current?.contentWindow) {
      backgroundPlayerRef.current.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
    }
  }, []);

  useEffect(() => {
    const handleMedia = (data) => {
      if (data.type === 'set_track') {
        setBackgroundTrack(data.trackUrl); 
        setBackgroundTrackTitle(data.trackTitle);
        setBackgroundPlaying(true); // Force state to playing
      }
      else if (data.type === 'toggle_play') {
        setBackgroundPlaying(data.playing);
        postBackgroundCommand(data.playing ? 'playVideo' : 'pauseVideo');
      }
      else if (data.type === 'volume') {
        setBackgroundVolume(data.volume);
        postBackgroundCommand('setVolume', [data.volume]);
      }
    };
    
    // Listen to network events (other people) AND local events (your menu)
    socket.on('media_action', handleMedia);
    const handleLocal = (e) => handleMedia(e.detail);
    window.addEventListener('local_media_action', handleLocal);
    
    return () => { 
      socket.off('media_action', handleMedia); 
      window.removeEventListener('local_media_action', handleLocal);
    };
  }, [postBackgroundCommand]);

  const [panelSwapped, setPanelSwapped] = useState(() => localStorage.getItem(layoutKey('soulPanelSwapped')) === '1');
  const [draggedPanel, setDraggedPanel] = useState(null); 
  const [dropTarget, setDropTarget] = useState(null); 

  const swapPanels = () => {
    setIsSwapping(true);
    setTimeout(() => {
      setPanelSwapped((prev) => {
        const next = !prev;
        localStorage.setItem(layoutKey('soulPanelSwapped'), next ? '1' : '0');
        return next;
      });
      requestAnimationFrame(() => requestAnimationFrame(() => setIsSwapping(false)));
    }, 150);
  };

  useEffect(() => {
    if (!resizeFlash) return;
    const t = setTimeout(() => setResizeFlash(null), 500);
    return () => clearTimeout(t);
  }, [resizeFlash]);

  const [voiceDockAnchor, setVoiceDockAnchor] = useState(null);
  const [isVoiceNarrow, setIsVoiceNarrow] = useState(false);

  useEffect(() => {
    if (!voicePanelRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const narrow = entry.contentRect.width < 150; 
        if (dragRef.current.isNarrow !== narrow) {
          dragRef.current.isNarrow = narrow;
          setIsVoiceNarrow(narrow);
        }
      }
    });
    observer.observe(voicePanelRef.current);
    return () => observer.disconnect();
  }, []);

  const toggleVoiceMinimized = () => {
    if (panelSwapped) {
      setChatWidth(isVoiceNarrow ? 340 : window.innerWidth - leftWidth - 86);
    } else {
      setVoiceWidth(isVoiceNarrow ? 340 : 86);
    }
  };

  const handlePanelDragStart = (panel) => (e) => {
    setDraggedPanel(panel);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', panel);
  };
  const handlePanelDragOver = (panel) => (e) => {
    if (!draggedPanel || draggedPanel === panel) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(panel);
  };
  const handlePanelDragLeave = (panel) => () => {
    setDropTarget((prev) => (prev === panel ? null : prev));
  };
  const handlePanelDrop = (panel) => (e) => {
    e.preventDefault();
    if (draggedPanel && draggedPanel !== panel) swapPanels();
    setDraggedPanel(null);
    setDropTarget(null);
  };
  const handlePanelDragEnd = () => {
    setDraggedPanel(null);
    setDropTarget(null);
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDraggingLeft && !isDraggingRight) return;
      
      // Always store the freshest mouse coordinate globally
      dragRef.current.mouseX = e.clientX;

if (!dragRef.current.raf) {
        dragRef.current.raf = requestAnimationFrame(() => {
          dragRef.current.raf = null;
          const clientX = dragRef.current.mouseX; // Grab the absolute latest position before painting
          
          if (isDraggingLeft) {
            // Prevent the panel from pushing other panels off-screen
            const rightW = panelSwapped ? chatWidth : voiceWidth;
            const midMinWidth = panelSwapped ? 86 : 250;
            const maxW = document.body.clientWidth - rightW - midMinWidth;
            
            const w = Math.max(200, Math.min(maxW, clientX));
            dragRef.current.leftW = w;
            if (leftPanelRef.current) leftPanelRef.current.style.width = `${w}px`;
            
          } else if (isDraggingRight) {
            const midMinWidth = panelSwapped ? 86 : 250;
            const minW = panelSwapped ? 250 : 86; // Minimum constraint flips based on what is in the Right Panel
            const maxW = document.body.clientWidth - leftWidth - midMinWidth;
            
            const w = Math.max(minW, Math.min(maxW, document.body.clientWidth - clientX));
            dragRef.current.rightW = w;
            const target = panelSwapped ? chatPanelRef.current : voicePanelRef.current;
            if (target) target.style.width = `${w}px`;
          }
        });
      }
    };
    
    const handleMouseUp = () => {
      if (dragRef.current.raf) {
        cancelAnimationFrame(dragRef.current.raf);
        dragRef.current.raf = null;
      }
      if (isDraggingLeft && dragRef.current.leftW != null) {
        setLeftWidth(dragRef.current.leftW);
        localStorage.setItem(layoutKey('soulLeftWidth'), dragRef.current.leftW);
        dragRef.current.leftW = null;
        setResizeFlash('left');
      }
      if (isDraggingRight && dragRef.current.rightW != null) {
        const w = dragRef.current.rightW;
        if (panelSwapped) {
          setChatWidth(w);
          localStorage.setItem(layoutKey('soulChatWidth'), w);
        } else {
          setVoiceWidth(w);
          localStorage.setItem(layoutKey('soulVoiceWidth'), w);
        }
        dragRef.current.rightW = null;
        setResizeFlash('right');
      }
      setIsDraggingLeft(false);
      setIsDraggingRight(false);
    };

    if (isDraggingLeft || isDraggingRight) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingLeft, isDraggingRight, panelSwapped, leftWidth, chatWidth, voiceWidth]);

  const canManage = myRole === 'owner' || myRole === 'admin';

  const memberMap = useMemo(
    () => Object.fromEntries(members.map((m) => [m.username, m])),
    [members]
  );
  const openUserProfile = (u) => setProfileCard({ user: u, view: 'mini' });

  useEffect(() => {
    api(`/servers/${serverId}/members`).then(setMembers).catch(() => {});
    // eslint-disable-next-line
  }, [serverId, showMembers]);

  useEffect(() => {
    api(`/servers/${serverId}/channels`).then((list) => {
      setChannels(list);
      if (list.length) {
        // Find a text channel to load by default so we don't jump into voice
        const textChannel = list.find((c) => c.type === 'text');
        if (textChannel) {
          enterChannel(textChannel, true);
        } else {
          // If only voice channels exist, open the view but DO NOT auto-connect
          enterChannel(list[0], false);
        }
      }
    });
    // eslint-disable-next-line
  }, [serverId]);

  // Keep the app shell's channelId -> {server, room name} lookup current so
  // background notifications for this server can show a real room name (and
  // so newly-created rooms are recognized without waiting on its own
  // periodic refresh).
  useEffect(() => {
    onChannelsChange?.(serverId, serverName, channels);
    // eslint-disable-next-line
  }, [serverId, serverName, channels]);

  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [showPinned, setShowPinned] = useState(false);

  // This server's custom emoji pack — loaded once per server and kept
  // around for both the picker (adding to a message) and the renderer
  // (resolving :shortcode: tokens already in message text).
  const [customEmojis, setCustomEmojis] = useState([]);
  const customEmojiMap = useMemo(
    () => Object.fromEntries(customEmojis.map((e) => [e.name, e])),
    [customEmojis]
  );
  const refreshCustomEmojis = useCallback(() => {
    api(`/servers/${serverId}/emojis`).then(setCustomEmojis).catch(() => {});
  }, [serverId]);
  useEffect(() => { refreshCustomEmojis(); }, [refreshCustomEmojis]);

  const uploadCustomEmoji = async (file, name) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    try {
      await fetch(`${API_BASE}/servers/${serverId}/emojis`, {
        method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form,
      }).then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed.');
        return data;
      });
      refreshCustomEmojis();
    } catch (e) {
      console.error('Emoji upload failed:', e);
    }
  };

  const [emojiPickerOpenFor, setEmojiPickerOpenFor] = useState(null); // 'composer' | messageId | null
  const [emojiPickerAnchorEl, setEmojiPickerAnchorEl] = useState(null);
  // Opens (or, clicking the same trigger again, closes) the picker anchored
  // to whichever button was actually clicked. We keep the element itself
  // (not just its rect) so EmojiPicker can keep re-reading its live position
  // and the popup can flip to open downward when there's no room above it.
  const openEmojiPicker = (forTarget, e) => {
    if (emojiPickerOpenFor === forTarget) { setEmojiPickerOpenFor(null); return; }
    setEmojiPickerAnchorEl(e.currentTarget);
    setEmojiPickerOpenFor(forTarget);
  };
  const closeEmojiPicker = () => { setEmojiPickerOpenFor(null); setEmojiPickerAnchorEl(null); };

  const toggleReaction = (msg, emoji) => {
    if (!msg?.id || !activeChannel) return;
    socket.emit('toggle_reaction', {
      channelId: activeChannel.id, messageId: msg.id, userId: user.id, username: user.username, emoji,
    });
    closeEmojiPicker();
  };

 // 👇 ADD THIS NEW EFFECT 👇
  useEffect(() => {
    const getMsg = (id) => chat.find(m => m.id === id || m.clientId === id);
    
    const handleQuickReact = (e) => {
      if (!activeChannel) return;
      socket.emit('toggle_reaction', {
        channelId: activeChannel.id, messageId: e.detail.msgId, userId: user.id, username: user.username, emoji: e.detail.emoji,
      });
    };
    const handleComposerEmoji = () => document.getElementById('composer-emoji-btn')?.click();
    const handleEdit = (e) => { const m = getMsg(e.detail.id); if (m) startEditMessage(m); };
    const handleDelete = (e) => { const m = getMsg(e.detail.id); if (m) setConfirmDeleteMessage(m); };
    const handlePin = (e) => { const m = getMsg(e.detail.id); if (m) togglePin(m); };

    window.addEventListener('quick-react', handleQuickReact);
    window.addEventListener('trigger-composer-emoji', handleComposerEmoji);
    window.addEventListener('trigger-edit-msg', handleEdit);
    window.addEventListener('trigger-delete-msg', handleDelete);
    window.addEventListener('trigger-pin-msg', handlePin);
    return () => {
      window.removeEventListener('quick-react', handleQuickReact);
      window.removeEventListener('trigger-composer-emoji', handleComposerEmoji);
      window.removeEventListener('trigger-edit-msg', handleEdit);
      window.removeEventListener('trigger-delete-msg', handleDelete);
      window.removeEventListener('trigger-pin-msg', handlePin);
    };
  }, [activeChannel, user, chat]);
  // 👆 ---------------------- 👆

  useEffect(() => {
    // The server now echoes every message back to everyone in the room,
    // including the sender — so this is the ONLY place messages get added
    // to chat. That gives every message (including your own) a real
    // persisted id, which is what makes pinning reliable.
    const handleReceive = (data) => {
      if (activeChannel && data.channelId === activeChannel.id) {
        setChat((prev) => {
          // If this is the server's echo of a message we already showed
          // optimistically (matched by clientId), replace the pending copy
          // in place instead of appending a duplicate.
          if (data.clientId) {
            const idx = prev.findIndex((m) => m.clientId === data.clientId);
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = {
                id: data.id, sender: data.sender, senderAvatarUrl: data.senderAvatarUrl || null,
                text: data.message ?? data.content, attachment: data.attachment || null,
                at: next[idx].at, pinned: false, clientId: data.clientId, reactions: data.reactions || [],
              };
              return next;
            }
          }
          // Belt-and-braces: if this exact persisted message (real id) is
          // somehow already in the list — e.g. a duplicate broadcast — don't
          // add it again.
          if (data.id && prev.some((m) => m.id === data.id)) return prev;
          return [...prev, {
            id: data.id, sender: data.sender, senderAvatarUrl: data.senderAvatarUrl || null,
            text: data.message ?? data.content, attachment: data.attachment || null, at: Date.now(), pinned: false,
            reactions: data.reactions || [],
          }];
        });
      }
    };

    const handleTyping = (data) => {
      if (activeChannel && data.channelId === activeChannel.id && data.username !== user.username) {
        setTypingUsers((prev) => ({ ...prev, [data.username]: Date.now() }));
      }
    };

    const handlePinned = (msg) => {
      setChat((prev) => prev.map((m) => (m.id === msg.id ? { ...m, pinned: true } : m)));
      setPinnedMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    };
    const handleUnpinned = ({ id }) => {
      setChat((prev) => prev.map((m) => (m.id === id ? { ...m, pinned: false } : m)));
      setPinnedMessages((prev) => prev.filter((m) => m.id !== id));
    };

    const handleEdited = (msg) => {
      if (!activeChannel || msg.channelId !== activeChannel.id) return;
      setChat((prev) => prev.map((m) => (m.id === msg.id ? { ...m, text: msg.content, editedAt: msg.editedAt } : m)));
      setPinnedMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, content: msg.content, editedAt: msg.editedAt } : m)));
    };
    const handleDeleted = ({ id, channelId }) => {
      if (!activeChannel || channelId !== activeChannel.id) return;
      setChat((prev) => prev.filter((m) => m.id !== id));
      setPinnedMessages((prev) => prev.filter((m) => m.id !== id));
      setEditingMessageId((cur) => (cur === id ? null : cur));
    };
    // A single reaction add/remove delta — patch just that message's
    // reactions array in place rather than re-fetching anything.
    const handleReactionUpdated = (data) => {
      setChat((prev) => prev.map((m) => {
        if (m.id !== data.messageId) return m;
        const cur = m.reactions || [];
        if (data.added) {
          if (cur.some((r) => r.userId === data.userId && r.emoji === data.emoji)) return m;
          return { ...m, reactions: [...cur, { emoji: data.emoji, userId: data.userId, username: data.username }] };
        }
        return { ...m, reactions: cur.filter((r) => !(r.userId === data.userId && r.emoji === data.emoji)) };
      }));
    };

    const handleRateLimited = (data) => {
      if (!activeChannel || data.channelId !== activeChannel.id) return;
      // Drop the optimistic pending copy of the message that got rejected,
      // and let the sender know why nothing showed up.
      setChat((prev) => {
        const withoutPending = data.clientId ? prev.filter((m) => m.clientId !== data.clientId) : prev;
        return [...withoutPending, { sender: 'System', text: data.message, isError: true, at: Date.now() }];
      });
    };

    socket.on('receive_message', handleReceive);
    socket.on('typing', handleTyping);
    socket.on('message_pinned', handlePinned);
    socket.on('message_unpinned', handleUnpinned);
    socket.on('message_edited', handleEdited);
    socket.on('message_deleted', handleDeleted);
    socket.on('rate_limited', handleRateLimited);
    socket.on('reaction_updated', handleReactionUpdated);

    return () => {
      socket.off('receive_message', handleReceive);
      socket.off('typing', handleTyping);
      socket.off('message_pinned', handlePinned);
      socket.off('message_unpinned', handleUnpinned);
      socket.off('message_edited', handleEdited);
      socket.off('message_deleted', handleDeleted);
      socket.off('rate_limited', handleRateLimited);
      socket.off('reaction_updated', handleReactionUpdated);
    };
  }, [activeChannel, user.username]);

  const togglePin = async (msg) => {
    try {
      if (msg.pinned) await api(`/servers/${serverId}/channels/${activeChannel.id}/messages/${msg.id}/pin`, { method: 'DELETE' });
      else await api(`/servers/${serverId}/channels/${activeChannel.id}/messages/${msg.id}/pin`, { method: 'POST' });
      // Socket event above will update local state for everyone, including us.
    } catch (e) {
      console.error('Pin toggle failed:', e);
    }
  };

  // REVIEW: message actions here cover pin/edit/delete but there's no emoji
  // reaction and no reply/thread support — chat is a flat list you can't
  // 👍 or reply-to-a-specific-message in. Close to table-stakes at this
  // point; would need a Reaction model (schema.prisma) + socket events for
  // add/remove, and a parentMessageId (or threadId) for replies.
  const startEditMessage = (msg) => {
    setEditingMessageId(msg.id);
    setEditDraft(msg.text || '');
  };
  const cancelEditMessage = () => {
    setEditingMessageId(null);
    setEditDraft('');
  };
  const saveEditMessage = async (msg) => {
    const content = editDraft.trim();
    if (!content || !activeChannel) return cancelEditMessage();
    if (content === msg.text) return cancelEditMessage();
    try {
      await api(`/servers/${serverId}/channels/${activeChannel.id}/messages/${msg.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      });
      // Socket event (message_edited) updates local state for everyone, including us.
    } catch (e) {
      console.error('Edit failed:', e);
      setChat((prev) => [...prev, { sender: 'System', text: `Couldn't edit message: ${e.message}`, isError: true, at: Date.now() }]);
    } finally {
      cancelEditMessage();
    }
  };
  const handleEditKeyDown = (e, msg) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditMessage(msg); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEditMessage(); }
  };

  const deleteMessage = async () => {
    const msg = confirmDeleteMessage;
    setConfirmDeleteMessage(null);
    if (!msg || !activeChannel) return;
    try {
      await api(`/servers/${serverId}/channels/${activeChannel.id}/messages/${msg.id}`, { method: 'DELETE' });
      // Socket event (message_deleted) removes it for everyone, including us.
    } catch (e) {
      console.error('Delete failed:', e);
      setChat((prev) => [...prev, { sender: 'System', text: `Couldn't delete message: ${e.message}`, isError: true, at: Date.now() }]);
    }
  };

  // Clear typing indicators if someone stops typing for 2 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTypingUsers((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const [uname, time] of Object.entries(next)) {
          if (now - time > 2000) { delete next[uname]; changed = true; }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Global "Press Enter to Chat" listener
  useEffect(() => {
    const handleGlobalEnter = (e) => {
      if (e.key === 'Enter') {
        const activeTag = document.activeElement?.tagName;
        // If the user isn't already focused on an input or textarea, grab focus!
        if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
          e.preventDefault(); // Stop it from clicking any random highlighted buttons
          document.getElementById('global-chat-input')?.focus();
        }
      }
    };
    window.addEventListener('keydown', handleGlobalEnter);
    return () => window.removeEventListener('keydown', handleGlobalEnter);
  }, []);

  // Smart Auto-Scroll: Only scrolls down if you are already at the bottom
  useEffect(() => {
    if (autoScrollRef.current && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chat, typingUsers]);

  const handleChatScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
    if (scrollTop < 80) loadOlderMessages();
  };

  const uploadAndShareFile = async (file) => {
    if (!activeChannel || !file) return;

    // Check if it's a media file (image or video)
    if (!file.type.match(/^(image|video)\//) && !file.name.match(/\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i)) {
      setChat((prev) => [...prev, { sender: 'System', text: `File format not supported. Please use images or videos.`, isError: true, at: Date.now() }]);
      return;
    }

    const label = file.name || 'clip';
    setPendingUploads((prev) => [...prev, label]);
    
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/servers/${serverId}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: form,
      });
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Upload failed.');

      const attachment = { url: data.url.startsWith('http') ? data.url : `${API_BASE}${data.url}`, kind: data.kind };
      const clientId = `${user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setChat((prev) => [...prev, {
        id: null, clientId, sender: user.username, senderAvatarUrl: profile.avatarUrl || null,
        text: '', attachment, at: Date.now(), pinned: false,
      }]);
      const payload = { channelId: activeChannel.id, message: '', sender: user.username, senderId: user.id, senderAvatarUrl: profile.avatarUrl || null, attachment, clientId };

      socket.emit('send_message', payload);
      // Server echoes back and the socket effect above reconciles by clientId.
    } catch (e) {
      // Print the error directly in the chat so you know it failed
      setChat((prev) => [...prev, { sender: 'System', text: `Upload failed: ${e.message}`, isError: true, at: Date.now() }]);
    } finally {
      setPendingUploads((prev) => prev.filter((f) => f !== label));
    }
  };

  const handleDragEnter = (e) => { e.preventDefault(); e.stopPropagation(); setDragCount(c => c + 1); };
  const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setDragCount(c => Math.max(0, c - 1)); };
  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCount(0);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      [...e.dataTransfer.files].forEach(uploadAndShareFile);
    }
  };

  const handleChatPaste = (e) => {
    const files = [...e.clipboardData.items].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
    if (files.length) files.forEach(uploadAndShareFile);
  };

  const deleteChannel = async () => {
    const channel = confirmDeleteChannel;
    setConfirmDeleteChannel(null);
    try {
      await api(`/servers/${serverId}/channels/${channel.id}`, { method: 'DELETE' });
      setChannels((prev) => {
        const next = prev.filter((c) => c.id !== channel.id);
        if (activeChannel?.id === channel.id && next.length) enterChannel(next[0]);
        return next;
      });
    } catch (e) {
      console.error(e);
    }
  };

  const messageFromApi = (m) => ({
    id: m.id, sender: m.sender, senderAvatarUrl: m.senderAvatarUrl, text: m.content,
    attachment: m.attachment || null, pinned: m.pinned, editedAt: m.editedAt || null,
    at: new Date(m.createdAt).getTime(), createdAt: m.createdAt, reactions: m.reactions || [],
  });

  // Tell the main process whenever we join/leave a voice connection, so the
  // auto-updater (main.cjs) knows not to force-restart the app mid-call.
  useEffect(() => {
    window.electronAPI?.voice?.setInCall?.(!!token);
  }, [token]);

  // Voice channels connect to LiveKit the instant they're opened; text
  // channels (channel.type === 'text') never do — see the check inside.
  const enterChannel = async (channel, autoConnectVoice = true) => {
    setActiveChannel(channel);
    onActiveChannelChange?.(channel.id);
    setChat([]);
    setPinnedMessages([]);
    setShowPinned(false);
    setHasMoreHistory(false);
    setEditingMessageId(null);
    setToken('');
    socket.emit('join_channel', channel.id);
    
    // Text channels never join voice. For voice channels, only auto-connect 
    // if autoConnectVoice is true (prevents joining instantly on server load).
    if (channel.type !== 'text' && autoConnectVoice) {
      try {
        const data = await api(`/getToken?channelId=${channel.id}`);
        setToken(data.token);
        playChime('voice-join');
      } catch (e) {
        console.error(e);
      }
    }
    try {
      const { messages: history, hasMore } = await api(`/servers/${serverId}/channels/${channel.id}/messages`);
      setChat(history.map(messageFromApi));
      setHasMoreHistory(!!hasMore);
      const pinned = await api(`/servers/${serverId}/channels/${channel.id}/pinned`);
      setPinnedMessages(pinned);
    } catch (e) {
      console.error('Failed to load message history:', e);
    }
  };

  // "Load more" — fetches the next page of older messages (before the
  // oldest one currently loaded) and prepends them, preserving scroll
  // position so the view doesn't jump.
  const loadOlderMessages = async () => {
    if (!activeChannel || loadingMoreRef.current || !hasMoreHistory || chat.length === 0) return;
    const oldest = chat.find((m) => m.createdAt);
    if (!oldest) return;

    loadingMoreRef.current = true;
    setLoadingMoreHistory(true);
    const scrollEl = chatScrollRef.current;
    const prevScrollHeight = scrollEl ? scrollEl.scrollHeight : 0;
    try {
      const { messages: older, hasMore } = await api(
        `/servers/${serverId}/channels/${activeChannel.id}/messages?before=${encodeURIComponent(oldest.createdAt)}`
      );
      if (older.length) {
        setChat((prev) => [...older.map(messageFromApi), ...prev]);
        // Keep the user's eyes on the same message after older ones are
        // inserted above it, instead of yanking the scroll to the top.
        requestAnimationFrame(() => {
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight - prevScrollHeight;
        });
      }
      setHasMoreHistory(!!hasMore);
    } catch (e) {
      console.error('Failed to load older messages:', e);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMoreHistory(false);
    }
  };

  const isSending = useRef(false);
  const lastSent = useRef({ text: '', at: 0 });

  const sendMessage = () => {
    const text = message.trim();
    if (!text || !activeChannel || isSending.current) return;
    if (text === lastSent.current.text && Date.now() - lastSent.current.at < 800) return;

    isSending.current = true;
    lastSent.current = { text, at: Date.now() };
    setMessage('');
    closeEmojiPicker();

    const clientId = `${user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Show it immediately — don't make the sender wait on a server round trip
    // to see their own message. The socket effect above swaps this pending
    // entry for the persisted one (matched by clientId) once it echoes back.
    setChat((prev) => [...prev, {
      id: null, clientId, sender: user.username, senderAvatarUrl: profile.avatarUrl || null,
      text, attachment: null, at: Date.now(), pinned: false,
    }]);

    const payload = { channelId: activeChannel.id, message: text, sender: user.username, senderId: user.id, senderAvatarUrl: profile.avatarUrl || null, clientId };
    socket.emit('send_message', payload);
    
    setTimeout(() => { isSending.current = false; }, 300);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInputChange = (e) => {
    setMessage(e.target.value);
    if (activeChannel) socket.emit('typing', { channelId: activeChannel.id, username: user.username });
  };

  const handleDisconnected = () => { setToken(''); playChime('voice-leave'); };

  const rejoinVoice = async () => {
    if (!activeChannel) return;
    const data = await api(`/getToken?channelId=${activeChannel.id}`);
    setToken(data.token);
    playChime('voice-join');
  };

  const textChannels = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type !== 'text');

  const renderChannelRow = (channel) => {
    const active = activeChannel?.id === channel.id;
    const isVoice = channel.type !== 'text';
    return (
      <div key={channel.id} style={{ marginBottom: '6px' }}>
        <div className="channel-row" onClick={() => enterChannel(channel)} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px', backgroundColor: active ? colors.brandDim : 'transparent', color: active ? colors.text : colors.textMuted, padding: '10px 12px 10px 16px', borderRadius: '10px', cursor: 'pointer', fontSize: '14px', fontWeight: active ? 600 : 500, transition: 'background-color 0.15s, color 0.15s' }}>
          {active && <span style={{ position: 'absolute', left: '-2px', top: '20%', height: '60%', width: '4px', borderRadius: '4px', background: colors.brand }} />}
          <span style={{ opacity: active ? 1 : 0.6, display: 'flex' }}>{isVoice ? <Icon.Volume size={16} /> : <Icon.MessageCircle size={16} />}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{channel.name}</span>
          {isVoice && (
            <button
              className={`icon-btn row-mute${mutedChannelIds.has(channel.id) ? ' is-muted' : ''}`}
              onClick={(e) => toggleMuteChannel(channel, e)}
              title={mutedChannelIds.has(channel.id) ? 'Unmute room' : 'Mute room'}
              style={{ border: 'none', background: 'transparent', color: mutedChannelIds.has(channel.id) ? colors.brand : colors.textMuted, cursor: 'pointer', display: 'flex', flexShrink: 0, padding: '4px' }}
            >
              {mutedChannelIds.has(channel.id) ? <Icon.BellOff size={14} /> : <Icon.Bell size={14} />}
            </button>
          )}
          {canManage && channels.length > 1 && (
            <button
              className="icon-btn row-delete"
              onClick={(e) => { e.stopPropagation(); setConfirmDeleteChannel(channel); }}
              title={isVoice ? 'Delete room' : 'Delete channel'}
              style={{ border: 'none', background: 'transparent', color: colors.danger, cursor: 'pointer', display: 'flex', flexShrink: 0, padding: '4px' }}
            >
              <Icon.Trash size={14} />
            </button>
          )}
        </div>

        {/* Your profile + everyone else, right under the room you're connected to — like Discord. Text channels never have a voice roster. */}
        {isVoice && active && token && voiceUsers.length > 0 && (
          <div style={{ padding: '6px 8px 12px 28px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[...voiceUsers].sort((a, b) => (a === user.username ? -1 : b === user.username ? 1 : 0)).map((identity) => {
              const m = memberMap[identity];
              const isMe = identity === user.username;
              const avatarUrl = isMe ? profile.avatarUrl : m?.avatarUrl;
              return (
                <div key={identity} onClick={() => openUserProfile(m || { username: identity, avatarUrl })} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', animation: 'fadeUp 0.2s ease' }}>
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: avatarUrl ? 'transparent' : colorForName(identity), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '10px', fontWeight: 800, overflow: 'hidden', boxShadow: isMe ? `0 0 0 2px ${colors.speak}` : 'none' }}>
                      {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(identity)}
                    </div>
                  </div>
                  <span style={{ fontSize: '13px', color: isMe ? colors.text : colors.textMuted, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{isMe ? 'You' : identity}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };


return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%', backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody }}>
      <GlobalStyle />
      
{/* --- PERMANENT INVISIBLE MUSIC FRAME --- */}
      <div style={{ position: 'absolute', left: '-9999px', top: '-9999px', width: '10px', height: '10px', opacity: 0, pointerEvents: 'none' }}>
        {backgroundTrack && (
          <iframe 
            ref={backgroundPlayerRef} 
            // Swapped to autoplay=1 so it instantly triggers on load
            src={backgroundTrack.replace('autoplay=0', 'autoplay=1')} 
            title="Audio" 
            allow="autoplay; encrypted-media" 
            onLoad={() => { 
              postBackgroundCommand('setVolume', [backgroundVolume]); 
              if (!backgroundPlaying) postBackgroundCommand('pauseVideo'); 
            }} 
          />
        )}
      </div>

      {/* 👇 1. THE INVISIBLE SHIELD 👇 */}
      {(isDraggingLeft || isDraggingRight) && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 99999, cursor: 'col-resize', userSelect: 'none' }} />
      )}
      {/* 👆 ---------------------- 👆 */}

     {/* Main Draggable Top Bar */}
<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 0 0 20px', height: '48px', borderBottom: `1px solid ${colors.borderSoft}`, backgroundColor: 'transparent', flexShrink: 0, WebkitAppRegion: 'drag' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', WebkitAppRegion: 'no-drag' }}>
          <button onClick={onBack} className="icon-btn" style={{ border: 'none', background: 'transparent', color: colors.textMuted, cursor: 'pointer', display: 'flex' }}><Icon.Back size={18} /></button>
          
          <button onClick={() => setShowSidebar(v => !v)} className="icon-btn" title="Toggle Sidebar" style={{ border: 'none', background: showSidebar ? colors.brandDim : 'transparent', color: showSidebar ? colors.text : colors.textMuted, borderRadius: '12px', padding: '8px', cursor: 'pointer', display: 'flex', transition: 'all 0.2s' }}>
            <Icon.Layers size={16} />
          </button>

          <div style={{ width: '32px', height: '32px', borderRadius: '12px', background: colorForName(serverName), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 800, color: '#fff', fontFamily: fontDisplay }}>{initialsForName(serverName)}</div>
          <h2 style={{ margin: 0, fontSize: '18px' }}>{serverName}</h2>
          <RoleBadge role={myRole} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', height: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', WebkitAppRegion: 'no-drag', marginRight: '8px' }}>
            
            {activeChannel?.type !== 'text' && (
              <button onClick={() => setShowChat(v => !v)} className="icon-btn" title="Toggle Chat" style={{ border: 'none', background: showChat ? colors.brandDim : 'transparent', color: showChat ? colors.text : colors.textMuted, borderRadius: '12px', padding: '8px 12px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', transition: 'all 0.2s' }}>
                <Icon.MessageCircle size={15} /> Chat
              </button>
            )}

            {canManage && (
              <button onClick={() => setShowInvite(true)} className="icon-btn" style={{ display: 'flex', alignItems: 'center', gap: '8px', border: `1px solid ${colors.border}`, background: 'transparent', color: colors.textMuted, borderRadius: '10px', padding: '6px 12px', fontSize: '13px', fontWeight: 600, fontFamily: fontBody, cursor: 'pointer' }}>
                <Icon.Link size={14} /> Invite
              </button>
            )}
            <button onClick={() => setShowMembers(true)} className="icon-btn" style={{ display: 'flex', alignItems: 'center', gap: '8px', border: `1px solid ${colors.border}`, background: 'transparent', color: colors.textMuted, borderRadius: '10px', padding: '6px 12px', fontSize: '13px', fontWeight: 600, fontFamily: fontBody, cursor: 'pointer' }}>
              <Icon.Users size={14} /> Members
            </button>
          </div>
          <WindowControls />
        </div>
      </div>

      {showInvite && <InviteModal authToken={authToken} serverId={serverId} onClose={() => setShowInvite(false)} />}

      <div style={{ display: 'flex', flex: 1, minHeight: 0, width: '100%', userSelect: isDraggingLeft || isDraggingRight ? 'none' : 'auto' }}>

{/* ================================= LEFT SIDEBAR ================================= */}
        <div ref={leftPanelRef} style={{ 
          width: showSidebar ? ((isDraggingLeft && dragRef.current.leftW) ? dragRef.current.leftW : leftWidth) : 0, 
          opacity: showSidebar ? 1 : 0,
          pointerEvents: showSidebar ? 'auto' : 'none',
          backgroundColor: 'rgba(20, 23, 42, 0.4)', backdropFilter: 'blur(16px)', borderRight: `1px solid ${colors.borderSoft}`, display: 'flex', flexDirection: 'column', flexShrink: 0, position: 'relative', willChange: 'width, opacity', transition: isDraggingLeft || isDraggingRight ? 'none' : 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease',
          margin: showSidebar ? '16px 0 16px 16px' : '16px 0',
          borderRadius: '24px', overflow: 'hidden'
        }}>
          <div className="scroll-thin" style={{ padding: '24px 16px 12px', flex: 1, overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', paddingBottom: '12px', borderBottom: `1px solid ${colors.borderSoft}` }}>
              <p style={{ color: colors.textFaint, fontWeight: 700, fontSize: '11px', letterSpacing: '0.1em', margin: 0, textTransform: 'uppercase' }}>Channels</p>
              {canManage && (
                <button onClick={() => setShowCreateChannel(true)} className="icon-btn" style={{ border: 'none', background: 'transparent', color: colors.brand, cursor: 'pointer', display: 'flex' }} aria-label="Create channel"><Icon.Plus size={16} /></button>
              )}
            </div>

            {textChannels.length > 0 && (
              <>
                <p style={{ color: colors.textFaint, fontWeight: 700, fontSize: '10px', letterSpacing: '0.08em', margin: '0 0 6px 4px', textTransform: 'uppercase' }}>Text</p>
                {textChannels.map((channel) => renderChannelRow(channel))}
                <div style={{ height: '14px' }} />
              </>
            )}

            {voiceChannels.length > 0 && (
              <>
                <p style={{ color: colors.textFaint, fontWeight: 700, fontSize: '10px', letterSpacing: '0.08em', margin: '0 0 6px 4px', textTransform: 'uppercase' }}>Voice</p>
                {voiceChannels.map((channel) => renderChannelRow(channel))}
              </>
            )}
          </div>

          {/* Voice status connects here — flush against the account bar below, no gap or shadow */}
          <div ref={setVoiceDockAnchor} style={{ flexShrink: 0 }} />

        </div>
        {/* ================================= LEFT RESIZER ================================= */}
        <div
          onMouseDown={(e) => { e.preventDefault(); setResizeFlash(null); setIsDraggingRight(true); }}
          style={{
            order: 25, width: '6px', margin: '0 -3px', cursor: 'col-resize',
            backgroundColor: isDraggingLeft ? colors.brand : 'transparent',
            boxShadow: isDraggingLeft ? `0 0 14px 1px ${colors.brand}88` : 'none',
            zIndex: 10,
            transition: 'background-color 0.18s ease, box-shadow 0.18s ease',
            animation: resizeFlash === 'left' ? 'resizeFlash 0.5s ease-out' : 'none',
          }}
          onMouseEnter={(e) => { if (!isDraggingLeft && !isDraggingRight) e.currentTarget.style.backgroundColor = colors.borderSoft; }}
          onMouseLeave={(e) => { if (!isDraggingLeft) e.currentTarget.style.backgroundColor = 'transparent'; }}
        />

{/* ================================= TEXT CHAT (drag the header to swap sides) ================================= */}
<div
          ref={chatPanelRef}
          style={{
            order: panelSwapped ? 30 : 20,
            ...(activeChannel?.type === 'text' 
              ? { flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: '250px' }
              : { width: showChat ? ((isDraggingRight && dragRef.current.rightW) ? dragRef.current.rightW : chatWidth) : 0, minWidth: showChat ? '300px' : '0px', flexShrink: 0 }
            ),
            backgroundColor: 'rgba(20, 23, 42, 0.5)', backdropFilter: 'blur(20px)', display: 'flex', flexDirection: 'column', position: 'relative',
            border: showChat || activeChannel?.type === 'text' ? `1px solid ${colors.borderSoft}` : 'none',
            borderRadius: '28px',
            margin: (showChat || activeChannel?.type === 'text') ? '16px' : '16px 0',
            opacity: (showChat || activeChannel?.type === 'text') && !isSwapping ? 1 : 0,
            pointerEvents: showChat || activeChannel?.type === 'text' ? 'auto' : 'none',
            transform: isSwapping ? 'scale(0.985)' : 'none',
            willChange: 'width',
            overflow: 'hidden',
            transition: isDraggingLeft || isDraggingRight ? 'none' : 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div
            draggable
            onDragStart={handlePanelDragStart('chat')}
            onDragOver={handlePanelDragOver('chat')}
            onDragLeave={handlePanelDragLeave('chat')}
            onDrop={handlePanelDrop('chat')}
            onDragEnd={handlePanelDragEnd}
            title="Drag to move this panel — only changes your own layout"
            style={{ padding: '16px 20px', borderBottom: `1px solid ${colors.borderSoft}`, display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, cursor: 'grab', transition: 'background-color 0.15s', zIndex: 10 }}
          >
            <span style={{ color: colors.textFaint, display: 'flex' }}><Icon.Grip size={14} /></span>
            <span style={{ color: colors.textFaint, fontSize: '18px', fontWeight: 600 }}>#</span>
            <h3 style={{ margin: 0, fontSize: '16px', flex: 1, minWidth: 0 }}>{activeChannel?.name || '—'}</h3>
            <button
              className="icon-btn"
              onClick={() => setShowPinned((v) => !v)}
              title="Pinned messages"
              style={{ border: 'none', background: showPinned ? colors.goldDim : 'transparent', color: pinnedMessages.length ? colors.gold : colors.textFaint, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', borderRadius: '8px', padding: '6px 8px', fontSize: '12px', fontWeight: 700, fontFamily: fontMono }}
            >
              <Icon.Pin size={14} /> {pinnedMessages.length || ''}
            </button>
            <button
              className="icon-btn"
              onClick={swapPanels}
              title="Swap chat and voice panels"
              style={{ border: 'none', background: 'transparent', color: colors.textFaint, cursor: 'pointer', display: 'flex' }}
            >
              <Icon.SwapH size={14} />
            </button>
          </div>

          {showPinned && (
            <div style={{ borderBottom: `1px solid ${colors.borderSoft}`, maxHeight: '220px', overflowY: 'auto', padding: '10px 16px', backgroundColor: colors.panel, flexShrink: 0 }} className="scroll-thin">
              {pinnedMessages.length === 0 ? (
                <p style={{ margin: 0, fontSize: '12.5px', color: colors.textFaint, fontWeight: 500 }}>No pinned messages yet. Hover a message and click the pin icon.</p>
              ) : pinnedMessages.map((m) => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '8px 0', borderBottom: `1px solid ${colors.borderSoft}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.text }}>{m.sender}</span>
                      <span style={{ fontSize: '10.5px', color: colors.textFaint, fontFamily: fontMono }}>{formatMsgTime(new Date(m.createdAt).getTime())}</span>
                    </div>
                    {m.content && <div style={{ fontSize: '13px', color: colors.textMuted, wordBreak: 'break-word' }}>{m.content}</div>}
                  </div>
                  <button
                    className="icon-btn"
                    onClick={() => togglePin({ id: m.id, pinned: true })}
                    title="Unpin"
                    style={{ border: 'none', background: 'transparent', color: colors.gold, cursor: 'pointer', display: 'flex', flexShrink: 0, padding: '4px' }}
                  >
                    <Icon.Pin size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="scroll-thin" ref={chatScrollRef} onScroll={handleChatScroll} style={{ flex: 1, overflowY: 'auto', padding: '16px 12px 8px', textAlign: 'left' }}>
            {hasMoreHistory && chat.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0 14px' }}>
                <button
                  onClick={loadOlderMessages}
                  disabled={loadingMoreHistory}
                  style={{ border: `1px solid ${colors.borderSoft}`, background: colors.panelAlt, color: colors.textMuted, borderRadius: '20px', padding: '6px 14px', fontSize: '11.5px', fontWeight: 600, cursor: loadingMoreHistory ? 'default' : 'pointer', fontFamily: fontBody }}
                >
                  {loadingMoreHistory ? 'Loading…' : 'Load earlier messages'}
                </button>
              </div>
            )}
            {chat.length === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', marginTop: '48px', padding: '0 24px' }}>
                <span style={{ width: '44px', height: '44px', borderRadius: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brandDim, color: colors.brand }}><Icon.Send size={18} /></span>
                <p style={{ color: colors.textFaint, fontSize: '13px', textAlign: 'center', fontWeight: 500, margin: 0, lineHeight: 1.5 }}>No messages yet.<br />Say hi, or drag in a screenshot/clip.</p>
              </div>
            )}
            
            {chat.map((msg, index) => {
              if (msg.isError || msg.sender === 'System') {
                return (
                  <div key={index} style={{ padding: '8px 12px', margin: '8px', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: `1px solid rgba(239, 68, 68, 0.2)`, borderRadius: '8px', color: colors.danger, fontSize: '13px', fontWeight: 600 }}>
                    ⚠️ {msg.text}
                  </div>
                );
              }

              const isMe = msg.sender === user.username;
              const prev = chat[index - 1];
              const grouped = prev && prev.sender === msg.sender && !prev.isError && (msg.at || 0) - (prev.at || 0) < 5 * 60 * 1000;
              const isPending = !msg.id;
              const isEditing = Boolean(msg.id && editingMessageId === msg.id);
              const canDelete = isMe || canManage;
              return (
                <ChatMessageItem 
                  key={msg.clientId || msg.id || index}
                  msg={msg} 
                  isMe={isMe} 
                  grouped={grouped} 
                  isPending={isPending} 
                  isEditing={isEditing} 
                  canDelete={canDelete} 
                  user={user}
                  editDraft={editDraft} 
                  setEditDraft={setEditDraft} 
                  handleEditKeyDown={handleEditKeyDown} 
                  cancelEditMessage={cancelEditMessage} 
                  saveEditMessage={saveEditMessage}
                  startEditMessage={startEditMessage} 
                  setConfirmDeleteMessage={setConfirmDeleteMessage} 
                  togglePin={togglePin}
                  openUserProfile={openUserProfile} 
                  memberMap={memberMap} 
                  customEmojiMap={customEmojiMap}
                  emojiPickerOpenFor={emojiPickerOpenFor} 
                  emojiPickerAnchorEl={emojiPickerAnchorEl} 
                  openEmojiPicker={openEmojiPicker} 
                  closeEmojiPicker={closeEmojiPicker} 
                  toggleReaction={toggleReaction} 
                  customEmojis={customEmojis}
                  renderMessageHtml={renderMessageHtml} 
                  formatMsgTime={formatMsgTime} 
                  colorForName={colorForName} 
                  initialsForName={initialsForName}
                />
              );
            })}
            {pendingUploads.map((name) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: colors.textFaint, padding: '4px 8px 12px', fontWeight: 500 }}>
                <span style={{ width: '12px', height: '12px', borderRadius: '50%', border: `2px solid ${colors.textFaint}`, borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />
                Uploading {name}…
              </div>
            ))}
          </div>

          {isDraggingFile && (
            <div style={{ position: 'absolute', inset: 0, backgroundColor: colors.brandDim, border: `3px dashed ${colors.brand}`, borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}>
              <span style={{ fontFamily: fontDisplay, fontWeight: 700, fontSize: '15px', color: colors.text, backgroundColor: colors.panel, padding: '10px 20px', borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>Drop to share</span>
            </div>
          )}

          <div style={{ padding: '0 20px 24px', flexShrink: 0, position: 'relative' }}>
            {Object.keys(typingUsers).length > 0 && (
              <div style={{ position: 'absolute', top: '-22px', left: '24px', fontSize: '12px', fontWeight: 600, color: colors.brand, animation: 'fadeUp 0.2s ease' }}>
                <span style={{ display: 'inline-block', animation: 'pulseGlow 1.5s infinite', marginRight: '4px' }}>●</span> 
                {Object.keys(typingUsers).join(', ')} {Object.keys(typingUsers).length > 1 ? 'are' : 'is'} typing...
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', backgroundColor: 'rgba(20, 23, 42, 0.4)', backdropFilter: 'blur(16px)', border: `1px solid ${colors.borderSoft}`, borderRadius: '24px', padding: '8px 12px', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
              <label className="icon-btn" style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: colors.bg, color: colors.textMuted, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Attach a screenshot or clip">
                <Icon.Plus size={18} />
                <input type="file" accept="image/*,video/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAndShareFile(f); e.target.value = ''; }} />
              </label>

              <button
                id="composer-emoji-btn"
                type="button"
                className="icon-btn"
                onClick={(e) => openEmojiPicker('composer', e)}
                title="Emoji"
                style={{ width: '36px', height: '36px', borderRadius: '50%', border: 'none', backgroundColor: colors.bg, color: colors.textMuted, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon.Smile size={17} />
              </button>
              {emojiPickerOpenFor === 'composer' && (
                <EmojiPicker
                  customEmojis={customEmojis}
                  canUpload
                  anchorEl={emojiPickerAnchorEl}
                  onUploadEmoji={uploadCustomEmoji}
                  onPick={(token) => {
                    setMessage((m) => `${m}${token}`);
                    // Instantly steal focus back so hitting Enter sends the message
                    document.querySelector('.chat-input')?.focus(); 
                  }}
                  onClose={closeEmojiPicker}
                />
              )}

              <input
                id="global-chat-input" // <--- ADD THIS LINE
                className="chat-input"
                type="text"
                value={message}
                placeholder={`Message ${activeChannel?.name || ''}...`}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handleChatPaste}
                style={{ flex: 1, padding: '8px 12px', border: 'none', backgroundColor: 'transparent', color: colors.text, fontFamily: fontBody, fontSize: '14px', outline: 'none', minWidth: 0, textAlign: 'left' }}
              />

              <button 
                className="send-btn" 
                onClick={sendMessage} 
                disabled={!message.trim()} 
                style={{ width: '36px', height: '36px', borderRadius: '8px', border: 'none', backgroundColor: message.trim() ? colors.brand : 'transparent', color: message.trim() ? 'white' : colors.textFaint, cursor: message.trim() ? 'pointer' : 'default', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s ease' }} 
              >
                <Icon.Send size={16} />
              </button>
            </div>
          </div>
        </div>
{/* ================================= RESIZER BETWEEN THE TWO SWAPPABLE PANELS ================================= */}
        {/* Text channels have no voice stage to resize against — skip both the resizer and the panel below entirely. */}
        {activeChannel?.type !== 'text' && (
        <div
          onMouseDown={(e) => { 
            e.preventDefault(); 
            setResizeFlash(null); 
            setIsDraggingRight(true); 
          }}
          style={{
            order: 25, width: '6px', margin: '0 -3px', cursor: 'col-resize',
            backgroundColor: isDraggingRight ? colors.brand : 'transparent',
            boxShadow: isDraggingRight ? `0 0 14px 1px ${colors.brand}88` : 'none',
            zIndex: 10,
            transition: 'background-color 0.18s ease, box-shadow 0.18s ease',
            animation: resizeFlash === 'right' ? 'resizeFlash 0.5s ease-out' : 'none',
          }}
          onMouseEnter={(e) => { if (!isDraggingLeft && !isDraggingRight) e.currentTarget.style.backgroundColor = colors.borderSoft; }}
          onMouseLeave={(e) => { if (!isDraggingRight) e.currentTarget.style.backgroundColor = 'transparent'; }}
        />
        )}
{/* ================================= VOICE STAGE (drag the header to swap sides) ================================= */}
        {activeChannel?.type !== 'text' && (
        <div
          ref={voicePanelRef}
          style={{
            order: panelSwapped ? 20 : 30,
            flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: '300px',
            backgroundColor: 'transparent', display: 'flex', flexDirection: 'column', 
            opacity: isSwapping ? 0 : 1,
            transform: isSwapping ? 'scale(0.985)' : 'none',
            willChange: 'width',
            overflow: 'hidden', 
            transition: isDraggingLeft || isDraggingRight ? 'none' : 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.16s ease, transform 0.16s ease',
          }}
        >
          <div
            draggable={!isVoiceNarrow}
            onDragStart={handlePanelDragStart('voice')}
            onDragOver={handlePanelDragOver('voice')}
            onDragLeave={handlePanelDragLeave('voice')}
            onDrop={handlePanelDrop('voice')}
            onDragEnd={handlePanelDragEnd}
            title="Drag to move this panel — only changes your own layout"
            style={{ margin: '16px', padding: '12px 16px', borderRadius: '24px', backgroundColor: 'rgba(20, 23, 42, 0.4)', backdropFilter: 'blur(16px)', border: `1px solid ${colors.borderSoft}`, display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, cursor: 'grab', transition: 'all 0.3s ease', zIndex: 10 }}
          >
            <span style={{ color: colors.textFaint, display: 'flex' }}><Icon.Grip size={14} /></span>
            <span style={{ color: colors.textMuted, display: 'flex' }}><Icon.Volume size={18} /></span>
            <h3 style={{ margin: 0, fontSize: '16px', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden' }}>Voice Call</h3>
            <button
              className="icon-btn"
              onClick={swapPanels}
              title="Swap chat and voice panels"
              style={{ border: 'none', background: 'transparent', color: colors.textFaint, cursor: 'pointer', display: 'flex' }}
            >
              <Icon.SwapH size={14} />
            </button>
          </div>

          <div style={{ position: 'relative', flex: 1, minHeight: 0, margin: '16px', borderRadius: '32px', overflow: 'hidden', border: `1px solid ${colors.borderSoft}`, boxShadow: 'inset 0 0 60px rgba(0,0,0,0.8), 0 24px 60px rgba(0,0,0,0.4)', background: `radial-gradient(circle at 50% 50%, #18181b 0%, #050611 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }}>
            {token && activeChannel ? (
             <LiveKitRoom
                video={false}
                                audio={{
                  // Krisp and the browser should not denoise the same signal twice.
                  // Double suppression is what makes quiet syllables disappear.
                  noiseSuppression: voiceSettings.krispEnabled === false,
                  echoCancellation: true,
                  autoGainControl: true,
                  channelCount: 1,
                }}
                token={token}
                serverUrl={serverUrl}
                options={{ adaptiveStream: true, dynacast: true }}
                style={{ height: '100%', width: '100%' }}
                onDisconnected={handleDisconnected}
              >
                <VoiceReporter setVoiceUsers={setVoiceUsers} />
                <VoiceSession
                  username={user.username}
                  roomName={activeChannel.name}
                  channelType={activeChannel.type}
                  profile={profile}
                  streamSettings={streamSettings}
          memberMap={memberMap}
          onAvatarClick={openUserProfile}
          voiceSettings={voiceSettings}
          onVoiceSettingsChange={onSaveVoiceSettings}
          serverId={serverId}
          channelId={activeChannel.id}
          authToken={authToken}
          token={token}
          dockAnchor={voiceDockAnchor}
          minimized={isVoiceNarrow}
          isDragging={isDraggingLeft || isDraggingRight}
          onOpenSettings={() => setShowSettings((v) => !v)}
          backgroundTrackTitle={backgroundTrackTitle}
          myRole={myRole}
        />
              </LiveKitRoom>
            ) : !isVoiceNarrow ? (
              <button onClick={rejoinVoice} style={{ padding: '12px 24px', borderRadius: '10px', border: 'none', background: colors.brand, color: 'white', fontFamily: fontDisplay, fontWeight: 700, fontSize: '14px', cursor: 'pointer' }}>
                Connect to Voice
              </button>
            ) : (
              <button onClick={rejoinVoice} title="Connect to Voice" style={{ width: '42px', height: '42px', borderRadius: '50%', border: 'none', background: colors.brand, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.Volume size={16} />
              </button>
            )}
          </div>
        </div>
        )}

      </div>

      {showSettings && (
        <SettingsModal 
          authToken={authToken}
          username={user.username} 
          profile={profile} 
          streamSettings={streamSettings}
          voiceSettings={voiceSettings}
          onSave={async (p, s, v) => { await onSaveProfile(p); onSaveStream(s); onSaveVoiceSettings(v); setShowSettings(false); }} 
          onClose={() => setShowSettings(false)} 
        />
      )}
      {showMembers && <MembersModal authToken={authToken} serverId={serverId} myRole={myRole} onClose={() => setShowMembers(false)} onSelectUser={openUserProfile} />}
      {profileCard?.view === 'mini' && (
        <UserMiniProfile
          user={profileCard.user}
          currentUsername={user.username}
          authToken={authToken}
          onViewFull={() => setProfileCard({ user: profileCard.user, view: 'full' })}
          onClose={() => setProfileCard(null)}
        />
      )}
      {profileCard?.view === 'full' && (
        <UserFullProfileModal user={profileCard.user} currentUsername={user.username} authToken={authToken} onClose={() => setProfileCard(null)} />
      )}
      {showCreateChannel && <CreateChannelModal authToken={authToken} serverId={serverId} onCreated={(c) => { setChannels((prev) => [...prev, c]); setShowCreateChannel(false); }} onClose={() => setShowCreateChannel(false)} />}
      {confirmDeleteChannel && (
        <ConfirmModal
          title={`Delete "${confirmDeleteChannel.name}"?`}
          body="Anyone in this room right now will be disconnected. This can't be undone."
          onConfirm={deleteChannel}
          onCancel={() => setConfirmDeleteChannel(null)}
        />
      )}
      {confirmDeleteMessage && (
        <ConfirmModal
          title="Delete message?"
          body="This can't be undone."
          onConfirm={deleteMessage}
          onCancel={() => setConfirmDeleteMessage(null)}
        />
      )}
    </div>
  );
}
// ============================================================================
// FRIENDS & DIRECT MESSAGES
// ============================================================================
function FriendsPanel({ authToken, user, onClose }) {
  const api = useApi(authToken);
  const [tab, setTab] = useState('friends'); // 'friends' | 'requests'
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [selectedFriend, setSelectedFriend] = useState(null);
  const [dmMessages, setDmMessages] = useState([]);
  const [dmText, setDmText] = useState('');
  const [addUsername, setAddUsername] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [toast, setToast] = useState(null); 
  const dmScrollRef = useRef(null);
  const toastTimer = useRef(null);
 
  const showToast = (kind, text) => {
    clearTimeout(toastTimer.current);
    setToast({ kind, text });
    if (kind === 'error') playChime('error');
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const loadFriends = () => api('/friends').then(setFriends).catch((e) => showToast('error', e.message)).finally(() => setLoadingFriends(false));
  const loadRequests = () => api('/friends/requests').then(setRequests).catch((e) => showToast('error', e.message)).finally(() => setLoadingRequests(false));

  useEffect(() => { loadFriends(); loadRequests(); }, []); 

  useEffect(() => {
    const onReceived = () => loadRequests();
    const onAccepted = () => { loadFriends(); loadRequests(); };
    socket.on('friend_request_received', onReceived);
    socket.on('friend_request_accepted', onAccepted);
    return () => {
      socket.off('friend_request_received', onReceived);
      socket.off('friend_request_accepted', onAccepted);
    };
  }, []);

  useEffect(() => {
    if (!selectedFriend) return;
    api(`/dms/${selectedFriend.id}`).then(setDmMessages).catch((e) => showToast('error', e.message));
  }, [selectedFriend]); 

  useEffect(() => {
    const onDm = (msg) => {
      if (!selectedFriend) return;
      const involvesSelected = msg.senderId === selectedFriend.id || msg.recipientId === selectedFriend.id;
      if (involvesSelected) setDmMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    };
    socket.on('dm_received', onDm);
    return () => socket.off('dm_received', onDm);
  }, [selectedFriend]);

  useEffect(() => {
    if (dmScrollRef.current) dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight;
  }, [dmMessages]);

  const sendRequest = async () => {
    const uname = addUsername.trim();
    if (!uname || sending) return;
    if (uname.toLowerCase() === user.username.toLowerCase()) {
      showToast('error', "You can't add yourself.");
      return;
    }
    setSending(true);
    try {
      await api('/friends/requests', { method: 'POST', body: JSON.stringify({ username: uname }) });
      showToast('success', `Friend request sent to ${uname}.`);
      setAddUsername('');
      setTab('requests');
      loadRequests();
    } catch (e) {
      // A generic "Request failed (404)" here (no server-supplied message) means
      // the API server this app is pointed at doesn't have the /friends routes —
      // usually because the backend deploy is out of date, not a bad username.
      const friendly = /^Request failed \(404/i.test(e.message)
        ? "Couldn't reach the friends service (404). The server may need to be redeployed."
        : e.message;
      showToast('error', friendly);
    } finally {
      setSending(false);
    }
  };

  const acceptRequest = async (id) => {
    await api(`/friends/requests/${id}/accept`, { method: 'POST' }).catch((e) => showToast('error', e.message));
    playChime('friend-accept');
    loadFriends(); loadRequests();
  };
  const declineRequest = async (id) => {
    await api(`/friends/requests/${id}/decline`, { method: 'POST' }).catch((e) => showToast('error', e.message));
    loadRequests();
  };
  const unfriend = async (userId) => {
    await api(`/friends/${userId}`, { method: 'DELETE' }).catch((e) => showToast('error', e.message));
    if (selectedFriend?.id === userId) setSelectedFriend(null);
    loadFriends();
  };

  const sendDM = async () => {
    const text = dmText.trim();
    if (!text || !selectedFriend) return;
    setDmText('');
    try {
      await api(`/dms/${selectedFriend.id}`, { method: 'POST', body: JSON.stringify({ content: text }) });
      // The server echoes this back to us over 'dm_received' — no optimistic push needed.
    } catch (e) {
      showToast('error', e.message);
    }
  };

  const pendingCount = requests.incoming.length;
  const tabIndex = tab === 'friends' ? 0 : 1;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 45, backgroundColor: colors.bg, display: 'flex', flexDirection: 'column' }}>
      <GlobalStyle />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 0 0 20px', height: '48px', borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.panel, flexShrink: 0, WebkitAppRegion: 'drag' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', WebkitAppRegion: 'no-drag' }}>
          <button onClick={onClose} className="icon-btn" style={{ border: 'none', background: 'transparent', color: colors.textMuted, cursor: 'pointer', display: 'flex' }}><Icon.Back size={18} /></button>
          <h2 style={{ margin: 0, fontSize: '18px' }}>Friends</h2>
        </div>
        <WindowControls />
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left: tabs + list */}
        <div style={{ width: '300px', flexShrink: 0, backgroundColor: colors.panel, borderRight: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px 16px 0' }}>
            <div style={{ position: 'relative', display: 'flex', gap: '6px', marginBottom: '16px', backgroundColor: colors.bg, borderRadius: '10px', padding: '4px' }}>
              <div
                className="friend-tab-indicator"
                style={{ left: `calc(4px + ${tabIndex} * (50% - 2px))`, width: 'calc(50% - 4px)' }}
              />
              {['friends', 'requests'].map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="friend-tab"
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                    fontFamily: fontDisplay, fontWeight: 700, fontSize: '13px', textTransform: 'capitalize',
                    background: 'transparent', color: tab === t ? '#fff' : colors.textMuted,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                  }}
                >
                  {t}
                  {t === 'requests' && pendingCount > 0 && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '16px', height: '16px',
                      borderRadius: '999px', fontSize: '10px', fontWeight: 800, padding: '0 4px',
                      backgroundColor: tab === t ? 'rgba(255,255,255,0.25)' : colors.gold, color: tab === t ? '#fff' : colors.stage,
                    }}>
                      {pendingCount}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
              <input
                value={addUsername}
                onChange={(e) => setAddUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendRequest()}
                placeholder="Add friend by username"
                className="friend-panel-input"
                style={{ flex: 1, padding: '10px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bg, color: colors.text, fontFamily: fontBody, fontSize: '12.5px', boxSizing: 'border-box', transition: 'border-color 0.15s, box-shadow 0.15s' }}
              />
              <button
                onClick={sendRequest}
                disabled={!addUsername.trim() || sending}
                className="friend-add-btn"
                title="Send friend request"
                style={{ border: 'none', background: colors.brand, color: '#fff', borderRadius: '8px', padding: '0 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '38px' }}
              >
                {sending ? <span style={{ width: '13px', height: '13px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} /> : <Icon.UserPlus size={14} />}
              </button>
            </div>
            <p style={{ fontSize: '11px', color: colors.textFaint, margin: '0 0 14px', paddingLeft: '2px' }}>They'll get a request to accept before you can chat.</p>
          </div>

          <div className="scroll-thin" style={{ flex: 1, overflowY: 'auto', padding: '0 10px 10px' }}>
            {tab === 'friends' ? (
              loadingFriends ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '2px 6px' }}>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="skeleton" style={{ height: '52px', borderRadius: '10px' }} />
                  ))}
                </div>
              ) : friends.length === 0 ? (
                <div className="friend-empty" style={{ textAlign: 'center', padding: '40px 16px 0' }}>
                  <div className="friend-empty-icon" style={{ width: '52px', height: '52px', borderRadius: '50%', backgroundColor: colors.brandDim, color: colors.brand, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                    <Icon.Users size={22} />
                  </div>
                  <p style={{ color: colors.text, fontSize: '13.5px', fontWeight: 700, margin: '0 0 4px' }}>No friends yet</p>
                  <p style={{ color: colors.textFaint, fontSize: '12px', margin: 0, lineHeight: 1.5 }}>Add someone by username above to start a conversation.</p>
                </div>
              ) : friends.map((f, i) => (
                <div
                  key={f.id}
                  onClick={() => setSelectedFriend(f)}
                  className={`friend-row${selectedFriend?.id === f.id ? ' selected' : ''}`}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 10px', borderRadius: '10px', cursor: 'pointer', backgroundColor: selectedFriend?.id === f.id ? colors.brandDim : 'transparent', animationDelay: `${Math.min(i, 8) * 30}ms` }}
                >
                  <div className="friend-avatar-ring" style={{ width: '34px', height: '34px', borderRadius: '50%', background: f.avatarUrl ? 'transparent' : colorForName(f.username), overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '13px', color: '#fff', flexShrink: 0 }}>
                    {f.avatarUrl ? <img src={f.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(f.username)}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '13.5px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.username}</div>
                    <StatusLine statusText={f.statusText} statusEmoji={f.statusEmoji} style={{ fontSize: '11px' }} />
                  </div>
                  <Icon.MessageCircle size={13} className="friend-msg-hint" />
                  <button onClick={(e) => { e.stopPropagation(); unfriend(f.id); }} className="icon-btn friend-unfriend" title="Unfriend" style={{ border: 'none', background: 'transparent', color: colors.textFaint, cursor: 'pointer', display: 'flex', flexShrink: 0 }}><Icon.X size={13} /></button>
                </div>
              ))
            )  : loadingRequests ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '2px 6px' }}>
                {[0, 1].map((i) => (
                  <div key={i} className="skeleton" style={{ height: '44px', borderRadius: '10px' }} />
                ))}
              </div>
            ) : (
              <>
                {requests.incoming.length > 0 && (
                  <>
                    <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.textFaint, margin: '8px 6px 6px' }}>Incoming</p>
                    {requests.incoming.map((r, i) => (
                      <div key={r.id} className="request-card" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 10px', borderRadius: '10px', animationDelay: `${i * 30}ms` }}>
                        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: r.avatarUrl ? 'transparent' : colorForName(r.username), overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '11px', color: '#fff', flexShrink: 0 }}>
                          {r.avatarUrl ? <img src={r.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(r.username)}
                        </div>
                        <div style={{ flex: 1, fontSize: '13.5px', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.username}</div>
                        <button onClick={() => acceptRequest(r.id)} className="request-accept" title="Accept" style={{ border: 'none', background: colors.online, color: '#0d0f1a', borderRadius: '6px', padding: '5px 8px', cursor: 'pointer', display: 'flex' }}><Icon.Check size={12} /></button>
                        <button onClick={() => declineRequest(r.id)} className="request-decline" title="Decline" style={{ border: 'none', background: 'rgba(239,75,107,0.15)', color: colors.danger, borderRadius: '6px', padding: '5px 8px', cursor: 'pointer', display: 'flex' }}><Icon.X size={12} /></button>
                      </div>
                    ))}
                  </>
                )}
                {requests.outgoing.length > 0 && (
                  <>
                    <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.textFaint, margin: '14px 6px 6px' }}>Outgoing</p>
                    {requests.outgoing.map((r, i) => (
                      <div key={r.id} className="request-card" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 10px', borderRadius: '10px', animationDelay: `${i * 30}ms` }}>
                        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: r.avatarUrl ? 'transparent' : colorForName(r.username), overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '11px', color: '#fff', flexShrink: 0, opacity: 0.75 }}>
                          {r.avatarUrl ? <img src={r.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(r.username)}
                        </div>
                        <div style={{ flex: 1, fontSize: '13.5px', color: colors.textMuted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.username}</div>
                        <span style={{ fontSize: '11px', color: colors.textFaint, display: 'flex', alignItems: 'center', flexShrink: 0 }}><span className="pending-dot" />pending</span>
                      </div>
                    ))}
                  </>
                )}
                {requests.incoming.length === 0 && requests.outgoing.length === 0 && (
                  <div className="friend-empty" style={{ textAlign: 'center', padding: '40px 16px 0' }}>
                    <div className="friend-empty-icon" style={{ width: '52px', height: '52px', borderRadius: '50%', backgroundColor: colors.goldDim, color: colors.gold, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                      <Icon.UserPlus size={22} />
                    </div>
                    <p style={{ color: colors.text, fontSize: '13.5px', fontWeight: 700, margin: '0 0 4px' }}>No pending requests</p>
                    <p style={{ color: colors.textFaint, fontSize: '12px', margin: 0, lineHeight: 1.5 }}>Incoming and outgoing friend requests will show up here.</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right: DM conversation */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {!selectedFriend ? (
            <div className="friend-empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: colors.textFaint, gap: '12px' }}>
              <div className="friend-empty-icon" style={{ width: '64px', height: '64px', borderRadius: '50%', backgroundColor: colors.panelAlt, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.MessageCircle size={26} />
              </div>
              <p style={{ fontSize: '13.5px', margin: 0 }}>Pick a friend to start a conversation.</p>
            </div>
          ) : (
            <>
              <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.borderSoft}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '50%', background: selectedFriend.avatarUrl ? 'transparent' : colorForName(selectedFriend.username), overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '12px', color: '#fff' }}>
                  {selectedFriend.avatarUrl ? <img src={selectedFriend.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(selectedFriend.username)}
                </div>
                <h3 style={{ margin: 0, fontSize: '15px' }}>{selectedFriend.username}</h3>
              </div>

              <div ref={dmScrollRef} className="scroll-thin" style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
                {dmMessages.length === 0 && (
                  <div className="friend-empty" style={{ textAlign: 'center', padding: '30px 0' }}>
                    <p style={{ color: colors.textFaint, fontSize: '13px', margin: 0 }}>No messages yet. Say hi! 👋</p>
                  </div>
                )}
                {dmMessages.map((m) => {
                  const isMe = m.senderId === user.id;
                  return (
                    <div key={m.id} style={{ display: 'flex', justifyContent: isMe ? 'flex-end' : 'flex-start', marginBottom: '8px' }}>
                     <div className="dm-bubble" data-msg-id={m.id || ''} data-msg-text={m.content || ''} data-msg-isme={isMe ? 'true' : 'false'} data-msg-candelete={isMe ? 'true' : 'false'} data-msg-pinned="false" style={{ maxWidth: '60%', padding: '9px 13px', borderRadius: '14px', backgroundColor: isMe ? colors.brand : colors.panelAlt, color: isMe ? '#fff' : colors.text, fontSize: '14px', wordBreak: 'break-word' }}>
                        {m.content}
                        {m.attachment && (
                          m.attachment.kind === 'video' ? (
                            <video src={m.attachment.url} controls style={{ maxWidth: '260px', borderRadius: '8px', marginTop: '6px', display: 'block' }} />
                          ) : (
                            <img src={m.attachment.url} alt="" style={{ maxWidth: '260px', borderRadius: '8px', marginTop: '6px', display: 'block' }} />
                          )
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ padding: '0 20px 20px', flexShrink: 0 }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    value={dmText}
                    onChange={(e) => setDmText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDM(); } }}
                    placeholder={`Message ${selectedFriend.username}`}
                    className="friend-panel-input"
                    style={{ flex: 1, padding: '12px 14px', borderRadius: '10px', border: `1px solid ${colors.border}`, backgroundColor: colors.panel, color: colors.text, fontFamily: fontBody, fontSize: '14px', boxSizing: 'border-box', transition: 'border-color 0.15s, box-shadow 0.15s' }}
                  />
                  <button onClick={sendDM} disabled={!dmText.trim()} className="friend-send-btn" style={{ border: 'none', background: colors.brand, color: '#fff', borderRadius: '10px', padding: '0 16px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}><Icon.Send size={15} /></button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {toast && (
        <div
          className="friend-toast"
          style={{
            position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: 50,
            display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', maxWidth: '420px',
            color: toast.kind === 'error' ? colors.danger : colors.online,
            background: colors.panel, padding: '10px 16px', borderRadius: '10px',
            border: `1px solid ${toast.kind === 'error' ? 'rgba(239,75,107,0.35)' : 'rgba(126,231,135,0.35)'}`,
            boxShadow: '0 12px 30px rgba(0,0,0,0.5)',
          }}
        >
          {toast.kind === 'error' ? <Icon.X size={13} /> : <Icon.Check size={13} />}
          <span style={{ color: colors.text }}>{toast.text}</span>
        </div>
      )}
    </div>
  );
}

function CommandCapsule({ username, profile, roomName, deafened, onToggleDeafen, onToggleMic, onOpenSettings, minimized, isDragging }) {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const [ping, setPing] = useState(null);
  

  useEffect(() => {
    const handlePong = (sentAt) => setPing(Date.now() - sentAt);
    socket.on('pong_check', handlePong);
    const sendPing = () => socket.emit('ping_check', Date.now());
    sendPing();
    const interval = setInterval(sendPing, 3000);
    return () => { clearInterval(interval); socket.off('pong_check', handlePong); };
  }, []);

  const pingColor = ping == null ? colors.textFaint : ping < 100 ? colors.online : ping < 250 ? colors.speak : colors.danger;

return (
    <div style={{ position: 'absolute', bottom: '24px', left: '50%', transform: 'translateX(-50%)', zIndex: 100, pointerEvents: 'none', width: '100%', display: 'flex', justifyContent: 'center' }}>
      <div style={{ 
        pointerEvents: 'auto', 
        display: 'flex', 
        flexDirection: minimized ? 'column' : 'row', 
        alignItems: 'center', 
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: minimized ? '8px' : '14px', 
        padding: minimized ? '12px 8px' : '10px 16px', 
        backgroundColor: 'rgba(13, 15, 26, 0.88)', 
        backdropFilter: 'blur(24px)', 
        border: `1px solid ${colors.borderSoft}`, 
        borderRadius: '24px', 
        boxShadow: 'none', 
        animation: 'fadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        maxWidth: '92%',
        transition: isDragging ? 'none' : 'all 0.3s ease' // <--- UPDATE THIS
      }}>
        
        {/* Profile & Ping Section - Hidden when minimized */}
        {!minimized && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: '38px', height: '38px', borderRadius: '50%', background: colorForName(username), overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fontDisplay, fontWeight: 800, fontSize: '14px', color: '#fff', flexShrink: 0 }}>
              {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsForName(username)}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '13.5px', fontWeight: 700, color: colors.text, lineHeight: 1, whiteSpace: 'nowrap' }}>{username}</span>
              <span style={{ fontSize: '10.5px', fontWeight: 700, color: pingColor, display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                <span style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: pingColor, animation: 'pulseGlow 2s infinite' }} />
                {ping == null ? 'Connecting…' : `${ping}ms`}
              </span>
            </div>
          </div>
        )}

{/* Unified Voice Controls - Stacked when minimized or wrapping */}
        <div style={{ display: 'flex', flexDirection: minimized ? 'column' : 'row', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <RoundButton active={!isMicrophoneEnabled} danger onClick={onToggleMic} icon={isMicrophoneEnabled ? <Icon.Mic size={16} /> : <Icon.MicOff size={16} />} showLabel={false} label="Mic" />
          <RoundButton active={deafened} danger onClick={onToggleDeafen} icon={deafened ? <Icon.HeadphonesOff size={16} /> : <Icon.Headphones size={16} />} showLabel={false} label="Deafen" />
          <RoundButton active={!isCameraEnabled} danger onClick={() => localParticipant?.setCameraEnabled(!isCameraEnabled)} icon={isCameraEnabled ? <Icon.Camera size={16} /> : <Icon.CameraOff size={16} />} showLabel={false} label="Camera" />
          
          {/* Removed the !minimized condition so these always show up */}
         <RoundButton active={isScreenShareEnabled} onClick={() => window.dispatchEvent(new CustomEvent('trigger-share'))} icon={<Icon.Monitor size={16} />} showLabel={false} label="Share" />
          <RoundButton active={false} onClick={onOpenSettings} icon={<Icon.Settings size={16} />} showLabel={false} label="Settings" />
          
          {minimized ? (
            <div style={{ width: '22px', height: '1px', backgroundColor: colors.borderSoft, margin: '2px 0' }} />
          ) : (
            <div style={{ width: '1px', height: '22px', backgroundColor: colors.borderSoft, margin: '0 2px' }} />
          )}
          
          <button onClick={() => room?.disconnect()} style={{ width: '38px', height: '38px', borderRadius: '50%', border: 'none', backgroundColor: colors.danger, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform 0.15s', boxShadow: '0 4px 16px rgba(239, 75, 107, 0.4)', flexShrink: 0 }} onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'} onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}>
            <Icon.PhoneOff size={16} />
          </button>
        </div>

      </div>
    </div>
  );
}}

// ============================================================================
// ROOT APP
// ============================================================================
export function App() {
  // --- ADD THIS PIP CHECKER ---
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('pip') === 'true') {
    return (
      <PiPView 
        token={urlParams.get('token')} 
        trackSid={urlParams.get('trackSid')} 
        channelId={urlParams.get('channelId')} 
      />
    );
  }
  // ----------------------------

  const [authToken, setAuthToken] = useState(() => localStorage.getItem('authToken') || '');


  const [contextMenu, setContextMenu] = useState(null);

useEffect(() => {
    const handleContext = (e) => {
      let target = e.target;
      if (target.nodeType === 3) target = target.parentNode; 
      if (!target || !target.closest) return;

      const selection = window.getSelection().toString().trim();
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      const isImg = target.tagName === 'IMG' || target.tagName === 'VIDEO';

      const serverMsgNode = target.closest('.msg-row');
      const dmMsgNode = target.closest('.dm-bubble');
      const msgNode = serverMsgNode || dmMsgNode;

      if (!selection && !isInput && !isImg && !msgNode) {
        setContextMenu(null);
        return;
      }

      e.preventDefault();
      
      setContextMenu({
        x: Math.min(e.clientX, window.innerWidth - 240),
        y: Math.min(e.clientY, window.innerHeight - 380),
        selection,
        isInput,
        isImg,
        isServerMessage: !!serverMsgNode,
        isMessage: !!msgNode,
        msgText: msgNode ? (msgNode.getAttribute('data-msg-text') || '') : '',
        msgId: msgNode ? (msgNode.getAttribute('data-msg-id') || '') : '',
        isMe: msgNode ? (msgNode.getAttribute('data-msg-isme') === 'true') : false,
        canDelete: msgNode ? (msgNode.getAttribute('data-msg-candelete') === 'true') : false,
        isPinned: msgNode ? (msgNode.getAttribute('data-msg-pinned') === 'true') : false,
        src: isImg ? target.src : null,
        target: target
      });
    };

    const handleClick = () => setContextMenu(null);
    window.addEventListener('contextmenu', handleContext);
    window.addEventListener('click', handleClick);
    return () => {
      window.removeEventListener('contextmenu', handleContext);
      window.removeEventListener('click', handleClick);
    };
  }, []);

  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('authUser')) || null; } catch { return null; }
  });
  const api = useApi(authToken);

  const [currentServer, setCurrentServer] = useState(null); 
  const [profile, setProfile] = useState(() => {
    try { return JSON.parse(localStorage.getItem('soulProfile')) || { avatarUrl: null, bannerUrl: null, bannerColor: bannerSwatches[0], statusText: '', statusEmoji: '', badges: [] }; }
    catch { return { avatarUrl: null, bannerUrl: null, bannerColor: bannerSwatches[0], statusText: '', statusEmoji: '', badges: [] }; }
  });



  useEffect(() => {
    if (!authToken) return;
    api('/me').then((data) => {
      const hydrated = {
        avatarUrl: data.avatarUrl || null, bannerUrl: data.bannerUrl || null, bannerColor: data.bannerColor || bannerSwatches[0],
        statusText: data.statusText || '', statusEmoji: data.statusEmoji || '', badges: data.badges || [],
      };
      setProfile(hydrated);
      localStorage.setItem('soulProfile', JSON.stringify(hydrated));
    }).catch(() => {});
    // eslint-disable-next-line
  }, [authToken]);

  const [streamSettings, setStreamSettings] = useState(() => {
    try { return JSON.parse(localStorage.getItem('soulStreamSettings')) || { fps: 60, res: 1080, audio: false, micDeviceId: '', speakerDeviceId: '' }; }
    catch { return { fps: 60, res: 1080, audio: false }; }
  });

  const saveStreamSettings = (newSettings) => {
    setStreamSettings(newSettings);
    localStorage.setItem('soulStreamSettings', JSON.stringify(newSettings));
  };

  const [voiceSettings, setVoiceSettings] = useState(() => {
    const defaults = {
      levelerEnabled: true,
      krispEnabled: true,
      pttMode: false,
      soundboardVolume: 0.8,
      soundboardMuted: false,
      mutedSoundboardSenders: [],
      hotkeys: { toggleMute: 'CommandOrControl+Shift+M', toggleDeafen: 'CommandOrControl+Shift+D', pushToTalk: 'Space' },
    };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem('soulVoiceSettings')) }; }
    catch { return defaults; }
  });

 const saveVoiceSettings = (newSettings) => {
    setVoiceSettings(newSettings);
    
    // Throttle disk writes so 60fps WASD movement doesn't lock up the browser
    clearTimeout(saveVoiceSettings._ls);
    saveVoiceSettings._ls = setTimeout(() => {
      localStorage.setItem('soulVoiceSettings', JSON.stringify(newSettings));
    }, 500);

    // Debounce-sync each changed per-person mix to the account so it
    // follows across devices, instead of firing one PUT per slider tick.
    clearTimeout(saveVoiceSettings._t);
    saveVoiceSettings._t = setTimeout(() => {
      const overrides = newSettings.mixerOverrides || {};
      Object.entries(overrides).forEach(([identity, mix]) => {
        fetch(`${API_BASE}/mixer-presets/${encodeURIComponent(identity)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ voice: mix.voice ?? 1, stream: mix.stream ?? 1, bassCut: mix.bassCut ?? 90, trebleCut: mix.trebleCut ?? 8000, pan: (newSettings.roomPositions?.[identity]?.x) ?? 0 })
        }).catch(() => {});
      });
    }, 800);
  };

    useEffect(() => {
    if (!authToken) return;
    fetch(`${API_BASE}/mixer-presets`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((presets) => {
        if (!Array.isArray(presets) || !presets.length) return;
        setVoiceSettings((prev) => ({
          ...prev,
          mixerOverrides: {
            ...Object.fromEntries(presets.map((p) => [p.targetIdentity, { voice: p.voice, stream: p.stream, bassCut: p.bassCut, trebleCut: p.trebleCut }])),
            ...prev.mixerOverrides // local unsaved edits win
          }
        }));
      })
      .catch(() => {});
  }, [authToken]);

  // Push the saved hotkeys to the Electron main process once on launch.
  useEffect(() => {
    if (window.electronAPI?.hotkeys) window.electronAPI.hotkeys.update(voiceSettings.hotkeys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Join a private socket room keyed to this account so DMs and friend-request
  // notifications can be pushed straight to us, independent of which channel
  // (if any) we currently have joined.
  useEffect(() => {
    if (!user?.id) return;
    socket.emit('identify', user.id);
  }, [user?.id]);

  // ---- Notifications: channel directory, focus tracking, global listener --

  // channelId -> { serverId, serverName, channelName } across every server
  // the user belongs to. Used so a message that arrives while we're not
  // sitting in that room (or not even in that server) can still be checked
  // against per-server/per-channel mute and shown with a real room/server
  // name, regardless of what's currently on screen.
  const [channelDirectory, setChannelDirectory] = useState({});

  const refreshChannelDirectory = useCallback(async () => {
    if (!authToken) return;
    try {
      const servers = await api('/servers');
      const mine = servers.filter((s) => s.isMember);
     const groups = await Promise.all(mine.map(async (s) => {
        try {
          const chans = await api(`/servers/${s.id}/channels`);
          return chans.map((c) => [c.id, { serverId: s.id, serverName: s.name, channelName: c.name, type: c.type }]);
        } catch (e) { return []; }
      }));
      setChannelDirectory((prev) => ({ ...prev, ...Object.fromEntries(groups.flat()) }));
    } catch (e) { /* best-effort — notifications just fall back to generic copy */ }
  }, [authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refreshChannelDirectory(); }, [refreshChannelDirectory]);
  // Also refresh whenever we land back on the server list — catches any
  // rooms created/joined while ServerView's own live push (below) wasn't
  // active for that server.
  useEffect(() => { if (!currentServer) refreshChannelDirectory(); }, [currentServer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live push from whichever ServerView is currently mounted — keeps a
  // freshly-created room recognized immediately instead of waiting on the
  // next full refresh.
  const handleChannelsChange = useCallback((sid, sname, channels) => {
    setChannelDirectory((prev) => {
      const next = { ...prev };
      for (const c of channels) next[c.id] = { serverId: sid, serverName: sname, channelName: c.name, type: c.type };
      return next;
    });
  }, []);

  // Which room (if any) is currently open, reported by ServerView. Combined
  // with window focus below, this tells us "already looking right at it" —
  // the one case where a new message shouldn't trigger any alert at all.
  const [openChannelId, setOpenChannelId] = useState(null);
  const windowFocused = useWindowFocused();

  // Small in-app alert toast (distinct from FriendsPanel's own toast) for
  // new-message / mention nudges while the window has focus but the person
  // is looking at a different room, server, or the friends panel.
  const [alertToast, setAlertToast] = useState(null); // { kind: 'mention'|'message', title, body }
  const alertToastTimer = useRef(null);
  const showAlertToast = (payload) => {
    clearTimeout(alertToastTimer.current);
    setAlertToast(payload);
    alertToastTimer.current = setTimeout(() => setAlertToast(null), 5000);
  };
  useEffect(() => () => clearTimeout(alertToastTimer.current), []);

  // The single place new-message notifications are decided, regardless of
  // which screen (server list, a server, friends panel) is currently showing.
  useEffect(() => {
    if (!user) return;
    const handleIncoming = (data) => {
      if (!data?.channelId || data.sender === user.username) return; // never alert on our own messages
      if (isChannelMuted(data.channelId, user.username)) return;
      const info = channelDirectory[data.channelId];
      if (info && isServerMuted(info.serverId, user.username)) return;

      // Already looking right at this exact room with the window focused —
      // it's rendering live in chat, nothing more to do.
      if (openChannelId === data.channelId && windowFocused) return;

      // FOCUS ROOM MAGIC: Suppress all incoming OS notifications and sounds
      // if the user is currently sitting in a Focus room.
      const currentOpenInfo = channelDirectory[openChannelId];
      if (currentOpenInfo?.type === 'focus') return;

      const content = data.message ?? data.content ?? '';
      const mentioned = messageMentions(content, user.username);
      const channelLabel = info ? `#${info.channelName}` : 'a room';
      const serverLabel = info ? ` in ${info.serverName}` : '';
      const preview = content
        ? (content.length > 140 ? `${content.slice(0, 140)}…` : content)
        : (data.attachment ? '📎 Sent an attachment' : 'New message');

      if (windowFocused) {
        // App is open, just not looking at this room right now — a quiet
        // in-app nudge is enough.
        playChime(mentioned ? 'mention' : 'notify');
        showAlertToast({
          kind: mentioned ? 'mention' : 'message',
          title: mentioned ? `${data.sender} mentioned you` : `${data.sender} · ${channelLabel}`,
          body: preview,
        });
      } else {
        // Window isn't focused — reach them via the OS.
        playChime(mentioned ? 'mention' : 'notify');
        fireDesktopNotification(
          mentioned ? `${data.sender} mentioned you${serverLabel}` : `${data.sender}${serverLabel}`,
          `${channelLabel} — ${preview}`,
        );
      }
    };
    socket.on('receive_message', handleIncoming);
    return () => socket.off('receive_message', handleIncoming);
  }, [user, channelDirectory, windowFocused, openChannelId]);

  const [showFriends, setShowFriends] = useState(false);

  const handleAuthed = ({ token, user: u }) => {
    localStorage.setItem('authToken', token);
    localStorage.setItem('authUser', JSON.stringify(u));
    setAuthToken(token);
    setUser(u);
  };

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUser');
    setAuthToken('');
    setUser(null);
    setCurrentServer(null);
  };

  const saveProfile = async (newProfile) => {
    setProfile(newProfile);
    localStorage.setItem('soulProfile', JSON.stringify(newProfile));
    await api('/me/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        avatarUrl: newProfile.avatarUrl, bannerUrl: newProfile.bannerUrl, bannerColor: newProfile.bannerColor,
        statusText: newProfile.statusText, statusEmoji: newProfile.statusEmoji,
      }),
    });
  };

  if (!authToken || !user) {
    return <AuthScreen onAuthed={handleAuthed} />;
  }

  return (
    <>
      {!currentServer ? (
        <ServerListScreen
          authToken={authToken}
          user={user}
          onOpenServer={(id, name, role) => setCurrentServer({ id, name, role })}
          onOpenFriends={() => setShowFriends(true)}
          onLogout={handleLogout}
        />
      ) : (
        <ServerView
          authToken={authToken}
          user={user}
          serverId={currentServer.id}
          serverName={currentServer.name}
          myRole={currentServer.role}
          onBack={() => setCurrentServer(null)}
          profile={profile}
          onSaveProfile={saveProfile}
          streamSettings={streamSettings}
          onSaveStream={saveStreamSettings}
          voiceSettings={voiceSettings}
          onSaveVoiceSettings={saveVoiceSettings}
          onActiveChannelChange={setOpenChannelId}
          onChannelsChange={handleChannelsChange}
        />
      )}
      {showFriends && <FriendsPanel authToken={authToken} user={user} onClose={() => setShowFriends(false)} />}

      {alertToast && (
        <div
          className="alert-toast"
          onClick={() => setAlertToast(null)}
          style={{
            position: 'fixed', top: '20px', right: '20px', zIndex: 60, width: '320px',
            display: 'flex', flexDirection: 'column', gap: '4px', padding: '12px 14px', borderRadius: '12px',
            backgroundColor: colors.panel, boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
            border: `1px solid ${alertToast.kind === 'mention' ? 'rgba(212, 162, 76, 0.4)' : colors.border}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: alertToast.kind === 'mention' ? colors.gold : colors.brand, display: 'flex' }}>
              {alertToast.kind === 'mention' ? <Icon.Bell size={13} /> : <Icon.MessageCircle size={13} />}
            </span>
            <span style={{ fontSize: '13px', fontWeight: 700, color: colors.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alertToast.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); setAlertToast(null); }}
              className="icon-btn"
              style={{ border: 'none', background: 'transparent', color: colors.textFaint, cursor: 'pointer', display: 'flex', flexShrink: 0 }}
            >
              <Icon.X size={12} />
            </button>
          </div>
          <span style={{ fontSize: '12.5px', color: colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{alertToast.body}</span>
        </div>
      )}

{contextMenu && (
        <div style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 999999, backgroundColor: colors.panel, border: `1px solid ${colors.borderSoft}`, borderRadius: '8px', padding: '6px', boxShadow: '0 8px 30px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', minWidth: '220px', fontFamily: fontBody, fontSize: '13.5px', color: colors.textMuted, animation: 'popIn 0.1s ease', overflow: 'hidden' }}>
          
          {/* Quick Reactions - Discord Style */}
          {contextMenu.isServerMessage && !contextMenu.isInput && (
            <>
              <div style={{ display: 'flex', gap: '4px', padding: '4px', backgroundColor: colors.bg, borderRadius: '6px', marginBottom: '6px' }}>
                {['👍', '😂', '❤️', '🔥'].map(em => (
                  <button key={em} onClick={() => { if (contextMenu.msgId) window.dispatchEvent(new CustomEvent('quick-react', { detail: { msgId: contextMenu.msgId, emoji: em } })); setContextMenu(null); }} style={{ flex: 1, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '18px', transition: 'transform 0.15s, background-color 0.15s', padding: '6px 0', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.panelAlt; e.currentTarget.style.transform = 'scale(1.1)'; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}>
                    {em}
                  </button>
                ))}
              </div>
              <div style={{ height: '1px', backgroundColor: colors.borderSoft, margin: '4px 0' }} />
            </>
          )}

          {/* Core Message Options */}
          {contextMenu.isMessage && !contextMenu.isInput && (
            <>
              {contextMenu.isMe && contextMenu.isServerMessage && (
                <button onClick={() => { window.dispatchEvent(new CustomEvent('trigger-edit-msg', { detail: { id: contextMenu.msgId } })); setContextMenu(null); }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: colors.textMuted, padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.1s' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.brandDim; e.currentTarget.style.color = colors.text; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}>
                  <Icon.Edit size={16} /> Edit Message
                </button>
              )}

              <button onClick={() => { navigator.clipboard.writeText(contextMenu.msgText); setContextMenu(null); }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: colors.textMuted, padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.1s' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.brandDim; e.currentTarget.style.color = colors.text; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}>
                <Icon.Layers size={16} /> Copy Text
              </button>

              {contextMenu.isServerMessage && (
                 <button onClick={() => { window.dispatchEvent(new CustomEvent('trigger-pin-msg', { detail: { id: contextMenu.msgId } })); setContextMenu(null); }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: colors.textMuted, padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.1s' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.brandDim; e.currentTarget.style.color = colors.text; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}>
                  <Icon.Pin size={16} /> {contextMenu.isPinned ? 'Unpin Message' : 'Pin Message'}
                </button>
              )}
              
              {contextMenu.canDelete && (
                <>
                  <div style={{ height: '1px', backgroundColor: colors.borderSoft, margin: '4px 0' }} />
                  <button onClick={() => { window.dispatchEvent(new CustomEvent('trigger-delete-msg', { detail: { id: contextMenu.msgId } })); setContextMenu(null); }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: colors.danger, padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.1s' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(239, 75, 107, 0.15)'; e.currentTarget.style.color = colors.danger; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.danger; }}>
                    <Icon.Trash size={16} /> Delete Message
                  </button>
                </>
              )}
            </>
          )}

          {/* Copy Image fallback */}
          {contextMenu.isImg && (
            <button onClick={async () => {
                try {
                  const res = await fetch(contextMenu.src);
                  const blob = await res.blob();
                  await navigator.clipboard.write([new window.ClipboardItem({ [blob.type]: blob })]);
                  setContextMenu(null);
                } catch(e) {}
              }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: colors.textMuted, padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.1s' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.brandDim; e.currentTarget.style.color = colors.text; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}>
              <Icon.Image size={16} /> Copy Image
            </button>
          )}

          {/* Input Block for Textboxes */}
          {contextMenu.isInput && (
            <>
              {contextMenu.selection && (
                <>
                  <button onClick={() => { contextMenu.target.focus(); document.execCommand('cut'); setContextMenu(null); }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: colors.textMuted, padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, transition: 'all 0.1s' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.brandDim; e.currentTarget.style.color = colors.text; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}>Cut</button>
                  <button onClick={() => { contextMenu.target.focus(); document.execCommand('copy'); setContextMenu(null); }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: colors.textMuted, padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, transition: 'all 0.1s' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.brandDim; e.currentTarget.style.color = colors.text; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}>Copy</button>
                </>
              )}
              <button onClick={async () => { 
                contextMenu.target.focus(); 
                try {
                  const text = await navigator.clipboard.readText();
                  document.execCommand('insertText', false, text);
                } catch (e) {
                  console.error('Clipboard read failed:', e);
                }
                setContextMenu(null); 
              }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: colors.textMuted, padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.1s' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.brandDim; e.currentTarget.style.color = colors.text; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = colors.textMuted; }}>
                <Icon.Layers size={16} /> Paste
              </button>
              <div style={{ height: '1px', backgroundColor: colors.borderSoft, margin: '4px 0' }} />
              <button onClick={() => { window.dispatchEvent(new CustomEvent('trigger-composer-emoji')); setContextMenu(null); }} style={{ textAlign: 'left', background: 'transparent', border: 'none', color: colors.brand, padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.1s' }} onMouseEnter={e => { e.currentTarget.style.backgroundColor = colors.brandDim; }} onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}>
                <Icon.Smile size={16} /> Insert Emoji
              </button>
            </>
          )}
        </div>
      )}

      <UpdateNotification />
    </>
  );
}
export default App;