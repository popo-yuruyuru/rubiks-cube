import * as THREE from "three";
import type { RubiksCube } from "./cube";

const SWIPE_THRESHOLD = 8; // px before a drag on a cubie commits to a face turn
const ORBIT_SPEED = 0.01; // rad per px

type Mode = "idle" | "pending" | "orbit" | "locked";

interface PendingHit {
  cubie: THREE.Object3D;
  normal: THREE.Vector3; // face normal in cube-local space (snapped)
  startX: number;
  startY: number;
}

/**
 * Pointer handling for the cube:
 *  - one finger dragging across a face -> turn that layer
 *  - one finger dragging off the cube, or two fingers -> orbit the whole cube
 */
export class Controls {
  private mode: Mode = "idle";
  private pending: PendingHit | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private primaryId: number | null = null;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

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

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size >= 2) {
      // second finger -> abandon any pending turn and orbit instead
      this.mode = "orbit";
      this.pending = null;
      this.primaryId = e.pointerId;
      return;
    }

    this.primaryId = e.pointerId;
    const hit = this.raycast(e);
    if (hit && !this.cube.isBusy()) {
      this.pending = {
        cubie: hit.cubie,
        normal: hit.normal,
        startX: e.clientX,
        startY: e.clientY,
      };
      this.mode = "pending";
    } else {
      this.mode = "orbit";
    }
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.mode === "orbit") {
      if (e.pointerId === this.primaryId) this.orbit(dx, dy);
      return;
    }

    if (this.mode === "pending" && this.pending) {
      const totalX = e.clientX - this.pending.startX;
      const totalY = e.clientY - this.pending.startY;
      if (Math.hypot(totalX, totalY) >= SWIPE_THRESHOLD) {
        this.commitTurn(this.pending, totalX, totalY);
        this.mode = "locked";
        this.pending = null;
      }
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId))
      this.canvas.releasePointerCapture(e.pointerId);

    if (this.pointers.size === 0) {
      this.mode = "idle";
      this.pending = null;
      this.primaryId = null;
    } else {
      // keep orbiting with whichever finger remains
      this.mode = "orbit";
      this.primaryId = this.pointers.keys().next().value ?? null;
    }
  };

  // ---- whole-cube rotation --------------------------------------------------

  private orbit(dx: number, dy: number) {
    const q = new THREE.Quaternion();
    const yaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      dx * ORBIT_SPEED,
    );
    const pitch = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      dy * ORBIT_SPEED,
    );
    q.multiplyQuaternions(yaw, pitch);
    this.cube.group.quaternion.premultiply(q);
  }

  // ---- face turn ------------------------------------------------------------

  private commitTurn(hit: PendingHit, screenDX: number, screenDY: number) {
    // screen swipe -> world direction using the camera basis
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const worldSwipe = right
      .multiplyScalar(screenDX)
      .add(up.multiplyScalar(-screenDY))
      .normalize();

    // into cube-local space, then project onto the face plane
    const invGroup = this.cube.group.quaternion.clone().invert();
    const localSwipe = worldSwipe.applyQuaternion(invGroup);
    localSwipe.addScaledVector(hit.normal, -localSwipe.dot(hit.normal));
    snapToAxis(localSwipe);

    // axis to spin around; +90deg pushes the surface along the swipe direction
    const axis = new THREE.Vector3().crossVectors(hit.normal, localSwipe);
    snapToAxis(axis);

    const i = dominantAxis(axis);
    const layer = Math.round(hit.cubie.position.getComponent(i));

    this.cube.enqueue({ axis, layer, turns: 1, record: true });
  }

  private raycast(e: PointerEvent): { cubie: THREE.Object3D; normal: THREE.Vector3 } | null {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const hits = this.raycaster.intersectObjects(this.cube.cubieMeshes, true);
    if (hits.length === 0 || !hits[0].face) return null;

    const hit = hits[0];
    const obj = hit.object;
    // find the owning cubie group (direct child of cube.group)
    let cubie: THREE.Object3D = obj;
    while (cubie.parent && cubie.parent !== this.cube.group) cubie = cubie.parent;

    const worldNormal = hit.face!.normal.clone().transformDirection(obj.matrixWorld);
    const localNormal = worldNormal.applyQuaternion(
      this.cube.group.quaternion.clone().invert(),
    );
    snapToAxis(localNormal);

    return { cubie, normal: localNormal };
  }
}

function dominantAxis(v: THREE.Vector3): 0 | 1 | 2 {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}

/** Collapse a vector onto its dominant unit axis, in place. */
function snapToAxis(v: THREE.Vector3) {
  const i = dominantAxis(v);
  const sign = v.getComponent(i) >= 0 ? 1 : -1;
  v.set(0, 0, 0);
  v.setComponent(i, sign);
}
