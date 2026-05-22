import * as THREE from "three";
import type { RubiksCube } from "./cube";
import { FACES, FACE_NAMES, FaceName } from "./faces";

const SWIPE_THRESHOLD = 16; // px before a net swipe commits to a turn

interface SwipeStart {
  face: FaceName;
  row: number;
  col: number;
  x: number;
  y: number;
}

/**
 * Unfolded 2D net of the cube. Renders the live sticker colors and lets the
 * user swipe a row/column to turn the matching layer (which animates in 3D).
 */
export class CubeNet {
  private cells: Record<FaceName, HTMLElement[][]> = {} as Record<
    FaceName,
    HTMLElement[][]
  >;
  private start: SwipeStart | null = null;
  private committed = false;
  private highlighted: HTMLElement[] = [];

  constructor(
    private root: HTMLElement,
    private cube: RubiksCube,
  ) {
    this.build();
    this.root.addEventListener("pointerdown", this.onDown);
    this.root.addEventListener("pointermove", this.onMove);
    this.root.addEventListener("pointerup", this.onUp);
    this.root.addEventListener("pointercancel", this.onUp);
  }

  // ---- build / sync ---------------------------------------------------------

  private build() {
    const grid = document.createElement("div");
    grid.className = "net-grid";

    for (const face of FACE_NAMES) {
      const faceEl = document.createElement("div");
      faceEl.className = "face";
      faceEl.style.gridArea = face.toLowerCase();

      const label = document.createElement("span");
      label.className = "face-label";
      label.textContent = face;
      faceEl.appendChild(label);

      this.cells[face] = [[], [], []];
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const cell = document.createElement("div");
          cell.className = "cell";
          cell.dataset.face = face;
          cell.dataset.row = String(row);
          cell.dataset.col = String(col);
          faceEl.appendChild(cell);
          this.cells[face][row][col] = cell;
        }
      }
      grid.appendChild(faceEl);
    }

    this.root.appendChild(grid);
    this.sync();
  }

  /** Pull the live colors from the cube into the net cells. */
  sync() {
    const facelets = this.cube.getFacelets();
    for (const face of FACE_NAMES) {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          this.cells[face][row][col].style.background = hex(facelets[face][row][col]);
        }
      }
    }
  }

  // ---- swipe handling -------------------------------------------------------

  private onDown = (e: PointerEvent) => {
    const cell = (e.target as HTMLElement).closest(".cell") as HTMLElement | null;
    if (!cell || this.cube.isBusy() || this.cube.isManualActive()) return;
    this.root.setPointerCapture(e.pointerId);
    this.start = {
      face: cell.dataset.face as FaceName,
      row: Number(cell.dataset.row),
      col: Number(cell.dataset.col),
      x: e.clientX,
      y: e.clientY,
    };
    this.committed = false;
  };

  private onMove = (e: PointerEvent) => {
    if (!this.start || this.committed) return;
    const dx = e.clientX - this.start.x;
    const dy = e.clientY - this.start.y;
    if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) return;
    this.committed = true;
    this.commitTurn(this.start, dx, dy);
  };

  private onUp = (e: PointerEvent) => {
    if (this.root.hasPointerCapture(e.pointerId))
      this.root.releasePointerCapture(e.pointerId);
    this.start = null;
    this.committed = false;
    this.clearHighlight();
  };

  private commitTurn(start: SwipeStart, dx: number, dy: number) {
    const g = FACES[start.face];
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const swipe = horizontal
      ? g.col.clone().multiplyScalar(Math.sign(dx))
      : g.row.clone().multiplyScalar(Math.sign(dy));

    const axis = new THREE.Vector3().crossVectors(g.normal, swipe);
    snapToAxis(axis);

    const cellPos = g.normal
      .clone()
      .addScaledVector(g.col, start.col - 1)
      .addScaledVector(g.row, start.row - 1);
    const layer = Math.round(cellPos.getComponent(dominantAxis(axis)));

    this.cube.enqueue({ axis, layer, turns: 1, kind: "user" });
    this.highlight(start, horizontal);
  }

  private highlight(start: SwipeStart, horizontal: boolean) {
    this.clearHighlight();
    for (let i = 0; i < 3; i++) {
      const cell = horizontal
        ? this.cells[start.face][start.row][i]
        : this.cells[start.face][i][start.col];
      cell.classList.add("hl");
      this.highlighted.push(cell);
    }
  }

  private clearHighlight() {
    for (const cell of this.highlighted) cell.classList.remove("hl");
    this.highlighted = [];
  }
}

// ---- helpers ----------------------------------------------------------------

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function dominantAxis(vec: THREE.Vector3): 0 | 1 | 2 {
  const ax = Math.abs(vec.x);
  const ay = Math.abs(vec.y);
  const az = Math.abs(vec.z);
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}

function snapToAxis(vec: THREE.Vector3) {
  const i = dominantAxis(vec);
  const sign = vec.getComponent(i) >= 0 ? 1 : -1;
  vec.set(0, 0, 0);
  vec.setComponent(i, sign);
}
