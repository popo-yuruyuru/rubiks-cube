import * as THREE from "three";

/** Sticker colors keyed by the cube face they start on. */
const COLORS = {
  right: 0xff3b30, // +x  red
  left: 0xff9500, // -x  orange
  top: 0xf5f5f5, // +y  white
  bottom: 0xffd60a, // -y  yellow
  front: 0x34c759, // +z  green
  back: 0x0a84ff, // -z  blue
};

/** Soft glow color per rotation axis — gives the spinning layer an "axis color". */
const AXIS_GLOW = [0xff6b6b, 0x6bff95, 0x6bb3ff]; // x, y, z

const SPACING = 1.0; // grid step between cubie centers
const BODY = 0.96; // black plastic body size
const STICKER = 0.84; // colored sticker size
const SURFACE = 0.501; // sticker offset from cube center along its axis
const HALF_PI = Math.PI / 2;

// EaseOutBack — overshoots slightly then settles, giving turns a satisfying snap.
const C1 = 1.70158;
const C3 = C1 + 1;
const easeOutBack = (t: number) =>
  1 + C3 * Math.pow(t - 1, 3) + C1 * Math.pow(t - 1, 2);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** How a turn was initiated — drives history bookkeeping on the main side. */
export type TurnKind = "user" | "shuffle" | "undo" | "redo" | "other";

export interface TurnRequest {
  axis: THREE.Vector3; // unit local axis (±x/±y/±z)
  layer: number; // grid coord of the layer along |axis|: -1, 0, 1
  turns: number; // signed quarter turns (usually ±1)
  kind?: TurnKind;
  duration?: number;
}

export interface TurnAction {
  axis: THREE.Vector3;
  layer: number;
  turns: number; // signed quarter turns actually applied (0 if a manual drag was cancelled)
  kind: TurnKind;
}

interface ActiveTurn {
  axis: THREE.Vector3;
  cubies: THREE.Object3D[];
  fromAngle: number;
  toAngle: number;
  start: number;
  duration: number;
  ease: (t: number) => number;
  meta: TurnAction;
}

interface ManualTurn {
  axis: THREE.Vector3;
  layer: number;
  cubies: THREE.Object3D[];
  angle: number;
}

export class RubiksCube {
  /** Orientation group — whole-cube rotation lives here. */
  readonly group = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly cubies: THREE.Object3D[] = [];
  private readonly stickers: THREE.Mesh[] = [];

  private active: ActiveTurn | null = null;
  private manual: ManualTurn | null = null;
  private queue: TurnRequest[] = [];
  private hints = new THREE.Group();

  /** Fired when a turn settles. Carries the exact action so the UI can manage history. */
  onTurnComplete: ((action: TurnAction) => void) | null = null;

  constructor() {
    this.group.add(this.pivot);
    this.group.add(this.hints);
    this.build();
  }

  // ---- construction ---------------------------------------------------------

  private build() {
    const bodyGeo = new THREE.BoxGeometry(BODY, BODY, BODY);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x101216,
      roughness: 0.65,
      metalness: 0.1,
    });
    const stickerGeo = new THREE.PlaneGeometry(STICKER, STICKER);

    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const cubie = new THREE.Group();
          cubie.position.set(x * SPACING, y * SPACING, z * SPACING);
          cubie.add(new THREE.Mesh(bodyGeo, bodyMat));
          this.addStickers(cubie, stickerGeo, x, y, z);
          cubie.userData.home = {
            position: cubie.position.clone(),
            quaternion: cubie.quaternion.clone(),
          };
          this.cubies.push(cubie);
          this.group.add(cubie);
        }
      }
    }
  }

  private addStickers(
    cubie: THREE.Object3D,
    geo: THREE.PlaneGeometry,
    x: number,
    y: number,
    z: number,
  ) {
    const faces: Array<{ on: boolean; color: number; axis: THREE.Vector3 }> = [
      { on: x === 1, color: COLORS.right, axis: new THREE.Vector3(1, 0, 0) },
      { on: x === -1, color: COLORS.left, axis: new THREE.Vector3(-1, 0, 0) },
      { on: y === 1, color: COLORS.top, axis: new THREE.Vector3(0, 1, 0) },
      { on: y === -1, color: COLORS.bottom, axis: new THREE.Vector3(0, -1, 0) },
      { on: z === 1, color: COLORS.front, axis: new THREE.Vector3(0, 0, 1) },
      { on: z === -1, color: COLORS.back, axis: new THREE.Vector3(0, 0, -1) },
    ];

    for (const f of faces) {
      if (!f.on) continue;
      const mat = new THREE.MeshStandardMaterial({
        color: f.color,
        roughness: 0.45,
        metalness: 0.0,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0,
      });
      const sticker = new THREE.Mesh(geo, mat);
      sticker.position.copy(f.axis).multiplyScalar(SURFACE);
      sticker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.axis);
      sticker.userData.baseColor = f.color;
      sticker.userData.axis = f.axis.clone();
      cubie.add(sticker);
      this.stickers.push(sticker);
    }
  }

  // ---- queries --------------------------------------------------------------

  get cubieMeshes(): THREE.Object3D[] {
    return this.cubies;
  }

  isBusy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  isManualActive(): boolean {
    return this.manual !== null;
  }

  isSolved(): boolean {
    const buckets = new Map<string, number>();
    for (const sticker of this.stickers) {
      const cubie = sticker.parent!;
      const normal = (sticker.userData.axis as THREE.Vector3)
        .clone()
        .applyQuaternion(cubie.quaternion);
      const key = axisKey(normal);
      const color = sticker.userData.baseColor as number;
      const seen = buckets.get(key);
      if (seen === undefined) buckets.set(key, color);
      else if (seen !== color) return false;
    }
    return true;
  }

  // ---- touch feedback (before a swipe commits) ------------------------------

  /** Glow the touched face and show arrows for the two swipe directions. */
  highlightTouch(touched: THREE.Object3D, normal: THREE.Vector3) {
    this.clearHighlight();
    const target = axisKey(normal);
    for (const sticker of this.stickers) {
      const cubie = sticker.parent!;
      const n = (sticker.userData.axis as THREE.Vector3)
        .clone()
        .applyQuaternion(cubie.quaternion);
      if (axisKey(n) === target) this.setStickerGlow(sticker, 0x9ec2ff, 0.22);
    }
    this.showHints(touched, normal);
  }

  private showHints(touched: THREE.Object3D, normal: THREE.Vector3) {
    this.clearHints();
    const nAxis = dominantAxis(normal);
    const base = touched.position.clone().addScaledVector(normal, 0.55);
    for (let i = 0; i < 3; i++) {
      if (i === nAxis) continue;
      for (const sign of [1, -1]) {
        const dir = new THREE.Vector3();
        dir.setComponent(i, sign);
        const arrow = new THREE.ArrowHelper(dir, base, 0.95, AXIS_GLOW[i], 0.34, 0.24);
        (arrow.line.material as THREE.LineBasicMaterial).transparent = true;
        (arrow.line.material as THREE.LineBasicMaterial).opacity = 0.85;
        this.hints.add(arrow);
      }
    }
  }

  clearTouch() {
    this.clearHighlight();
    this.clearHints();
  }

  // ---- pre-lock preview (light layer hint that follows the finger) ----------

  /**
   * Subtle highlight + arrow on the candidate layer before the user commits to
   * a turn. Recompute each pointermove so the band follows the finger.
   */
  preview(touched: THREE.Object3D, normal: THREE.Vector3, swipeDir: THREE.Vector3) {
    const axis = new THREE.Vector3().crossVectors(normal, swipeDir);
    snapAxis(axis);
    const i: 0 | 1 | 2 = dominantAxis(axis);
    const layer = Math.round(touched.position.getComponent(i));
    const cubies = this.cubies.filter(
      (c) => Math.round(c.position.getComponent(i)) === layer,
    );
    this.clearHighlight();
    this.clearHints();
    this.highlightLayer(cubies, axis, 0.26);
    this.showSwipeArrow(touched, normal, swipeDir, axis);
  }

  private showSwipeArrow(
    touched: THREE.Object3D,
    normal: THREE.Vector3,
    swipeDir: THREE.Vector3,
    axis: THREE.Vector3,
  ) {
    const base = touched.position.clone().addScaledVector(normal, 0.55);
    const arrow = new THREE.ArrowHelper(swipeDir, base, 1.05, AXIS_GLOW[dominantAxis(axis)], 0.36, 0.26);
    (arrow.line.material as THREE.LineBasicMaterial).transparent = true;
    (arrow.line.material as THREE.LineBasicMaterial).opacity = 0.95;
    this.hints.add(arrow);
  }

  // ---- manual (finger-following) turn ---------------------------------------

  beginManualTurn(axis: THREE.Vector3, layer: number) {
    this.clearHints();
    const a = axis.clone().normalize();
    const cubies = this.attachLayer(a, layer);
    this.highlightLayer(cubies, a, 0.55);
    this.manual = { axis: a, layer, cubies, angle: 0 };
  }

  setManualAngle(angle: number) {
    if (!this.manual) return;
    const clamped = THREE.MathUtils.clamp(angle, -Math.PI, Math.PI);
    this.manual.angle = clamped;
    this.pivot.quaternion.setFromAxisAngle(this.manual.axis, clamped);
  }

  /** Release: snap to the nearest quarter turn (or back to 0 if under 45°). */
  endManualTurn() {
    if (!this.manual) return;
    const m = this.manual;
    this.manual = null;

    const quarters = Math.round(m.angle / HALF_PI);
    const toAngle = quarters * HALF_PI;
    const remaining = Math.abs(toAngle - m.angle);
    const duration = THREE.MathUtils.clamp(140 + (remaining / HALF_PI) * 180, 140, 340);

    this.active = {
      axis: m.axis,
      cubies: m.cubies,
      fromAngle: m.angle,
      toAngle,
      start: performance.now(),
      duration,
      ease: easeOutBack,
      meta: { axis: m.axis.clone(), layer: m.layer, turns: quarters, kind: "user" },
    };
  }

  // ---- queued / programmatic turns ------------------------------------------

  enqueue(req: TurnRequest) {
    this.queue.push(req);
  }

  reset() {
    this.queue = [];
    this.active = null;
    this.manual = null;
    this.pivot.quaternion.identity();
    for (const cubie of this.cubies) {
      const home = cubie.userData.home as {
        position: THREE.Vector3;
        quaternion: THREE.Quaternion;
      };
      this.group.attach(cubie);
      cubie.position.copy(home.position);
      cubie.quaternion.copy(home.quaternion);
      cubie.updateMatrix();
    }
    this.clearTouch();
  }

  update(now: number) {
    if (!this.active && !this.manual && this.queue.length > 0) {
      this.beginQueuedTurn(this.queue.shift()!);
    }
    if (!this.active) return;

    const a = this.active;
    const t = Math.min(1, (now - a.start) / a.duration);
    const angle = a.fromAngle + (a.toAngle - a.fromAngle) * a.ease(t);
    this.pivot.quaternion.setFromAxisAngle(a.axis, angle);

    if (t >= 1) this.finishTurn();
  }

  private beginQueuedTurn(req: TurnRequest) {
    const axis = req.axis.clone().normalize();
    const cubies = this.attachLayer(axis, req.layer);
    this.active = {
      axis,
      cubies,
      fromAngle: 0,
      toAngle: HALF_PI * req.turns,
      start: performance.now(),
      duration: req.duration ?? 220,
      ease: easeInOut,
      meta: {
        axis: axis.clone(),
        layer: req.layer,
        turns: req.turns,
        kind: req.kind ?? "other",
      },
    };
  }

  private finishTurn() {
    const a = this.active!;
    this.pivot.quaternion.setFromAxisAngle(a.axis, a.toAngle);
    this.group.updateMatrixWorld(true);
    for (const c of a.cubies) {
      this.group.attach(c);
      snapToGrid(c);
    }
    this.pivot.quaternion.identity();
    this.clearHighlight();
    this.active = null;
    this.onTurnComplete?.(a.meta);
  }

  // ---- internals ------------------------------------------------------------

  private attachLayer(axis: THREE.Vector3, layer: number): THREE.Object3D[] {
    const i = dominantAxis(axis);
    const cubies = this.cubies.filter(
      (c) => Math.round(c.position.getComponent(i)) === layer,
    );
    this.group.updateMatrixWorld(true);
    this.pivot.quaternion.identity();
    this.pivot.position.set(0, 0, 0);
    for (const c of cubies) this.pivot.attach(c);
    return cubies;
  }

  private highlightLayer(
    cubies: THREE.Object3D[],
    axis: THREE.Vector3,
    intensity: number,
  ) {
    this.clearHighlight();
    const glow = AXIS_GLOW[dominantAxis(axis)];
    for (const cubie of cubies) {
      cubie.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if ((mesh.userData.baseColor as number | undefined) !== undefined) {
          this.setStickerGlow(mesh, glow, intensity);
        }
      });
    }
  }

  private setStickerGlow(sticker: THREE.Mesh, color: number, intensity: number) {
    const mat = sticker.material as THREE.MeshStandardMaterial;
    mat.emissive.setHex(color);
    mat.emissiveIntensity = intensity;
  }

  private clearHighlight() {
    for (const sticker of this.stickers) {
      (sticker.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
    }
  }

  private clearHints() {
    for (const child of [...this.hints.children]) {
      this.hints.remove(child);
      (child as THREE.ArrowHelper).dispose?.();
    }
  }
}

// ---- helpers ----------------------------------------------------------------

function dominantAxis(v: THREE.Vector3): 0 | 1 | 2 {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}

function snapAxis(v: THREE.Vector3) {
  const i = dominantAxis(v);
  const sign = v.getComponent(i) >= 0 ? 1 : -1;
  v.set(0, 0, 0);
  v.setComponent(i, sign);
}

function axisKey(v: THREE.Vector3): string {
  const i = dominantAxis(v);
  const sign = v.getComponent(i) >= 0 ? "+" : "-";
  return `${"xyz"[i]}${sign}`;
}

/** Round position to the grid and re-orthonormalize orientation. */
function snapToGrid(cubie: THREE.Object3D) {
  cubie.position.set(
    Math.round(cubie.position.x / SPACING) * SPACING,
    Math.round(cubie.position.y / SPACING) * SPACING,
    Math.round(cubie.position.z / SPACING) * SPACING,
  );
  const m = new THREE.Matrix4().makeRotationFromQuaternion(cubie.quaternion);
  const e = m.elements;
  for (let col = 0; col < 3; col++) {
    const v = new THREE.Vector3(e[col * 4], e[col * 4 + 1], e[col * 4 + 2]);
    const i = dominantAxis(v);
    const sign = v.getComponent(i) >= 0 ? 1 : -1;
    v.set(0, 0, 0);
    v.setComponent(i, sign);
    e[col * 4] = v.x;
    e[col * 4 + 1] = v.y;
    e[col * 4 + 2] = v.z;
  }
  cubie.quaternion.setFromRotationMatrix(m);
}

export { SPACING };
