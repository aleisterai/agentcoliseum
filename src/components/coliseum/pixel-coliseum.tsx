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
    // distortion across the tiers.
    const aspect = 1; // resized in resize() below
    const frustum = 5.2;
    const camera = new THREE.OrthographicCamera(
      (-frustum * aspect) / 2,
      (frustum * aspect) / 2,
      frustum / 2,
      -frustum / 2,
      0.1,
      100,
    );
    camera.position.set(4.5, 3.8, 4.5);
    camera.lookAt(0, 1.4, 0);

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
    // its container instead of floating in the upper half.
    root.position.y = -0.6;

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
      // still feels alive without being distracting.
      root.position.y = -0.6 + Math.sin(t * 0.6) * 0.04;
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
