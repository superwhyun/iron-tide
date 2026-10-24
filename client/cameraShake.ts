import * as THREE from "three";

const MAX_YAW = 0.045;
const MAX_PITCH = 0.035;
const MAX_ROLL = 0.04;
const MAX_OFFSET = 2.4;
const TRAUMA_DECAY = 1.35;

// Smooth pseudo-noise from incommensurate sines; avoids per-frame jitter.
function wobble(t: number, seed: number) {
  return (
    Math.sin(t * 1.0 + seed) * 0.5 +
    Math.sin(t * 2.17 + seed * 1.7) * 0.3 +
    Math.sin(t * 4.93 + seed * 3.1) * 0.2
  );
}

export interface ShakeSample {
  yaw: number;
  pitch: number;
  roll: number;
  offset: THREE.Vector3;
}

/**
 * Trauma-based camera shake (shake = trauma²) plus a separate recoil kick for
 * the player's own guns, so firing feels heavy without blurring the aim.
 */
export class CameraShake {
  private trauma = 0;
  private kick = 0;
  private kickVelocity = 0;
  private time = 0;
  private saved = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  };
  private active = false;
  get level() {
    return this.trauma;
  }
  add(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }
  recoil(amount: number) {
    this.kickVelocity += amount;
  }
  sample(dt: number): ShakeSample {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    // Critically damped spring returning the recoil kick to rest.
    const stiffness = 90,
      damping = 2 * Math.sqrt(stiffness);
    this.kickVelocity +=
      (-stiffness * this.kick - damping * this.kickVelocity) * dt;
    this.kick += this.kickVelocity * dt;
    const shake = this.trauma * this.trauma,
      t = this.time * 22;
    return {
      yaw: MAX_YAW * shake * wobble(t, 1.3),
      pitch: MAX_PITCH * shake * wobble(t, 7.9) - this.kick * 0.03,
      roll: MAX_ROLL * shake * wobble(t * 0.8, 4.2),
      offset: new THREE.Vector3(
        wobble(t * 0.6, 2.2),
        wobble(t * 0.6, 5.5),
        wobble(t * 0.6, 9.1),
      ).multiplyScalar(MAX_OFFSET * shake),
    };
  }
  /** Applies the sample for one render; `restore` must follow the draw call. */
  apply(camera: THREE.PerspectiveCamera, s: ShakeSample, scale: number) {
    if (scale <= 0) return;
    if (Math.abs(s.yaw) + Math.abs(s.pitch) + Math.abs(s.roll) < 1e-5) return;
    this.saved.position.copy(camera.position);
    this.saved.quaternion.copy(camera.quaternion);
    this.active = true;
    camera.rotateY(s.yaw * scale);
    camera.rotateX(s.pitch * scale);
    camera.rotateZ(s.roll);
    camera.position.addScaledVector(s.offset, scale);
    camera.updateMatrixWorld();
  }
  restore(camera: THREE.PerspectiveCamera) {
    if (!this.active) return;
    camera.position.copy(this.saved.position);
    camera.quaternion.copy(this.saved.quaternion);
    camera.updateMatrixWorld();
    this.active = false;
  }
}
