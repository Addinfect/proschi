import { useEffect, useRef } from 'react';
import { useStoreApi } from 'reactflow';
import type { FlowOverlay, NodeOverlay } from '../../sim/overlay';
import { along, boxOf } from './geometry';

interface FlowParticlesProps {
  flows: readonly FlowOverlay[];
  nodes: Readonly<Record<string, NodeOverlay>>;
  /** 1 is the normal pace. */
  speed?: number;
}

interface Particle {
  from: string;
  to: string;
  t: number;
  async: boolean;
  /** Dropped requests fall off an overloaded node instead. */
  fall?: { x: number; y: number; vx: number; vy: number };
}

const MAX = 240;

/** A drawn connection's line, and whether it runs against the flow. */
interface Route {
  path: SVGPathElement;
  length: number;
  reversed: boolean;
}

/**
 * Requests as dots flowing along the canvas's connections, on the line each
 * connection is drawn with (or from a node's bottom to the next one's top
 * when none is drawn between them): more dots for more traffic, hollow ones for
 * async work, and red ones falling off nodes past 100%. Rendered inside
 * `<ReactFlow>`, it follows pan and zoom; it draws nothing with reduced motion.
 */
export default function FlowParticles({ flows, nodes, speed = 1 }: FlowParticlesProps) {
  const store = useStoreApi();
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ flows, nodes, speed });
  live.current = { flows, nodes, speed };

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext('2d');
    if (!el || !g) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const particles: Particle[] = [];
    const debt = new Map<string, number>();
    const css = getComputedStyle(document.documentElement);
    const rgb = (name: string) => `rgb(${css.getPropertyValue(name).trim().split(/\s+/).join(',')})`;
    const colors = { sync: rgb('--c-blue'), async: rgb('--c-lilac'), drop: rgb('--c-fail') };
    let frame = 0;
    let last = performance.now();

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { flows: F, nodes: N, speed: S } = live.current;
      const { transform, nodeInternals, edges } = store.getState();
      const [tx, ty, zoom] = transform;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      // Draw in flow coordinates: the transform of the viewport, scaled for the screen.
      g.setTransform(zoom * dpr, 0, 0, zoom * dpr, tx * dpr, ty * dpr);
      g.clearRect(-tx / zoom, -ty / zoom, w / zoom, h / zoom);
      const box = (id: string) => boxOf(nodeInternals.get(id));
      // The drawn line between two nodes, looked up once a frame: the layout routes it around other boxes.
      const routes = new Map<string, Route | undefined>();
      const routeOf = (from: string, to: string): Route | undefined => {
        const key = `${from}>${to}`;
        if (!routes.has(key)) {
          const edge = edges.find((e) => (e.source === from && e.target === to) || (e.source === to && e.target === from));
          const path = edge && el.closest('.react-flow')?.querySelector<SVGPathElement>(`[data-testid="rf__edge-${CSS.escape(edge.id)}"] .react-flow__edge-path`);
          routes.set(key, path ? { path, length: path.getTotalLength(), reversed: edge.source !== from } : undefined);
        }
        return routes.get(key);
      };

      if (!document.hidden) {
        for (const f of F) {
          if (f.rps <= 0 || !box(f.from) || !box(f.to)) continue;
          const key = `${f.from}>${f.to}`;
          const rate = (1.5 + Math.log10(f.rps + 1) * 1.6) * S;
          const d = (debt.get(key) ?? Math.random()) + rate * dt;
          const n = Math.floor(d);
          debt.set(key, d - n);
          for (let i = 0; i < n && particles.length < MAX; i++) particles.push({ from: f.from, to: f.to, t: 0, async: f.async });
        }
        for (const [id, o] of Object.entries(N)) {
          const b = box(id);
          if (!b || !o.saturated || o.down || o.utilization === undefined) continue;
          if (Math.random() > Math.min(0.9, (o.utilization - 1) * 2 + 0.15) * S * dt * 8 || particles.length >= MAX) continue;
          particles.push({ from: id, to: id, t: 0, async: false, fall: { x: b.x + Math.random() * b.w, y: b.y + b.h, vx: (Math.random() - 0.5) * 40, vy: -40 } });
        }
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const q = particles[i];
        if (q.fall) {
          q.fall.vy += 420 * dt;
          q.fall.x += q.fall.vx * dt;
          q.fall.y += q.fall.vy * dt;
          q.t += dt;
          if (q.t > 1.2) {
            particles.splice(i, 1);
            continue;
          }
          g.globalAlpha = Math.max(0, 1 - q.t / 1.2);
          g.fillStyle = colors.drop;
          g.fillRect(q.fall.x - 3, q.fall.y - 3, 6, 6);
          g.globalAlpha = 1;
          continue;
        }
        const a = box(q.from);
        const b = box(q.to);
        q.t += dt * 1.25 * S;
        if (!a || !b || q.t >= 1) {
          particles.splice(i, 1);
          continue;
        }
        const route = routeOf(q.from, q.to);
        const { x, y } = route ? route.path.getPointAtLength((route.reversed ? 1 - q.t : q.t) * route.length) : along(a, b, q.t);
        g.beginPath();
        g.arc(x, y, 4, 0, Math.PI * 2);
        if (q.async) {
          g.strokeStyle = colors.async;
          g.lineWidth = 2;
          g.stroke();
        } else {
          g.fillStyle = colors.sync;
          g.fill();
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [store]);

  return <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 z-[5] h-full w-full" />;
}
