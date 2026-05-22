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

const SPACING = 1.0; // grid step between cubie centers
const BODY = 0.96; // black plastic body size
const STICKER = 0.84; // colored sticker size
const SURFACE = 0.501; // sticker offset from cube center along its axis

const EASE = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export interface TurnRequest {
  axis: THREE.Vector3; // unit local axis (±x/±y/±z)
  layer: number; // grid coord of the layer along |axis|: -1, 0, 1
  turns: number; // signed quarter turns (usually ±1)
  record: boolean; // counts toward the move counter
  duration?: number;
}

interface ActiveTurn extends Required<TurnRequest> {
  start: number;
  fromAngle: number;
  toAngle: number;
  cubies: THREE.Object3D[];
}

export class RubiksCube {
  /** Orientation group — whole-cube rotation lives here. */
  readonly group = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly cubies: THREE.Object3D[] = [];
  private readonly stickers: THREE.Mesh[] = [];

  private active: ActiveTurn | null = null;
  private queue: TurnRequest[] = [];

  /** Fired when a turn finishes; `recorded` tells the UI whether to count it. */
  onTurnComplete: ((recorded: boolean) => void) | null = null;

  constructor() {
    this.group.add(this.pivot);
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

          const body = new THREE.Mesh(bodyGeo, bodyMat);
          cubie.add(body);

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
        emissive: new THREE.Color(f.color),
        emissiveIntensity: 0,
      });
      const sticker = new THREE.Mesh(geo, mat);
      sticker.position.copy(f.axis).multiplyScalar(SURFACE);
      // orient plane (default +z normal) to point along the face axis
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

  /** True when every face shows a single color (orientation-independent). */
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

  // ---- turn control ---------------------------------------------------------

  enqueue(req: TurnRequest) {
    this.queue.push(req);
  }

  reset() {
    this.queue = [];
    this.active = null;
    this.pivot.rotation.set(0, 0, 0);
    for (const cubie of this.cubies) {
      const home = cubie.userData.home as {
        position: THREE.Vector3;
        quaternion: THREE.Quaternion;
      };
      this.group.attach(cubie); // ensure detached from pivot
      cubie.position.copy(home.position);
      cubie.quaternion.copy(home.quaternion);
      cubie.updateMatrix();
    }
    this.setLayerHighlight([], 0);
  }

  update(now: number) {
    if (!this.active && this.queue.length > 0) this.beginTurn(this.queue.shift()!);
    if (!this.active) return;

    const a = this.active;
    const t = Math.min(1, (now - a.start) / a.duration);
    const angle = a.fromAngle + (a.toAngle - a.fromAngle) * EASE(t);
    this.pivot.quaternion.setFromAxisAngle(a.axis, angle);

    if (t >= 1) this.finishTurn();
  }

  private beginTurn(req: TurnRequest) {
    const axisIndex = dominantAxis(req.axis);
    const cubies = this.cubies.filter(
      (c) => Math.round(c.position.getComponent(axisIndex)) === req.layer,
    );

    this.group.updateMatrixWorld(true);
    this.pivot.quaternion.identity();
    this.pivot.position.set(0, 0, 0);
    for (const c of cubies) this.pivot.attach(c);

    this.setLayerHighlight(cubies, 0.4);

    this.active = {
      axis: req.axis.clone().normalize(),
      layer: req.layer,
      turns: req.turns,
      record: req.record,
      duration: req.duration ?? 180,
      start: performance.now(),
      fromAngle: 0,
      toAngle: (Math.PI / 2) * req.turns,
      cubies,
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
    this.setLayerHighlight([], 0);

    this.active = null;
    this.onTurnComplete?.(a.record);
  }

  private setLayerHighlight(cubies: THREE.Object3D[], intensity: number) {
    for (const sticker of this.stickers) {
      (sticker.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
    }
    for (const cubie of cubies) {
      cubie.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (mat && (mesh.userData.baseColor as number | undefined) !== undefined) {
          mat.emissiveIntensity = intensity;
        }
      });
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
  // snap each basis vector of the rotation to the nearest axis
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
