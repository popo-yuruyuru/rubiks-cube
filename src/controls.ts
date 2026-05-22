import * as THREE from "three";
import type { RubiksCube } from "./cube";

const SWIPE_THRESHOLD = 22; // px before a drag on a cubie commits to a face turn
const TAP_MOVE = 10; // px — movement under this counts as a tap, not a drag
const DOUBLE_TAP_MS = 300;
const ORBIT_SPEED = 0.011; // rad per px
const MAX_STEP = 0.16; // clamp per-event orbit rotation (anti motion-sickness)
const SPIN_DECAY = 0.92; // inertia falloff per frame
const SPIN_MIN = 0.0009; // below this the spin stops
const TURN_FRACTION = 0.3; // drag distance for a 90° turn = TURN_FRACTION * min(viewport)

type Mode = "idle" | "deciding" | "manual" | "orbit";

interface PendingHit {
  cubie: THREE.Object3D;
  normal: THREE.Vector3; // face normal in cube-local space (snapped)
  point: THREE.Vector3; // world-space hit point
}

/**
 * Pointer handling:
 *  - one finger across a face -> finger-following layer turn, snaps on release
 *  - one finger off the cube, or two fingers -> orbit (with inertia)
 *  - double tap -> animate back to the front view
 */
export class Controls {
  private mode: Mode = "idle";
  private pending: PendingHit | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private primaryId: number | null = null;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  // finger-following turn state
  private screenDir = new THREE.Vector2();
  private beginX = 0;
  private beginY = 0;
  private anglePerPixel = 0;

  // orbit inertia + view reset
  private spinYaw = 0;
  private spinPitch = 0;
  private orbiting = false;
  private resettingView = false;

  // tap / double-tap tracking
  private downTime = 0;
  private downX = 0;
  private downY = 0;
  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: THREE.Camera,
    private cube: RubiksCube,
  ) {
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onUp);
  }

  // ---- per-frame: inertia + view-reset animation ----------------------------

  update() {
    if (this.resettingView) {
      const q = this.cube.group.quaternion;
      q.slerp(IDENTITY, 0.2);
      if (q.angleTo(IDENTITY) < 0.01) {
        q.copy(IDENTITY);
        this.resettingView = false;
      }
      return;
    }

    if (!this.orbiting && (Math.abs(this.spinYaw) > SPIN_MIN || Math.abs(this.spinPitch) > SPIN_MIN)) {
      this.applyOrbit(this.spinYaw, this.spinPitch);
      this.spinYaw *= SPIN_DECAY;
      this.spinPitch *= SPIN_DECAY;
    } else {
      this.spinYaw = 0;
      this.spinPitch = 0;
    }
  }

  // ---- pointer events -------------------------------------------------------

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.resettingView = false;
    this.spinYaw = this.spinPitch = 0;

    if (this.pointers.size >= 2) {
      if (this.mode === "manual") return; // don't disturb an in-progress turn
      this.startOrbit(e.pointerId);
      return;
    }

    this.primaryId = e.pointerId;
    this.downTime = performance.now();
    this.downX = e.clientX;
    this.downY = e.clientY;

    const hit = this.raycast(e);
    if (hit && !this.cube.isBusy()) {
      this.pending = hit;
      this.mode = "deciding";
      this.cube.highlightTouch(hit.cubie, hit.normal);
    } else {
      this.startOrbit(e.pointerId);
    }
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.mode === "orbit") {
      if (e.pointerId === this.primaryId) {
        const rx = clamp(dx * ORBIT_SPEED, MAX_STEP);
        const ry = clamp(dy * ORBIT_SPEED, MAX_STEP);
        this.applyOrbit(rx, ry);
        this.spinYaw = rx;
        this.spinPitch = ry;
      }
      return;
    }

    if (this.mode === "deciding" && this.pending) {
      const totalX = e.clientX - this.downX;
      const totalY = e.clientY - this.downY;
      if (Math.hypot(totalX, totalY) >= SWIPE_THRESHOLD) {
        this.beginManualTurn(e, totalX, totalY);
      }
      return;
    }

    if (this.mode === "manual") {
      const proj =
        (e.clientX - this.beginX) * this.screenDir.x +
        (e.clientY - this.beginY) * this.screenDir.y;
      this.cube.setManualAngle(proj * this.anglePerPixel);
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId))
      this.canvas.releasePointerCapture(e.pointerId);

    if (this.mode === "manual") {
      this.cube.endManualTurn();
    } else if (this.mode === "deciding") {
      this.cube.clearTouch();
      this.detectTap(e);
    } else if (this.mode === "orbit") {
      this.detectTap(e);
    }

    if (this.pointers.size === 0) {
      this.orbiting = false;
      this.mode = "idle";
      this.pending = null;
      this.primaryId = null;
    } else {
      // a finger remains — keep orbiting with it
      this.startOrbit(this.pointers.keys().next().value!);
    }
  };

  // ---- orbit ----------------------------------------------------------------

  private startOrbit(id: number) {
    this.mode = "orbit";
    this.orbiting = true;
    this.pending = null;
    this.primaryId = id;
    this.cube.clearTouch();
  }

  private applyOrbit(yaw: number, pitch: number) {
    const qy = new THREE.Quaternion().setFromAxisAngle(WORLD_Y, yaw);
    const qx = new THREE.Quaternion().setFromAxisAngle(WORLD_X, pitch);
    this.cube.group.quaternion.premultiply(qy.multiply(qx));
  }

  private detectTap(e: PointerEvent) {
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    const quick = performance.now() - this.downTime < 250;
    if (!(moved < TAP_MOVE && quick)) return;

    const now = performance.now();
    const near = Math.hypot(e.clientX - this.lastTapX, e.clientY - this.lastTapY) < 40;
    if (now - this.lastTapTime < DOUBLE_TAP_MS && near) {
      this.resettingView = true; // double tap -> snap back to front view
      this.spinYaw = this.spinPitch = 0;
      this.lastTapTime = 0;
    } else {
      this.lastTapTime = now;
      this.lastTapX = e.clientX;
      this.lastTapY = e.clientY;
    }
  }

  // ---- face turn setup ------------------------------------------------------

  private beginManualTurn(e: PointerEvent, screenDX: number, screenDY: number) {
    const hit = this.pending!;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const worldSwipe = right
      .multiplyScalar(screenDX)
      .add(up.multiplyScalar(-screenDY))
      .normalize();

    const invGroup = this.cube.group.quaternion.clone().invert();
    const localSwipe = worldSwipe.clone().applyQuaternion(invGroup);
    localSwipe.addScaledVector(hit.normal, -localSwipe.dot(hit.normal));
    if (localSwipe.lengthSq() < 1e-6) return;
    snapToAxis(localSwipe);

    const axis = new THREE.Vector3().crossVectors(hit.normal, localSwipe);
    snapToAxis(axis);
    const layer = Math.round(hit.cubie.position.getComponent(dominantAxis(axis)));

    this.cube.beginManualTurn(axis, layer);

    // screen-space direction of +localSwipe, for mapping drag distance -> angle
    const w = window.innerWidth;
    const h = window.innerHeight;
    const worldDir = localSwipe.clone().applyQuaternion(this.cube.group.quaternion);
    const p0 = hit.point.clone().project(this.camera);
    const p1 = hit.point.clone().add(worldDir).project(this.camera);
    this.screenDir.set((p1.x - p0.x) * (w / 2), -(p1.y - p0.y) * (h / 2)).normalize();

    this.beginX = e.clientX;
    this.beginY = e.clientY;
    this.anglePerPixel = Math.PI / 2 / (Math.min(w, h) * TURN_FRACTION);
    this.mode = "manual";
    this.pending = null;
  }

  private raycast(e: PointerEvent): PendingHit | null {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const hits = this.raycaster.intersectObjects(this.cube.cubieMeshes, true);
    if (hits.length === 0 || !hits[0].face) return null;

    const hit = hits[0];
    const obj = hit.object;
    let cubie: THREE.Object3D = obj;
    while (cubie.parent && cubie.parent !== this.cube.group) cubie = cubie.parent;

    const worldNormal = hit.face!.normal.clone().transformDirection(obj.matrixWorld);
    const localNormal = worldNormal.applyQuaternion(
      this.cube.group.quaternion.clone().invert(),
    );
    snapToAxis(localNormal);

    return { cubie, normal: localNormal, point: hit.point.clone() };
  }
}

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();

function clamp(v: number, max: number): number {
  return Math.max(-max, Math.min(max, v));
}

function dominantAxis(v: THREE.Vector3): 0 | 1 | 2 {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}

function snapToAxis(v: THREE.Vector3) {
  const i = dominantAxis(v);
  const sign = v.getComponent(i) >= 0 ? 1 : -1;
  v.set(0, 0, 0);
  v.setComponent(i, sign);
}
