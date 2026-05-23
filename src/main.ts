import * as THREE from "three";
import { RubiksCube, TurnAction } from "./cube";
import { Controls } from "./controls";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLElement;
const movesEl = document.getElementById("moves") as HTMLSpanElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const shuffleBtn = document.getElementById("shuffle") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
const undoBtn = document.getElementById("undo") as HTMLButtonElement;
const redoBtn = document.getElementById("redo") as HTMLButtonElement;
const undoEdge = document.getElementById("undo-edge") as HTMLElement;
const redoEdge = document.getElementById("redo-edge") as HTMLElement;

// ---- renderer / scene -------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();

const CAMERA_DIR = new THREE.Vector3(0.85, 0.85, 1.15).normalize();
const CAMERA_TARGET = new THREE.Vector3(0, 0.35, 0); // raised target -> cube sits lower
const FOV = 45;
const CUBE_RADIUS = 2.6; // a touch larger than the cube so it nearly fills the view

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

scene.add(new THREE.HemisphereLight(0xffffff, 0x223044, 1.05));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(5, 8, 6);
scene.add(key);
const fill = new THREE.DirectionalLight(0x8fb3ff, 0.4);
fill.position.set(-6, -3, -4);
scene.add(fill);

const cube = new RubiksCube();
scene.add(cube.group);

const controls = new Controls(canvas, camera, cube);

// ---- responsive fit ---------------------------------------------------------

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;

  // distance that fits CUBE_RADIUS within the smaller of the two FOV angles
  const vFov = THREE.MathUtils.degToRad(FOV);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fitFov = Math.min(vFov, hFov);
  const distance = CUBE_RADIUS / Math.sin(fitFov / 2);

  camera.position.copy(CAMERA_DIR).multiplyScalar(distance).add(CAMERA_TARGET);
  camera.lookAt(CAMERA_TARGET);
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(stage);
resize();

// ---- UI ---------------------------------------------------------------------

let moves = 0;

function setMoves(n: number) {
  moves = n;
  movesEl.textContent = String(n);
}

function showStatus(text: string, solved: boolean) {
  statusEl.textContent = text;
  statusEl.classList.toggle("solved", solved);
  statusEl.classList.add("show");
}

function hideStatus() {
  statusEl.classList.remove("show");
}

// ---- history / undo / redo --------------------------------------------------

const history: TurnAction[] = [];
const redoStack: TurnAction[] = [];

function refreshHistoryUI() {
  const canUndo = history.length > 0 && !busyForUser();
  const canRedo = redoStack.length > 0 && !busyForUser();
  undoBtn.disabled = !canUndo;
  redoBtn.disabled = !canRedo;
  undoEdge.classList.toggle("show", history.length > 0);
  redoEdge.classList.toggle("show", redoStack.length > 0);
}

function busyForUser(): boolean {
  return cube.isBusy() || cube.isManualActive();
}

cube.onTurnComplete = (action) => {
  if (action.turns !== 0) {
    if (action.kind === "user") {
      setMoves(moves + Math.abs(action.turns));
      history.push(action);
      redoStack.length = 0;
    } else if (action.kind === "redo") {
      setMoves(moves + Math.abs(action.turns));
      history.push({ ...action, kind: "user" });
    } else if (action.kind === "undo") {
      setMoves(Math.max(0, moves - Math.abs(action.turns)));
      redoStack.push({ ...action, axis: action.axis.clone(), turns: -action.turns, kind: "user" });
    }
  }
  refreshHistoryUI();
  if (cube.isSolved() && moves > 0) showStatus("完成！", true);
  else hideStatus();
};

function undo() {
  if (busyForUser() || history.length === 0) return;
  const last = history.pop()!;
  cube.enqueue({
    axis: last.axis.clone(),
    layer: last.layer,
    turns: -last.turns,
    kind: "undo",
    duration: 200,
  });
  refreshHistoryUI();
}

function redo() {
  if (busyForUser() || redoStack.length === 0) return;
  const next = redoStack.pop()!;
  cube.enqueue({
    axis: next.axis.clone(),
    layer: next.layer,
    turns: next.turns,
    kind: "redo",
    duration: 200,
  });
  refreshHistoryUI();
}

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

shuffleBtn.addEventListener("click", () => {
  if (busyForUser()) return;
  hideStatus();
  history.length = 0;
  redoStack.length = 0;
  let lastAxis = -1;
  for (let i = 0; i < 20; i++) {
    let a = Math.floor(Math.random() * 3);
    if (a === lastAxis) a = (a + 1 + Math.floor(Math.random() * 2)) % 3;
    lastAxis = a;
    cube.enqueue({
      axis: AXES[a].clone(),
      layer: Math.floor(Math.random() * 3) - 1,
      turns: Math.random() < 0.5 ? 1 : -1,
      kind: "shuffle",
      duration: 110,
    });
  }
  setMoves(0);
  refreshHistoryUI();
});

// reset requires a 1s hold (progress bar fills) to avoid accidental taps
const RESET_HOLD_MS = 1000;
let resetTimer = 0;
let resetHolding = false;

function startResetHold() {
  if (resetBtn.disabled || resetHolding) return;
  resetHolding = true;
  resetBtn.classList.add("holding");
  resetTimer = window.setTimeout(() => {
    cube.reset();
    setMoves(0);
    history.length = 0;
    redoStack.length = 0;
    refreshHistoryUI();
    hideStatus();
    cancelResetHold();
  }, RESET_HOLD_MS);
}

function cancelResetHold() {
  resetHolding = false;
  clearTimeout(resetTimer);
  resetBtn.classList.remove("holding");
}

resetBtn.addEventListener("pointerdown", startResetHold);
resetBtn.addEventListener("pointerup", cancelResetHold);
resetBtn.addEventListener("pointerleave", cancelResetHold);
resetBtn.addEventListener("pointercancel", cancelResetHold);

// ---- render loop ------------------------------------------------------------

function tick(now: number) {
  controls.update();
  cube.update(now);
  const busy = busyForUser();
  shuffleBtn.disabled = busy;
  resetBtn.disabled = busy;
  undoBtn.disabled = busy || history.length === 0;
  redoBtn.disabled = busy || redoStack.length === 0;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

// ---- edge swipe gestures: left=undo, right=redo -----------------------------

const EDGE_WIDTH = 22; // px: pointer must start within this band from the edge
const EDGE_TRIGGER = 56; // px: inward swipe length that fires the gesture

interface EdgeGesture {
  side: "left" | "right";
  startX: number;
  startY: number;
  fired: boolean;
}
let edgeGesture: EdgeGesture | null = null;

window.addEventListener(
  "pointerdown",
  (e) => {
    // never steal button taps
    const t = e.target;
    if (t instanceof HTMLElement && t.closest("button")) return;
    if (e.clientX <= EDGE_WIDTH) edgeGesture = { side: "left", startX: e.clientX, startY: e.clientY, fired: false };
    else if (e.clientX >= window.innerWidth - EDGE_WIDTH)
      edgeGesture = { side: "right", startX: e.clientX, startY: e.clientY, fired: false };
    else return;
    e.stopPropagation();
  },
  true, // capture: beat the canvas listeners
);

window.addEventListener(
  "pointermove",
  (e) => {
    if (!edgeGesture || edgeGesture.fired) return;
    const dx = e.clientX - edgeGesture.startX;
    const dy = e.clientY - edgeGesture.startY;
    if (Math.abs(dy) > Math.abs(dx) + 8) {
      edgeGesture = null; // looks vertical, let the user orbit on the next gesture
      return;
    }
    if (edgeGesture.side === "left" && dx > EDGE_TRIGGER) {
      edgeGesture.fired = true;
      undo();
    } else if (edgeGesture.side === "right" && dx < -EDGE_TRIGGER) {
      edgeGesture.fired = true;
      redo();
    }
  },
  true,
);

window.addEventListener(
  "pointerup",
  () => {
    edgeGesture = null;
  },
  true,
);
window.addEventListener(
  "pointercancel",
  () => {
    edgeGesture = null;
  },
  true,
);

refreshHistoryUI();

// ---- first-run tutorial -----------------------------------------------------

const tutorial = document.getElementById("tutorial") as HTMLDivElement;
const tutClose = document.getElementById("tut-close") as HTMLButtonElement;
const TUT_KEY = "rubiks-tutorial-seen";

if (!localStorage.getItem(TUT_KEY)) tutorial.hidden = false;
tutClose.addEventListener("click", () => {
  tutorial.hidden = true;
  localStorage.setItem(TUT_KEY, "1");
});
