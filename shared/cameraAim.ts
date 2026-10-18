import type { Vec2 } from "./types";
export function viewForAim(
  origin: Vec2,
  aim: Vec2,
  binocular: boolean,
  distance: number,
) {
  const range = Math.hypot(aim.x - origin.x, aim.z - origin.z);
  const offset = binocular ? 25 : distance * 0.7;
  const elevation = binocular ? 18 : distance * 0.38 + 10;
  return {
    yaw: Math.atan2(aim.x - origin.x, aim.z - origin.z),
    pitch: Math.atan2(elevation, range + offset),
  };
}
