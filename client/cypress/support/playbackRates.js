/**
 * Every speed the player offers (components/controls/PlaybackSpeedControl.vue: MIN_SPEED 0.5,
 * MAX_SPEED 10, increments of 0.1 or 0.05; the 0.1 steps and presets are a subset of the 0.05 steps)
 */
export function allPlaybackRates() {
  const rates = []
  for (let k = 0; k <= 190; k++) rates.push(Number((0.5 + k * 0.05).toFixed(2)))
  return rates
}
