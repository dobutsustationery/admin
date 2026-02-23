<script lang="ts">
  import { onMount } from "svelte";

  export let active = true;
  export let celebrate = false;
  export let phase: "idle" | "expanding" | "victory" = "idle";
  export let lockedRenderWidthPx: number | null = null;

  let containerEl: HTMLDivElement;
  let syncRendererSize: (() => void) | null = null;

  $: if (syncRendererSize) {
    syncRendererSize();
  }

  onMount(() => {
    if (!containerEl || !active) return;

    let destroyed = false;
    let frame = 0;
    let renderer: any = null;
    let scene: any = null;
    let camera: any = null;
    let hedgehogGroup: any = null;
    let clock: any = null;
    let resizeObserver: ResizeObserver | null = null;
    let windowResizeHandler: (() => void) | null = null;
    let lastPhase: "idle" | "expanding" | "victory" = "idle";
    let victoryStartedAt = 0;
    let victoryStartPose = { x: 0, y: 1.25, z: 0, angle: 0 };
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const start = async () => {
      const THREE = await import("three");
      if (destroyed || !containerEl) return;

      scene = new THREE.Scene();
      scene.background = null;
      scene.fog = new THREE.Fog(0xfef3c7, 10, 42);

      camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      camera.position.set(0, 2.35, 11.2);
      camera.lookAt(0, 1.75, 0);

      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.outputColorSpace = (THREE as any).SRGBColorSpace;
      containerEl.appendChild(renderer.domElement);

      clock = new THREE.Clock();

      const ambient = new THREE.AmbientLight(0xffffff, 0.95);
      scene.add(ambient);

      const hemi = new THREE.HemisphereLight(0xfffbeb, 0x8b5a2b, 0.55);
      scene.add(hemi);

      const dir = new THREE.DirectionalLight(0xffffff, 0.65);
      dir.position.set(10, 15, 8);
      scene.add(dir);

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(42, 18),
        new THREE.MeshPhongMaterial({
          color: 0x9dd84f,
          shininess: 0,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.45;
      scene.add(floor);

      const track = new THREE.Mesh(
        new THREE.RingGeometry(3.8, 5.2, 64),
        new THREE.MeshBasicMaterial({
          color: 0xeab308,
          transparent: true,
          opacity: 0.24,
          side: THREE.DoubleSide,
        }),
      );
      track.rotation.x = -Math.PI / 2;
      track.position.y = -0.41;
      track.scale.set(1.55, 0.58, 1);
      scene.add(track);

      hedgehogGroup = new THREE.Group();
      scene.add(hedgehogGroup);

      const applyPuff = (
        geometry: any,
        width: number,
        height: number,
        strength: number,
      ) => {
        const pos = geometry.attributes.position;
        const w2 = width / 2;
        const h2 = height / 2;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const nx = x / w2;
          const ny = y / h2;
          const dist = Math.sqrt(nx * nx + ny * ny);
          const factor = Math.max(
            0,
            Math.pow(Math.cos(Math.min(1, dist) * Math.PI * 0.5), 0.9),
          );
          pos.setZ(i, factor * strength);
        }
        pos.needsUpdate = true;
        geometry.computeVertexNormals();
      };

      const texture = await new THREE.TextureLoader().loadAsync(
        "/hedgehogs/HedgehogV6ColourTransparentBG.png",
      );
      if (destroyed || !hedgehogGroup) return;
      texture.colorSpace = (THREE as any).SRGBColorSpace;

      const width = 5.15;
      const height = (159 / 200) * width;
      const segments = 36;

      const frontGeo = new THREE.PlaneGeometry(
        width,
        height,
        segments,
        segments,
      );
      applyPuff(frontGeo, width, height, 0.4);
      const frontMat = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.08,
        side: THREE.FrontSide,
      });
      const frontMesh = new THREE.Mesh(frontGeo, frontMat);
      frontMesh.position.z = 0.02;

      const backTexture = texture.clone();
      backTexture.needsUpdate = true;
      backTexture.wrapS = THREE.RepeatWrapping;
      backTexture.repeat.x = -1;
      backTexture.offset.x = 1;
      const backGeo = new THREE.PlaneGeometry(
        width,
        height,
        segments,
        segments,
      );
      applyPuff(backGeo, width, height, 0.4);
      const backMat = new THREE.MeshBasicMaterial({
        map: backTexture,
        transparent: true,
        alphaTest: 0.08,
        side: THREE.FrontSide,
      });
      const backMesh = new THREE.Mesh(backGeo, backMat);
      backMesh.rotation.y = Math.PI;
      backMesh.position.z = -0.02;

      hedgehogGroup.add(frontMesh);
      hedgehogGroup.add(backMesh);

      const updateSize = () => {
        if (!renderer || !camera || !containerEl) return;
        const targetWidth =
          lockedRenderWidthPx || containerEl.clientWidth || 84;
        const widthPx = Math.max(48, Math.floor(targetWidth));
        const visibleWidthPx = Math.max(
          48,
          Math.floor(containerEl.clientWidth || 84),
        );
        const heightPx = Math.max(
          40,
          Math.floor(containerEl.clientHeight || 82),
        );
        renderer.setSize(widthPx, heightPx, false);
        if (renderer.domElement) {
          renderer.domElement.style.width = `${widthPx}px`;
          renderer.domElement.style.height = `${heightPx}px`;
          const offsetX = lockedRenderWidthPx
            ? Math.floor((visibleWidthPx - widthPx) / 2)
            : 0;
          renderer.domElement.style.transform = `translateX(${offsetX}px)`;
          renderer.domElement.style.transformOrigin = "left top";
        }
        camera.aspect = widthPx / heightPx;
        camera.updateProjectionMatrix();
      };
      syncRendererSize = updateSize;

      updateSize();
      resizeObserver = new ResizeObserver(updateSize);
      resizeObserver.observe(containerEl);
      windowResizeHandler = () => updateSize();
      window.addEventListener("resize", windowResizeHandler);

      const ellipseX = 5.4;
      const ellipseZ = 1.45;

      const renderLoop = () => {
        if (destroyed || !renderer || !scene || !camera || !hedgehogGroup)
          return;

        const baseSpeed = celebrate ? 0.2 : 0.95;
        const t = prefersReduced ? 0.8 : clock.getElapsedTime() * baseSpeed;
        const orbitX = Math.cos(t) * ellipseX;
        const orbitZ = Math.sin(t) * ellipseZ;
        const dx = -Math.sin(t) * ellipseX;
        const dz = Math.cos(t) * ellipseZ;
        const orbitAngle = Math.atan2(dz, dx) + Math.PI;
        const orbitY =
          1.75 + (prefersReduced ? 0 : Math.abs(Math.sin(t * 8)) * 0.22);

        if (phase !== lastPhase) {
          if (phase === "victory") {
            victoryStartedAt = performance.now();
            const safeVictoryX = Math.max(-1.8, Math.min(1.8, orbitX * 0.35));
            const safeVictoryZ = Math.max(-0.3, Math.min(0.3, orbitZ * 0.25));
            const faceSideAngle = orbitX >= 0 ? Math.PI : 0;
            victoryStartPose = {
              x: safeVictoryX,
              y: Math.max(1.45, orbitY),
              z: safeVictoryZ,
              angle: faceSideAngle,
            };
          }
          lastPhase = phase;
        }

        if (phase === "victory" && victoryStartedAt > 0) {
          const elapsed = Math.min(
            1,
            (performance.now() - victoryStartedAt) / 7000,
          );
          const bounce = prefersReduced
            ? 0
            : Math.abs(Math.sin(elapsed * Math.PI * 8)) * 0.55;
          hedgehogGroup.position.set(
            victoryStartPose.x,
            Math.max(0.9, victoryStartPose.y + bounce),
            victoryStartPose.z,
          );
          hedgehogGroup.rotation.y = victoryStartPose.angle;
          hedgehogGroup.rotation.z = prefersReduced
            ? 0
            : Math.sin(elapsed * 28) * 0.05;
        } else {
          hedgehogGroup.position.set(orbitX, orbitY, orbitZ);
          hedgehogGroup.rotation.y = orbitAngle;
          hedgehogGroup.rotation.z = prefersReduced
            ? 0
            : Math.sin(t * 8) * 0.045;
        }

        if (!prefersReduced) {
          camera.position.x = Math.sin(t * 0.12) * 0.8;
          camera.position.y = 2.55;
          camera.lookAt(0, 1.7, 0);
        }

        renderer.render(scene, camera);
        frame = requestAnimationFrame(renderLoop);
      };

      renderLoop();
    };

    start().catch((error) => {
      console.error(
        "[SyncQueueStatus] Failed to initialize hedgehog patrol",
        error,
      );
    });

    return () => {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      if (resizeObserver) resizeObserver.disconnect();
      if (windowResizeHandler) {
        window.removeEventListener("resize", windowResizeHandler);
      }
      if (renderer) {
        try {
          renderer.dispose?.();
          renderer.forceContextLoss?.();
        } catch {}
      }
      if (containerEl) {
        containerEl.innerHTML = "";
      }
      syncRendererSize = null;
    };
  });
</script>

<div class="patrol-lane" aria-hidden="true">
  <div class="canvas-wrap" bind:this={containerEl}></div>
</div>

<style>
  .patrol-lane {
    position: relative;
    min-height: 92px;
    border-radius: 18px;
    overflow: hidden;
    border: 1px solid #f1d296;
    background:
      radial-gradient(
        circle at 25% 10%,
        rgba(255, 255, 255, 0.8),
        transparent 50%
      ),
      linear-gradient(180deg, #fef3c7 0%, #fde68a 58%, #fcd34d 100%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
  }

  .canvas-wrap {
    width: 100%;
    height: 100%;
    min-height: 92px;
    overflow: hidden;
  }

  .canvas-wrap :global(canvas) {
    display: block;
    max-width: none;
  }

  @media (max-width: 768px) {
    .patrol-lane,
    .canvas-wrap {
      min-height: 70px;
    }
  }
</style>
