export const RADIO_ORDERS = {
  "throttle-0": "기관실, 후진! 양현 후진!",
  "throttle-1": "기관 정지! 속력 줄여!",
  "throttle-2": "미속 전진! 경계 유지!",
  "throttle-3": "양현 반속! 전진!",
  "throttle-4": "양현 강속! 강속 전진!",
  "throttle-5": "기관실, 전속 전진! 전속!",
  "helm-left": "좌현 전타! 좌현으로!",
  "helm-right": "우현 전타! 우현으로!",
  "helm-center": "키 중앙! 침로 유지!",
  "slow-2": "감속! 미속 전진!",
  "slow-3": "감속하라! 양현 반속!",
  "slow-4": "속력 줄여! 강속으로!",
} as const;
export type RadioOrder = keyof typeof RADIO_ORDERS;
