import * as THREE from "three";

export type FaceName = "U" | "D" | "L" | "R" | "F" | "B";

/**
 * Geometry of each face in cube-LOCAL space (independent of view orientation):
 *  - `normal`: outward face normal
 *  - `col`:    local direction of increasing column (left -> right on the net)
 *  - `row`:    local direction of increasing row (top -> bottom on the net)
 *
 * Chosen so the unfolded cross net lines up across shared edges:
 *        [U]
 *   [L] [F] [R] [B]
 *        [D]
 */
export interface FaceGeom {
  normal: THREE.Vector3;
  col: THREE.Vector3;
  row: THREE.Vector3;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export const FACES: Record<FaceName, FaceGeom> = {
  U: { normal: v(0, 1, 0), col: v(1, 0, 0), row: v(0, 0, 1) },
  D: { normal: v(0, -1, 0), col: v(1, 0, 0), row: v(0, 0, -1) },
  F: { normal: v(0, 0, 1), col: v(1, 0, 0), row: v(0, -1, 0) },
  B: { normal: v(0, 0, -1), col: v(-1, 0, 0), row: v(0, -1, 0) },
  R: { normal: v(1, 0, 0), col: v(0, 0, -1), row: v(0, -1, 0) },
  L: { normal: v(-1, 0, 0), col: v(0, 0, 1), row: v(0, -1, 0) },
};

/** Order used when laying out / iterating the net. */
export const FACE_NAMES: FaceName[] = ["U", "D", "L", "R", "F", "B"];

/** Which face an (already axis-aligned) outward normal belongs to. */
export function faceFromNormal(n: THREE.Vector3): FaceName {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ax >= ay && ax >= az) return n.x >= 0 ? "R" : "L";
  if (ay >= az) return n.y >= 0 ? "U" : "D";
  return n.z >= 0 ? "F" : "B";
}
