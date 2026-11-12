import { useEffect, useRef, useState } from "react";
import { OBJ } from "@/lib/objects";
import { LAND, LAND_H, LAND_W } from "./landmask";

function isLand(lat: number, lon: number) {
  const x = Math.floor(((lon + 180) / 360) * LAND_W) % LAND_W;
  const y = Math.min(LAND_H - 1, Math.floor(((90 - lat) / 180) * LAND_H));
  const row = LAND[y]!;
  const nib = parseInt(row[x >> 2]!, 16);
  return (nib >> (3 - (x & 3))) & 1;
}

/** Real-time dotted globe turned to Africa. Loads Three.js after first paint; poster until ready. */
export function Globe({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    const start = async () => {
      const el = host.current;
      if (!el || disposed) return;
      try {
        const THREE = await import("three");
        if (disposed) return;
        const css = getComputedStyle(document.documentElement);
        const col = (v: string) => { const c = document.createElement("canvas").getContext("2d")!; c.fillStyle = css.getPropertyValue(v).trim(); c.fillRect(0, 0, 1, 1); const d = c.getImageData(0, 0, 1, 1).data; return new THREE.Color(d[0]! / 255, d[1]! / 255, d[2]! / 255); };
        const lime = col("--accent"), forest = col("--forest"), ink = col("--ink");
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        const size = () => { const s = el.clientWidth; renderer.setSize(s, s); };
        size();
        el.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
        camera.position.z = 4.1;
        const group = new THREE.Group();
        scene.add(group);
        const pos: number[] = [], colors: number[] = [];
        const N = 16000;
        for (let i = 0; i < N; i++) {
          const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = Math.PI * (3 - Math.sqrt(5)) * i;
          const lat = Math.asin(y) * 180 / Math.PI;
          let lon = (Math.atan2(Math.sin(th) * r, Math.cos(th) * r) * 180) / Math.PI;
          if (!isLand(lat, lon)) continue;
          const phi = (90 - lat) * Math.PI / 180, lam = (lon + 180) * Math.PI / 180;
          pos.push(-Math.sin(phi) * Math.cos(lam), Math.cos(phi), Math.sin(phi) * Math.sin(lam));
          const africa = lat > -36 && lat < 38 && lon > -18 && lon < 52;
          const c = africa ? lime : forest;
          colors.push(c.r, c.g, c.b);
          lon = lon + 0;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
        group.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.018, vertexColors: true, transparent: true, opacity: 0.95 })));
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.985, 48, 48), new THREE.MeshBasicMaterial({ color: ink, transparent: true, opacity: 0.92 }));
        group.add(sphere);
        // Face Africa (lon ~20E, lat ~5N) toward the camera.
        const baseY = -Math.PI / 2 - (20 * Math.PI) / 180;
        group.rotation.set(0.12, baseY, 0);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let raf = 0, t = 0, px = 0;
        const onMove = (e: PointerEvent) => { px = e.clientX / window.innerWidth - 0.5; };
        window.addEventListener("pointermove", onMove, { passive: true });
        const loop = () => { t += 0.004; group.rotation.y += (baseY + Math.sin(t) * 0.35 + px * 0.4 - group.rotation.y) * 0.05; renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
        if (reduce) renderer.render(scene, camera); else loop();
        window.addEventListener("resize", size);
        setReady(true);
        cleanup = () => { cancelAnimationFrame(raf); window.removeEventListener("pointermove", onMove); window.removeEventListener("resize", size); renderer.dispose(); geo.dispose(); renderer.domElement.remove(); };
      } catch { /* keep poster */ }
    };
    const id = ("requestIdleCallback" in window ? window.requestIdleCallback : (cb: () => void) => setTimeout(cb, 200))(() => start());
    return () => { disposed = true; if (typeof id === "number" && "cancelIdleCallback" in window) window.cancelIdleCallback(id); cleanup(); };
  }, []);
  return (
    <div className={className} aria-hidden>
      <div ref={host} className="relative aspect-square w-full [&>canvas]:!h-full [&>canvas]:!w-full">
        {!ready && <img src={OBJ.globe.src} alt="" className="absolute inset-0 h-full w-full object-contain opacity-80" />}
      </div>
    </div>
  );
}
