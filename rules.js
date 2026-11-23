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

const setPatterns = [], runPatterns = []
for (let n = 0; n < 13; n++) {
  const group = [n,n+13,n+26,n+39]
  setPatterns.push(group)
  for (const omit of group) setPatterns.push(group.filter(id => id !== omit))
}
for (let color = 0; color < 4; color++) {
  for (let start = 0; start < 11; start++) {
    for (let end = start+2; end < 13; end++)
      runPatterns.push(Array.from({length:end-start+1}, (_,i) => color*13+start+i))
  }
}
const meldPatterns = {set:setPatterns, run:runPatterns, all:[...setPatterns,...runPatterns]}

function bestGroup(hand, patterns) {
  const faces = new Map()
  const jokers = []
  for (const id of hand) {
    const face = id % 52
    if (tile(id).joker) jokers.push(id)
    else if (!faces.has(face)) faces.set(face, id)
  }
  let best = [], bestScore = 0
  function consider(pattern) {
    const ids = []
    let joker = jokers.length - 1
    for (const face of pattern) {
      const id = faces.get(face) ?? jokers[joker--]
      if (id === undefined) return
      ids.push(id)
    }
    const score = points(ids)
    if (score > bestScore) {
      best = ids
      bestScore = score
    }
  }
  for (const pattern of patterns) consider(pattern)
  return best
}

export function findMelds(hand, kind='all') {
  const patterns = meldPatterns[kind]
  let remaining = [...hand]
  const groups = []
  let next = bestGroup(remaining,patterns)
  while (next.length) {
    groups.push(next)
    remaining = remaining.filter(id => !next.includes(id))
    next = bestGroup(remaining,patterns)
  }
  return {groups, remaining}
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
