"use client";

/**
 * PixelColiseum — auto-rotating low-poly Coliseum mesh.
 *
 * Visual brief (from the home-page redesign hero):
 *   - Flat-shaded, pixelated/voxel aesthetic (no smoothing, low
 *     segment counts so polygons read as discrete facets).
 *   - 3 stacked tiers of arched pillars on an octagonal base — the
 *     Roman Coliseum silhouette without any photoreal pretense.
 *   - Brand colors: gold-bronze stones with oxblood accents on the
 *     base plinth + a small gold flag/sigil on top.
 *   - Rotates ~one revolution per 25s on the Y axis. Optional
 *     subtle "breathing" bob so the piece never sits still.
 *
 * Implementation notes:
 *   - Plain three.js (no react-three-fiber) — the scene is static
 *     enough that the ~50KB fiber wrapper isn't worth it here.
 *   - Single canvas, single requestAnimationFrame loop, single
 *     ResizeObserver. All cleanup on unmount.
 *   - Renders only on the client. The component is "use client"
 *     and the canvas mounts in useEffect, so SSR never touches
 *     three. The placeholder div keeps the hero layout stable
 *     during hydration.
 *   - Tweens stop when the tab is hidden (visibilitychange) to
 *     avoid burning the user's GPU on a background tab.
 *
 * Sizing:
 *   - Fills its parent container's width × height. The container
 *     should set both — the canvas isn't scrolling content.
 *   - DPR clamped to 2 so we don't render at 3× on retina iPhones
 *     for no visual gain.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

export interface PixelColiseumProps {
  /** CSS class applied to the wrapping div. Sets size via CSS. */
  className?: string;
  /**
   * Override the auto-rotation period in seconds. Default 25.
   * Pass `null` to disable rotation entirely (e.g. for reduced-
   * motion contexts).
   */
  rotationPeriodSec?: number | null;
}

export function PixelColiseum({
  className,
  rotationPeriodSec = 25,
}: PixelColiseumProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // ---- scene ---------------------------------------------------------
    const scene = new THREE.Scene();
    // Transparent background — the hero gradient bleeds through.
    scene.background = null;

    // Group everything in a single root so we rotate the whole piece.
    const root = new THREE.Group();
    scene.add(root);

    // ---- camera --------------------------------------------------------
    // Orthographic for a clean voxel-game look — no foreshortening
    // distortion across the tiers. Frustum widened from the
    // original 5.2 → 7.2 to give the coliseum room to breathe with
    // the surrounding ground + scattered stones.
    const aspect = 1; // resized in resize() below
    const frustum = 7.2;
    const camera = new THREE.OrthographicCamera(
      (-frustum * aspect) / 2,
      (frustum * aspect) / 2,
      frustum / 2,
      -frustum / 2,
      0.1,
      100,
    );
    camera.position.set(5.5, 4.2, 5.5);
    camera.lookAt(0, 0.8, 0);

    // ---- lights --------------------------------------------------------
    // Hemisphere for ambient fill + a low-angle key from the front-left.
    // Sized to make gold tones pop without washing the brand red.
    const hemi = new THREE.HemisphereLight(0xfff2d0, 0x2a1a14, 0.9);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffe4a8, 1.1);
    key.position.set(6, 8, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xff5a4a, 0.45); // ox-bright rim
    rim.position.set(-6, 2, -4);
    scene.add(rim);

    // ---- materials (flat-shaded, low-poly look) ------------------------
    const matStone = new THREE.MeshLambertMaterial({
      color: 0xc9a36b, // weathered gold-bronze
      flatShading: true,
    });
    const matStoneDark = new THREE.MeshLambertMaterial({
      color: 0x8a6b3e, // mortar shade for arch interiors / base
      flatShading: true,
    });
    const matGold = new THREE.MeshLambertMaterial({
      color: 0xd4af37, // brand gold
      flatShading: true,
    });
    const matOx = new THREE.MeshLambertMaterial({
      color: 0xcc4444, // ox-bright accent for the flag
      flatShading: true,
    });

    // ---- build mesh ----------------------------------------------------
    // The mesh is split into TWO groups: `root` (the coliseum itself
    // — rotates) and `env` (the surrounding ground / stones / glow
    // — stays still so it reads as a real environment, not a piece
    // spinning in space). Dust particles live in their own group too,
    // animated separately by the tick loop below.
    root.position.y = 0;
    const env = new THREE.Group();
    scene.add(env);

    // ---- BACKDROP GLOW (sits behind everything else) -------------------
    // A large semi-transparent disc oriented to face the camera, with
    // a radial gradient texture baked in via vertex colors. Gives the
    // coliseum atmospheric depth instead of floating in pure black.
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = 256;
    glowCanvas.height = 256;
    const gctx = glowCanvas.getContext("2d");
    if (gctx) {
      const grad = gctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      grad.addColorStop(0.0, "rgba(212, 175, 55, 0.55)"); // gold core
      grad.addColorStop(0.35, "rgba(204, 68, 68, 0.22)"); // ox-red mid
      grad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
      gctx.fillStyle = grad;
      gctx.fillRect(0, 0, 256, 256);
    }
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({
        map: glowTex,
        transparent: true,
        depthWrite: false,
      }),
    );
    glow.position.set(-2.4, 2.5, -2.4);
    glow.lookAt(camera.position);
    env.add(glow);

    // ---- GROUND PLANE --------------------------------------------------
    // Octagonal stone disc much wider than the coliseum base. Sits
    // just below the coliseum's plinth and extends out to the edge
    // of the canvas. Dark mortar color so the coliseum's gold tones
    // pop against it.
    const ground = new THREE.Mesh(
      new THREE.CylinderGeometry(5.2, 5.2, 0.18, 8),
      new THREE.MeshLambertMaterial({
        color: 0x4a382a, // weathered stone, darker than coliseum base
        flatShading: true,
      }),
    );
    ground.position.y = -0.65;
    env.add(ground);

    // Top layer of the ground — slightly lighter ring around the
    // coliseum to suggest worn-in foot traffic + a defined arena
    // perimeter.
    const groundTop = new THREE.Mesh(
      new THREE.CylinderGeometry(5.0, 5.0, 0.06, 8),
      new THREE.MeshLambertMaterial({
        color: 0x5d4a36,
        flatShading: true,
      }),
    );
    groundTop.position.y = -0.52;
    env.add(groundTop);

    // Cross-pattern tile grooves — 4 thin slabs in a + pattern over
    // the ground top. Subtle but adds the "this is a real plaza"
    // texture without a full texture map.
    for (let i = 0; i < 4; i++) {
      const groove = new THREE.Mesh(
        new THREE.BoxGeometry(9.0, 0.02, 0.05),
        new THREE.MeshLambertMaterial({
          color: 0x342518,
          flatShading: true,
        }),
      );
      groove.rotation.y = (i / 4) * Math.PI * 2;
      groove.position.y = -0.485;
      env.add(groove);
    }

    // ---- SCATTERED FALLEN STONES + COLUMN STUMPS -----------------------
    // 8 small "ruin" pieces scattered around the coliseum's perimeter
    // at varying angles, sizes, and rotations. Sells the "ancient
    // arena standing in a ruined plaza" feel.
    const ruinSpec: Array<{ a: number; r: number; w: number; h: number; d: number; ry: number; tone: number }> = [
      { a: 0.4, r: 3.6, w: 0.5, h: 0.7, d: 0.5, ry: 0.3, tone: 0 },
      { a: 1.0, r: 3.2, w: 0.4, h: 0.35, d: 0.6, ry: -0.6, tone: 1 },
      { a: 1.7, r: 4.0, w: 0.65, h: 0.55, d: 0.3, ry: 0.9, tone: 0 },
      { a: 2.3, r: 3.4, w: 0.35, h: 0.85, d: 0.35, ry: 0.1, tone: 1 },
      { a: 3.0, r: 4.1, w: 0.55, h: 0.45, d: 0.55, ry: -0.4, tone: 0 },
      { a: 3.8, r: 3.5, w: 0.4, h: 0.65, d: 0.4, ry: 0.7, tone: 1 },
      { a: 4.5, r: 4.2, w: 0.7, h: 0.4, d: 0.45, ry: -0.2, tone: 0 },
      { a: 5.4, r: 3.3, w: 0.35, h: 0.5, d: 0.35, ry: 1.1, tone: 1 },
    ];
    const ruinMatA = new THREE.MeshLambertMaterial({
      color: 0x9a7a4a,
      flatShading: true,
    });
    const ruinMatB = new THREE.MeshLambertMaterial({
      color: 0x6c5436,
      flatShading: true,
    });
    for (const r of ruinSpec) {
      const stone = new THREE.Mesh(
        new THREE.BoxGeometry(r.w, r.h, r.d),
        r.tone === 0 ? ruinMatA : ruinMatB,
      );
      stone.position.set(
        Math.cos(r.a) * r.r,
        -0.49 + r.h / 2,
        Math.sin(r.a) * r.r,
      );
      stone.rotation.y = r.ry;
      env.add(stone);
    }

    // A couple of taller broken column stumps — same family as the
    // coliseum pillars but cracked off mid-height. Adds vertical
    // interest to the empty space around the arena.
    const stumpSpecs: Array<{ a: number; r: number; h: number }> = [
      { a: 0.9, r: 3.8, h: 1.2 },
      { a: 2.7, r: 3.9, h: 0.9 },
      { a: 4.9, r: 3.7, h: 1.4 },
    ];
    for (const s of stumpSpecs) {
      const stump = new THREE.Mesh(
        new THREE.BoxGeometry(0.32, s.h, 0.32),
        ruinMatA,
      );
      stump.position.set(
        Math.cos(s.a) * s.r,
        -0.49 + s.h / 2,
        Math.sin(s.a) * s.r,
      );
      env.add(stump);
      // A small cracked capstone on top of each stump.
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.08, 0.42),
        ruinMatB,
      );
      cap.position.set(
        Math.cos(s.a) * s.r,
        -0.49 + s.h + 0.04,
        Math.sin(s.a) * s.r,
      );
      env.add(cap);
    }

    // ---- DUST PARTICLES ------------------------------------------------
    // A small swarm of slowly drifting cubes around the coliseum.
    // Stored in a flat array so the tick loop can iterate without
    // allocating. Each particle has its own phase + speed for a
    // natural-looking ambient drift.
    const DUST_COUNT = 36;
    const dustGeom = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    const dustMat = new THREE.MeshBasicMaterial({
      color: 0xffd28a,
      transparent: true,
      opacity: 0.55,
    });
    type Mote = {
      mesh: THREE.Mesh;
      baseY: number;
      amp: number;
      speed: number;
      phase: number;
      angle: number;
      radius: number;
      angularSpeed: number;
    };
    const dust: Mote[] = [];
    for (let i = 0; i < DUST_COUNT; i++) {
      const m = new THREE.Mesh(dustGeom, dustMat);
      const angle = Math.random() * Math.PI * 2;
      const radius = 2.5 + Math.random() * 2.6;
      const baseY = -0.3 + Math.random() * 3.0;
      m.position.set(Math.cos(angle) * radius, baseY, Math.sin(angle) * radius);
      env.add(m);
      dust.push({
        mesh: m,
        baseY,
        amp: 0.25 + Math.random() * 0.45,
        speed: 0.18 + Math.random() * 0.35,
        phase: Math.random() * Math.PI * 2,
        angle,
        radius,
        angularSpeed: 0.04 + Math.random() * 0.06,
      });
    }

    // Octagonal base plinth (large outer ring of stone + inner arena floor).
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(2.4, 2.55, 0.22, 8),
      matStoneDark,
    );
    base.position.y = -0.11;
    root.add(base);

    const baseTop = new THREE.Mesh(
      new THREE.CylinderGeometry(2.3, 2.3, 0.08, 8),
      matStone,
    );
    baseTop.position.y = 0.04;
    root.add(baseTop);

    // Arena floor — slightly recessed gold disc at top of base.
    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 1.7, 0.04, 8),
      matGold,
    );
    floor.position.y = 0.08;
    root.add(floor);

    // 3 stacked tiers of arches. Each tier = N pillars in a ring + a
    // cornice ring on top. Tiers narrow + shorten going up so the
    // silhouette reads as a Coliseum, not a cylinder.
    type Tier = {
      radius: number;
      pillarH: number;
      pillarW: number;
      pillarT: number; // thickness (radial)
      y: number;
      count: number;
      cornice: number;
    };
    const tiers: Tier[] = [
      { radius: 2.1, pillarH: 1.0, pillarW: 0.30, pillarT: 0.32, y: 0.55, count: 16, cornice: 0.12 },
      { radius: 1.95, pillarH: 0.85, pillarW: 0.26, pillarT: 0.28, y: 1.55, count: 14, cornice: 0.10 },
      { radius: 1.8, pillarH: 0.70, pillarW: 0.22, pillarT: 0.24, y: 2.40, count: 12, cornice: 0.08 },
    ];

    for (const t of tiers) {
      // Pillars
      const pillarGeom = new THREE.BoxGeometry(t.pillarW, t.pillarH, t.pillarT);
      for (let i = 0; i < t.count; i++) {
        const angle = (i / t.count) * Math.PI * 2;
        const pillar = new THREE.Mesh(pillarGeom, matStone);
        pillar.position.set(
          Math.cos(angle) * t.radius,
          t.y + 0.04, // small lift so cornice line reads clean
          Math.sin(angle) * t.radius,
        );
        pillar.rotation.y = -angle;
        root.add(pillar);
      }
      // Cornice ring on top of this tier — 8-sided so it stays
      // pixelated, not smooth.
      const corniceGeom = new THREE.CylinderGeometry(
        t.radius + 0.12,
        t.radius + 0.05,
        t.cornice,
        8,
      );
      const cornice = new THREE.Mesh(corniceGeom, matGold);
      cornice.position.y = t.y + t.pillarH / 2 + t.cornice / 2;
      root.add(cornice);
      // Lintel band (slightly darker stripe under cornice for that
      // classical horizontal banding).
      const lintelGeom = new THREE.CylinderGeometry(
        t.radius + 0.04,
        t.radius + 0.04,
        0.06,
        8,
      );
      const lintel = new THREE.Mesh(lintelGeom, matStoneDark);
      lintel.position.y = t.y + t.pillarH / 2 - 0.03;
      root.add(lintel);
    }

    // Crowning ring — a smaller solid disc on top so the silhouette
    // has a clean cap instead of trailing off mid-air.
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(1.55, 1.55, 0.18, 8),
      matStoneDark,
    );
    cap.position.y =
      tiers[tiers.length - 1].y +
      tiers[tiers.length - 1].pillarH / 2 +
      tiers[tiers.length - 1].cornice +
      0.09;
    root.add(cap);

    // Brand flag — a small gold pole + oxblood pennant on top of the
    // cap. Sells the "this is a coliseum, not a stadium" read in a
    // single brand-accent hit.
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6),
      matGold,
    );
    pole.position.y = cap.position.y + 0.35;
    root.add(pole);
    const pennant = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.18, 0.02),
      matOx,
    );
    pennant.position.set(0.18, cap.position.y + 0.45, 0);
    root.add(pennant);

    // Slight downward shift so the piece sits centered vertically in
    // its container instead of floating in the upper half. The
    // ground plane was already placed below at y=-0.65 to meet this.
    root.position.y = -0.4;

    // ---- renderer ------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({
      antialias: false, // sharp pixel edges
      alpha: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0); // transparent
    mount.appendChild(renderer.domElement);

    // ---- resize --------------------------------------------------------
    function resize() {
      if (!mount) return;
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      const a = w / h;
      camera.left = (-frustum * a) / 2;
      camera.right = (frustum * a) / 2;
      camera.top = frustum / 2;
      camera.bottom = -frustum / 2;
      camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // ---- animation loop ------------------------------------------------
    const startedAt = performance.now();
    let frameId = 0;
    let visible = !document.hidden;
    function tick(now: number) {
      const t = (now - startedAt) / 1000;
      if (rotationPeriodSec && rotationPeriodSec > 0) {
        root.rotation.y = (t * (Math.PI * 2)) / rotationPeriodSec;
      }
      // Subtle vertical bob (~10px) so a paused/reduced-motion view
      // still feels alive without being distracting. Only the
      // coliseum bobs — the ground + ruins + dust stay anchored.
      root.position.y = -0.4 + Math.sin(t * 0.6) * 0.04;

      // Drift dust particles: each mote orbits slowly around the
      // arena while bobbing vertically. Wrapping the angle keeps
      // them perpetual without growing unbounded.
      for (const m of dust) {
        m.angle += m.angularSpeed * 0.012; // ~slow rotation per frame
        m.mesh.position.x = Math.cos(m.angle) * m.radius;
        m.mesh.position.z = Math.sin(m.angle) * m.radius;
        m.mesh.position.y = m.baseY + Math.sin(t * m.speed + m.phase) * m.amp;
      }

      renderer.render(scene, camera);
      if (visible) frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);

    // Pause when tab hides; resume when it returns. Avoids cooking the
    // GPU when the spectator switched away from this tab.
    function onVisibility() {
      visible = !document.hidden;
      if (visible) {
        frameId = requestAnimationFrame(tick);
      } else {
        cancelAnimationFrame(frameId);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    // ---- cleanup -------------------------------------------------------
    return () => {
      cancelAnimationFrame(frameId);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
      // Dispose geometries / materials so they don't leak across
      // re-mounts (the only re-mount path is a route change, but
      // be tidy).
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
    };
  }, [rotationPeriodSec]);

  return (
    <div
      ref={mountRef}
      className={className}
      aria-hidden="true"
      style={{
        width: "100%",
        height: "100%",
        // The canvas WebGL context will set its own pixel dimensions
        // via setSize(); CSS box just defines the layout slot.
      }}
    />
  );
}
