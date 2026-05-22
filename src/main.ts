import * as THREE from "three";
import { RubiksCube } from "./cube";
import { Controls } from "./controls";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const movesEl = document.getElementById("moves") as HTMLSpanElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const shuffleBtn = document.getElementById("shuffle") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;

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
  const w = window.innerWidth;
  const h = window.innerHeight;
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

cube.onTurnComplete = (recordedMoves) => {
  if (recordedMoves > 0) setMoves(moves + recordedMoves);
  if (cube.isSolved() && moves > 0) showStatus("完成！", true);
  else hideStatus();
};

const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

shuffleBtn.addEventListener("click", () => {
  if (cube.isBusy()) return;
  hideStatus();
  let lastAxis = -1;
  for (let i = 0; i < 20; i++) {
    let a = Math.floor(Math.random() * 3);
    if (a === lastAxis) a = (a + 1 + Math.floor(Math.random() * 2)) % 3;
    lastAxis = a;
    cube.enqueue({
      axis: AXES[a].clone(),
      layer: Math.floor(Math.random() * 3) - 1,
      turns: Math.random() < 0.5 ? 1 : -1,
      record: false,
      duration: 110,
    });
  }
  setMoves(0);
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
  const busy = cube.isBusy() || cube.isManualActive();
  shuffleBtn.disabled = busy;
  resetBtn.disabled = busy;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

// ---- first-run tutorial -----------------------------------------------------

const tutorial = document.getElementById("tutorial") as HTMLDivElement;
const tutClose = document.getElementById("tut-close") as HTMLButtonElement;
const TUT_KEY = "rubiks-tutorial-seen";

if (!localStorage.getItem(TUT_KEY)) tutorial.hidden = false;
tutClose.addEventListener("click", () => {
  tutorial.hidden = true;
  localStorage.setItem(TUT_KEY, "1");
});
