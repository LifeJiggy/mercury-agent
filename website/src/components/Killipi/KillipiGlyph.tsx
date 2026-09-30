import React, { useEffect, useRef, useState } from 'react';
import './glyph.css';

type Mood = 'idle' | 'thinking' | 'surprised' | 'happy' | 'sleepy';

/**
 * KillipiGlyph — Mercury's presence, rendered as a living glyph (v2.5).
 *
 * Mercury orb core + crescent shading inside a slowly rotating orbital ring
 * system. Cursor parallax, blinking, moods, sleepy after inactivity. New in
 * v2.5: a demo-synced state machine — the hero terminal `working`/`complete`
 * beats drive ring tempo (idle 38s → working 7s → success pulse), so the
 * mascot and the proof surface act as one system (Pi playbook). First-person
 * voice lines rotate under the glyph.
 */

const MOOD_LABEL: Record<Mood, string> = {
  idle: '',
  thinking: 'thinking · 25-step loop',
  surprised: 'oh!',
  happy: 'all clear',
  sleepy: 'zzz · say hi',
};

const VOICE_LINES = [
  'I keep a second brain so you don’t have to.',
  'Nothing runs without your say.',
  'Ask me from six places.',
];

type Eye = { x: number; y: number };

type ExternalGlyphControl = {
  setMood: (m: Mood) => void;
  hold: (ms: number) => void;
};

type GlyphBusWorking = (() => void) & { __holdUntil?: (t: number) => void };

/* ---- global demo-sync channel (handed to the hero script via window) ---- */
type GlyphBus = {
  working: GlyphBusWorking;
  complete: () => void;
  idle: () => void;
};

let glyphBus: GlyphBus | null = null;

export function getGlyphBus(): GlyphBus | null {
  return glyphBus;
}

export default function KillipiGlyph(): React.ReactElement {
  const [eye, setEye] = useState<Eye>({ x: 0, y: 0 });
  const [mood, setMood] = useState<Mood>('idle');
  const [blink, setBlink] = useState(false);
  const [voice, setVoice] = useState(VOICE_LINES[0]);
  const [voiceFading, setVoiceFading] = useState(false);

  /* ---- demo-sync: expose working/complete to the hero terminal script ---- */
  useEffect(() => {
    let busyHold = 0;
    let restore: ReturnType<typeof setTimeout> | null = null;
    const bus: GlyphBus = {
      working: () => {
        const el = document.getElementById('killipi-orb');
        el?.classList.add('kp-working');
        el?.classList.remove('kp-success');
      },
      complete: () => {
        const el = document.getElementById('killipi-orb');
        if (!el) return;
        const now = Date.now();
        if (now < busyHold) return; // still mid-run — stay in working tempo
        el.classList.remove('kp-working');
        el.classList.add('kp-success');
        if (restore) clearTimeout(restore);
        restore = setTimeout(() => {
          el.classList.remove('kp-success');
        }, 1900);
      },
      idle: () => {
        busyHold = 0;
        const el = document.getElementById('killipi-orb');
        el?.classList.remove('kp-working', 'kp-success');
      },
    };
    bus.working.__holdUntil = (t: number) => { busyHold = t; };
    glyphBus = bus;
    (window as any).mercuryGlyph = bus;
    return () => {
      glyphBus = null;
      delete (window as any).mercuryGlyph;
    };
  }, []);

  const asleepRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eyeRaf = useRef(0);
  const lastMouse = useRef({ x: 0, y: 0 });
  const glyphCenterRef = useRef({ x: 0, y: 0 });

  /* ---------- cursor tracking (soft parallax) ---------- */
  const applyEye = React.useCallback(() => {
    eyeRaf.current = 0;
    const c = glyphCenterRef.current;
    const dx = lastMouse.current.x - c.x;
    const dy = lastMouse.current.y - c.y;
    const dist = Math.hypot(dx, dy) || 1;
    const factor = Math.min(dist / 420, 1);
    const max = asleepRef.current ? 0 : 9;
    setEye({
      x: (dx / dist) * max * factor,
      y: (dy / dist) * max * factor,
    });
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastMouse.current = { x: e.clientX, y: e.clientY };
      if (!eyeRaf.current) {
        eyeRaf.current = requestAnimationFrame(applyEye);
      }
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (eyeRaf.current) cancelAnimationFrame(eyeRaf.current);
    };
  }, [applyEye]);

  useEffect(() => {
    const measure = () => {
      const svg = document.getElementById('killipi-orb-svg');
      if (svg) {
        const r = svg.getBoundingClientRect();
        glyphCenterRef.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    };
    measure();
    window.addEventListener('resize', measure);
    const t = window.setInterval(measure, 2500);
    return () => {
      window.removeEventListener('resize', measure);
      clearInterval(t);
    };
  }, []);

  /* ---------- wake / sleepy phases ---------- */
  useEffect(() => {
    const wake = () => {
      if (asleepRef.current) {
        asleepRef.current = false;
        setMood('surprised');
        setTimeout(() => setMood('idle'), 900);
      }
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        asleepRef.current = true;
        setMood('sleepy');
      }, 14000);
    };
    wake();
    window.addEventListener('mousemove', wake, { passive: true });
    window.addEventListener('scroll', wake, { passive: true });
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('scroll', wake);
      window.removeEventListener('keydown', wake);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  /* ---------- blinking ---------- */
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const schedule = () => {
      t = setTimeout(() => {
        setBlink(true);
        setTimeout(() => {
          setBlink(false);
          schedule();
        }, 140);
      }, 2200 + Math.random() * 3600);
    };
    schedule();
    return () => clearTimeout(t);
  }, []);

  /* ---------- cycling label for the thinking state ---------- */
  useEffect(() => {
    if (mood !== 'thinking') return;
    const t = setTimeout(() => setMood('idle'), 3500);
    return () => clearTimeout(t);
  }, [mood]);

  /* ---------- rotating first-person voice line (Pi pattern) ---------- */
  useEffect(() => {
    let i = 0;
    const rotate = setInterval(() => {
      setVoiceFading(true);
      setTimeout(() => {
        i = (i + 1) % VOICE_LINES.length;
        setVoice(VOICE_LINES[i]);
        setVoiceFading(false);
      }, 500);
    }, 7000);
    return () => clearInterval(rotate);
  }, []);

  const onClick = () => {
    const order: Mood[] = ['happy', 'surprised', 'thinking'];
    const i = order.indexOf(mood);
    const pick = i === -1 ? 0 : (i + 1) % order.length;
    setMood(order[pick]);
  };

  /* ---------- eyes + mouth by mood ---------- */
  const feature = 'var(--kp-feature)';
  const lx = 37 + eye.x;
  const rx = 47 + eye.x;
  const ly = 40 + eye.y;

  const eyes = () => {
    if (blink && mood !== 'sleepy') {
      return (
        <>
          <line x1={lx - 3} y1={ly} x2={lx + 3} y2={ly} stroke={feature} strokeWidth={1.6} strokeLinecap="round" />
          <line x1={rx - 3} y1={ly} x2={rx + 3} y2={ly} stroke={feature} strokeWidth={1.6} strokeLinecap="round" />
        </>
      );
    }
    switch (mood) {
      case 'happy':
        return (
          <>
            <path d={`M ${lx - 3.5} ${ly + 1} Q ${lx} ${ly - 3.5} ${lx + 3.5} ${ly + 1}`} stroke={feature} strokeWidth={1.7} fill="none" strokeLinecap="round" />
            <path d={`M ${rx - 3.5} ${ly + 1} Q ${rx} ${ly - 3.5} ${rx + 3.5} ${ly + 1}`} stroke={feature} strokeWidth={1.7} fill="none" strokeLinecap="round" />
          </>
        );
      case 'surprised':
        return (
          <>
            <circle cx={lx} cy={ly} r={2.6} fill={feature} />
            <circle cx={rx} cy={ly} r={2.6} fill={feature} />
          </>
        );
      case 'sleepy':
        return (
          <>
            <path d={`M ${lx - 3} ${ly} Q ${lx} ${ly + 2.5} ${lx + 3} ${ly}`} stroke={feature} strokeWidth={1.6} fill="none" strokeLinecap="round" />
            <path d={`M ${rx - 3} ${ly} Q ${rx} ${ly + 2.5} ${rx + 3} ${ly}`} stroke={feature} strokeWidth={1.6} fill="none" strokeLinecap="round" />
          </>
        );
      case 'thinking':
        return (
          <>
            <circle cx={lx} cy={ly} r={2.4} fill={feature} />
            <path d={`M ${rx - 3} ${ly - 2} L ${rx + 3} ${ly + 2}`} stroke={feature} strokeWidth={1.6} strokeLinecap="round" />
          </>
        );
      default:
        return (
          <>
            <circle cx={lx} cy={ly} r={2.4} fill={feature} />
            <circle cx={rx} cy={ly} r={2.4} fill={feature} />
          </>
        );
    }
  };

  const mouth = () => {
    const mx = 42 + eye.x * 0.4;
    const my = 47 + eye.y * 0.3;
    switch (mood) {
      case 'happy':
        return <path d={`M ${mx - 3.5} ${my} Q ${mx} ${my + 3.5} ${mx + 3.5} ${my}`} stroke={feature} strokeWidth={1.6} fill="none" strokeLinecap="round" />;
      case 'surprised':
        return <circle cx={mx} cy={my + 1} r={1.6} fill="none" stroke={feature} strokeWidth={1.5} />;
      case 'thinking':
        return <line x1={mx - 3} y1={my} x2={mx + 3} y2={my + 1} stroke={feature} strokeWidth={1.6} strokeLinecap="round" />;
      case 'sleepy':
        return <line x1={mx - 2.5} y1={my} x2={mx + 2.5} y2={my} stroke={feature} strokeWidth={1.5} strokeLinecap="round" />;
      default:
        return <path d={`M ${mx - 2.5} ${my} Q ${mx} ${my + 2} ${mx + 2.5} ${my}`} stroke={feature} strokeWidth={1.5} fill="none" strokeLinecap="round" />;
    }
  };

  const thinking = mood === 'thinking';
  const sleepy = mood === 'sleepy';

  return (
    <div className="kp-wrap">
      <div
        id="killipi-orb"
        role="img"
        aria-label="Killipi — Mercury's mascot. Interact by moving the cursor or clicking."
        onClick={onClick}
      >
        <div className="kp-ambient" aria-hidden="true" />
        <svg
          id="killipi-orb-svg"
          viewBox="0 0 84 68"
          xmlns="http://www.w3.org/2000/svg"
          className="kp-svg"
        >
          {/* orbital rings */}
          <g className="kp-rings">
            <ellipse className="kp-ring kp-ring-a" cx="42" cy="34" rx="34" ry="13.5" />
            <ellipse className="kp-ring-b kp-ring" cx="42" cy="34" rx="34" ry="13.5" />
          </g>
          {/* orb core */}
          <g className="kp-core" style={{ transform: `translate(${eye.x * 0.35}px, ${eye.y * 0.4}px)` }}>
            <circle cx="42" cy="34" r="17" className="kp-orb" />
            <path
              d="M 42 17 A 17 17 0 0 0 42 51 A 12.5 12.5 0 0 1 42 17 Z"
              className="kp-crescent"
              fill="none"
            />
            <circle cx="42" cy="34" r="14" className="kp-inner" />
            {/* face */}
            {eyes()}
            {mouth()}
            {mood === 'thinking' && (
              <g className="kp-ellipses">
                <circle cx="52" cy="24" r="1.1" fill={feature} opacity={0.9}>
                  <animate attributeName="opacity" values="0.2;0.9;0.2" dur="1.2s" repeatCount="indefinite" />
                </circle>
                <circle cx="56" cy="20" r="1.4" fill={feature} opacity={0.7}>
                  <animate attributeName="opacity" values="0.2;0.9;0.2" dur="1.2s" begin="0.3s" repeatCount="indefinite" />
                </circle>
                <circle cx="59" cy="17" r="1.0" fill={feature} opacity={0.6}>
                  <animate attributeName="opacity" values="0.15;0.8;0.15" dur="1.2s" begin="0.6s" repeatCount="indefinite" />
                </circle>
              </g>
            )}
            {/* mercury symbol under the orb */}
            <g className="kp-symbol">
              <line x1="42" y1="51" x2="42" y2="62" />
              <line x1="36" y1="57" x2="48" y2="57" />
            </g>
          </g>
        </svg>
        {mood !== 'idle' && (
          <div className="kp-status">
            {mood === 'sleepy' ? 'zzz' : MOOD_LABEL[mood]}
          </div>
        )}
      </div>
      <div className="kp-voice" style={{ opacity: voiceFading ? 0 : 1 }}>
        {voice}
      </div>
    </div>
  );
}