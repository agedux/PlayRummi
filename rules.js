export const colors = ['紅','藍','黑','橙']
export function tile(id) {
  return { color: Math.floor(id / 13) % 4, value: id % 13 + 1, joker: id >= 104 }
}
// Run order is explicit so a joker's represented value is unambiguous.
export function points(ids) {
  if (ids.length < 3 || ids.length > 13) return 0
  const real = ids.map((id, i) => ({ ...tile(id), i })).filter(t => !t.joker)
  if (!real.length) return 0
  const first = real[0]
  if (ids.length <= 4 && real.every(t => t.value === first.value) &&
      new Set(real.map(t => t.color)).size === real.length) return first.value * ids.length
  const start = first.value - first.i
  if (start < 1 || start + ids.length - 1 > 13 ||
      !real.every(t => t.color === first.color && t.value === start + t.i)) return 0
  return (2 * start + ids.length - 1) * ids.length / 2
}
export function same(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

// Keep tile order and prefer the longest legal prefix that leaves a playable suffix.
export function splitMelds(row) {
  if (row.length < 6 || points(row)) return [row]
  const next = new Map([[row.length, row.length]])
  for (let start = row.length - 3; start >= 0; start--) {
    for (let end = Math.min(start + 13, row.length); end >= start + 3; end--) {
      if (next.has(end) && points(row.slice(start, end))) {
        next.set(start, end)
        break
      }
    }
  }
  if (!next.has(0)) return [row]
  const groups = []
  for (let start = 0; start < row.length; start = next.get(start))
    groups.push(row.slice(start, next.get(start)))
  return groups
}
