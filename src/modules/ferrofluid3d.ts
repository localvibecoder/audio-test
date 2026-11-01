/**
 * MODULE [02B // 3D FERROFLUID ACOUSTIC FIELD] (Three.js)
 *
 * High-density IcosahedronGeometry(1.4, 48) with welded shared vertices so
 * real-time computeVertexNormals() produces authentic liquid-chrome specular flow.
 *
 * Multi-band physical vertex displacement:
 *  · Sub/Kick (20–120 Hz): Core radial expansion/punch + axial shockwave rings
 *  · Mids (120 Hz – 4 kHz): Smooth organic 3D spherical harmonic / trigonometric lobes
 *  · Highs/Air (8–22 kHz): High-frequency normal micro-spikes (visibly collapses
 *    into a smooth surface when the 16kHz Transcode Simulator is engaged)
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TelemetryFrame } from '../audio/engine';
import { clamp, fmtDb } from '../util/format';
import { observeViewport } from '../util/resize';

export class Ferrofluid3DModule {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly coreGroup: THREE.Group;
  private readonly geometry: THREE.BufferGeometry;
  private readonly basePositions: Float32Array;
  private readonly baseDirs: Float32Array;
  private readonly wireMaterial: THREE.MeshBasicMaterial;
  private readonly shockRing: THREE.LineLoop;
  private readonly shockRingMat: THREE.LineBasicMaterial;

  // HUD DOM elements
  private readonly hudSub: HTMLElement;
  private readonly hudSubDb: HTMLElement;
  private readonly hudSubBar: HTMLElement;
  private readonly hudMid: HTMLElement;
  private readonly hudMidDb: HTMLElement;
  private readonly hudMidBar: HTMLElement;
  private readonly hudHf: HTMLElement;
  private readonly hudAirDb: HTMLElement;
  private readonly hudHfBar: HTMLElement;
  private readonly hudVerts: HTMLElement;
  private readonly hudTris: HTMLElement;
  private readonly hudCpu: HTMLElement;

  // Smoothed envelope state + interactive camera orbit
  private smoothSub = 0;
  private smoothMid = 0;
  private smoothHigh = 0;
  private phase = 0;
  private shockPhase = 0;

  private dragging = false;
  private lastPtrX = 0;
  private lastPtrY = 0;
  private rotY = 0.4;
  private rotX = 0.22;
  private targetRotY = 0.4;
  private targetRotX = 0.22;

  constructor(container: HTMLElement) {
    this.hudSub = document.getElementById('hud-sub')!;
    this.hudSubDb = document.getElementById('hud-sub-db')!;
    this.hudSubBar = document.getElementById('hud-sub-bar')!;
    this.hudMid = document.getElementById('hud-mid')!;
    this.hudMidDb = document.getElementById('hud-mid-db')!;
    this.hudMidBar = document.getElementById('hud-mid-bar')!;
    this.hudHf = document.getElementById('hud-hf')!;
    this.hudAirDb = document.getElementById('hud-air-db')!;
    this.hudHfBar = document.getElementById('hud-hf-bar')!;
    this.hudVerts = document.getElementById('hud-verts')!;
    this.hudTris = document.getElementById('hud-tris')!;
    this.hudCpu = document.getElementById('hud-cpu')!;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setClearColor(0x050505, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.insertBefore(this.renderer.domElement, container.firstChild);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    this.camera.position.set(0, 0, 5.2);

    // Studio metallic reflection environment for dark liquid chrome
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTex;
    pmrem.dispose();

    // Key, rim, and signal-orange accent lights
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(3.5, 4.5, 4.0);
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xd8e0e8, 1.4);
    rimLight.position.set(-4.0, -2.5, -3.0);
    this.scene.add(rimLight);

    const orangeRim = new THREE.PointLight(0xff4d00, 1.8, 10);
    orangeRim.position.set(2.6, -2.2, 2.4);
    this.scene.add(orangeRim);

    this.coreGroup = new THREE.Group();
    this.scene.add(this.coreGroup);

    // High-density IcosahedronGeometry(1.4, 48) with welded vertices for smooth normals
    const rawGeo = new THREE.IcosahedronGeometry(1.4, 48);
    rawGeo.deleteAttribute('normal');
    rawGeo.deleteAttribute('uv');
    this.geometry = mergeVertices(rawGeo, 1e-4);
    rawGeo.dispose();
    this.geometry.computeVertexNormals();

    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    posAttr.setUsage(THREE.DynamicDrawUsage);
    this.basePositions = new Float32Array(posAttr.array.length);
    this.basePositions.set(posAttr.array as Float32Array);

    // Cache unit direction vectors per vertex
    this.baseDirs = new Float32Array(posAttr.array.length);
    for (let i = 0; i < posAttr.array.length; i += 3) {
      const x = this.basePositions[i];
      const y = this.basePositions[i + 1];
      const z = this.basePositions[i + 2];
      const inv = 1 / Math.hypot(x, y, z);
      this.baseDirs[i] = x * inv;
      this.baseDirs[i + 1] = y * inv;
      this.baseDirs[i + 2] = z * inv;
    }

    // Sleek industrial dark liquid chrome material
    const chromeMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x161616,
      metalness: 0.92,
      roughness: 0.16,
      clearcoat: 0.8,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.45,
    });

    const coreMesh = new THREE.Mesh(this.geometry, chromeMaterial);
    this.coreGroup.add(coreMesh);

    // Overlaid wireframe cage (#FF4D00, opacity scaled by high-frequency energy)
    this.wireMaterial = new THREE.MeshBasicMaterial({
      color: 0xff4d00,
      wireframe: true,
      transparent: true,
      opacity: 0.06,
      depthTest: true,
    });
    const wireMesh = new THREE.Mesh(this.geometry, this.wireMaterial);
    wireMesh.scale.setScalar(1.002);
    this.coreGroup.add(wireMesh);

    // Technical equatorial calibration reticle + sub shockwave ring
    const ringPts: THREE.Vector3[] = [];
    const segs = 128;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a) * 1.95, 0, Math.sin(a) * 1.95));
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
    this.shockRingMat = new THREE.LineBasicMaterial({
      color: 0xff4d00,
      transparent: true,
      opacity: 0.25,
    });
    this.shockRing = new THREE.LineLoop(ringGeo, this.shockRingMat);
    this.shockRing.rotation.x = Math.PI * 0.16;
    this.coreGroup.add(this.shockRing);

    // Outer static measurement ring (#222222)
    const outerGeo = new THREE.BufferGeometry().setFromPoints(
      ringPts.map((v) => v.clone().multiplyScalar(1.12)),
    );
    const outerRing = new THREE.LineLoop(
      outerGeo,
      new THREE.LineBasicMaterial({ color: 0x222222 }),
    );
    outerRing.rotation.x = -Math.PI * 0.2;
    this.coreGroup.add(outerRing);

    // Populate static vertex/triangle count telemetry
    const vCount = posAttr.count;
    const tCount = this.geometry.index ? this.geometry.index.count / 3 : vCount / 3;
    this.hudVerts.textContent = vCount.toLocaleString('en-US');
    this.hudTris.textContent = Math.round(tCount).toLocaleString('en-US');

    // ResizeObserver integration
    observeViewport(container, ({ width, height, dpr }) => {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
    });

    // Pointer orbit controls
    container.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastPtrX = e.clientX;
      this.lastPtrY = e.clientY;
      container.setPointerCapture(e.pointerId);
    });

    container.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPtrX;
      const dy = e.clientY - this.lastPtrY;
      this.lastPtrX = e.clientX;
      this.lastPtrY = e.clientY;
      this.targetRotY += dx * 0.007;
      this.targetRotX = clamp(this.targetRotX + dy * 0.007, -1.2, 1.2);
    });

    container.addEventListener('pointerup', (e) => {
      if (this.dragging) {
        this.dragging = false;
        container.releasePointerCapture(e.pointerId);
      }
    });

    container.addEventListener('dblclick', () => {
      this.targetRotX = 0.22;
      this.targetRotY = 0.4;
    });
  }

  render(frame: TelemetryFrame): void {
    const t0 = performance.now();

    // Smooth multi-band envelopes with fast attack and musical release
    const attack = 0.35;
    const release = 0.12;
    this.smoothSub += (frame.subEnergy - this.smoothSub) * (frame.subEnergy > this.smoothSub ? attack : release);
    this.smoothMid += (frame.midEnergy - this.smoothMid) * (frame.midEnergy > this.smoothMid ? attack : release);
    this.smoothHigh += (frame.highEnergy - this.smoothHigh) * (frame.highEnergy > this.smoothHigh ? 0.45 : 0.16);

    const sub = this.smoothSub;
    const mid = this.smoothMid;
    const high = this.smoothHigh;

    this.phase += 0.025 + mid * 0.055;
    this.shockPhase += 0.06 + sub * 0.14;

    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = posAttr.array as Float32Array;
    const base = this.basePositions;
    const dirs = this.baseDirs;
    const n = out.length;

    // Band 1: Sub/Kick (20–120 Hz) radial core expansion + axial shockwave
    const subExpand = sub * 0.34;
    const subShockAmp = sub * sub * 0.16;

    // Band 2: Mids (120 Hz – 4 kHz) smooth organic 3D trigonometric wave lobes
    const midAmp = 0.03 + mid * 0.28;

    // Band 3: Highs/Air (8–22 kHz) sharp normal micro-spikes
    // Collapses cleanly when 16kHz Transcode Simulator removes >16kHz energy
    const highAmp = high * 0.24;

    const p1 = this.phase;
    const p2 = this.phase * 1.37;
    const sp = this.shockPhase;

    for (let i = 0; i < n; i += 3) {
      const dx = dirs[i];
      const dy = dirs[i + 1];
      const dz = dirs[i + 2];

      // Sub shockwave travelling from equator to poles
      const shockWave = Math.cos(dy * 7.5 - sp) * subShockAmp;

      // Mid-frequency spherical harmonic lobes
      const lobe1 = Math.sin(dx * 4.0 + p1) * Math.cos(dy * 4.0 - p2) * Math.sin(dz * 4.0 + p1 * 0.7);
      const lobe2 = Math.cos(dx * 6.5 - p2) * Math.sin(dz * 6.5 + p1);
      const midDisp = (lobe1 * 0.7 + lobe2 * 0.3) * midAmp;

      // High-frequency spatial micro-spikes (high angular wavenumber + non-linear sharpening)
      let hfSpike = 0;
      if (highAmp > 0.001) {
        const s =
          Math.sin(dx * 26.0 + p1 * 2.2) *
          Math.sin(dy * 26.0 - p2 * 1.9) *
          Math.sin(dz * 26.0 + p1 * 1.5);
        // Power-sharpened ridges so lossless audio creates crisp ferrofluid spikes
        hfSpike = s * Math.abs(s) * highAmp;
      }

      const scale = 1.0 + subExpand + shockWave + midDisp + hfSpike;
      out[i] = base[i] * scale;
      out[i + 1] = base[i + 1] * scale;
      out[i + 2] = base[i + 2] * scale;
    }

    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();

    // Scale #FF4D00 wireframe cage opacity by high-frequency energy
    this.wireMaterial.opacity = clamp(0.03 + high * 0.42, 0.03, 0.48);

    // Pulse calibration shock ring with sub-bass
    const ringScale = 1.0 + sub * 0.22;
    this.shockRing.scale.setScalar(ringScale);
    this.shockRingMat.opacity = clamp(0.18 + sub * 0.65, 0.18, 0.85);

    // Smooth camera orbit rotation
    if (!this.dragging) {
      this.targetRotY += 0.0035;
    }
    this.rotX += (this.targetRotX - this.rotX) * 0.12;
    this.rotY += (this.targetRotY - this.rotY) * 0.12;
    this.coreGroup.rotation.x = this.rotX;
    this.coreGroup.rotation.y = this.rotY;

    this.renderer.render(this.scene, this.camera);
    const dtMs = performance.now() - t0;

    // Update 4-corner HUD telemetry overlays
    this.hudSub.textContent = `+${(subExpand + subShockAmp).toFixed(3)}`;
    this.hudSubDb.textContent = fmtDb(frame.subDb, 1, -110);
    this.hudSubBar.style.width = `${Math.round(sub * 100)}%`;

    this.hudMid.textContent = midAmp.toFixed(3);
    this.hudMidDb.textContent = fmtDb(frame.midDb, 1, -110);
    this.hudMidBar.style.width = `${Math.round(mid * 100)}%`;

    this.hudHf.textContent = highAmp.toFixed(3);
    this.hudAirDb.textContent = fmtDb(frame.highDb, 1, -110);
    this.hudHfBar.style.width = `${Math.round(high * 100)}%`;

    this.hudCpu.textContent = dtMs.toFixed(2);
  }
}
