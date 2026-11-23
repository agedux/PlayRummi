import { randomInt, randomUUID } from 'node:crypto'
import { points, same, tile } from './rules.js'

export type Player = { name: string, provider: string, hand: number[], opened: boolean }
export type Move = { action: 'draw' } | { action: 'play', board: number[][] }
export type Game = ReturnType<typeof createGame>
export function createGame(seats: {name:string, provider:string}[]) {
  const pool = Array.from({ length: 106 }, (_, i) => i)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const players: Player[] = [{ name:'你', provider:'human' }, ...seats].map(p =>
    ({ ...p, hand: pool.splice(0, 14), opened:false }))
  return { id:randomUUID(), revision:0, turn:0, pool, players, board:[] as number[][],
    log:[] as string[], changed:[] as number[], passes:0, result:'' }
}

export function play(g:Game, move:Move, timedOut=false) {
  const p = g.players[g.turn]
  if (g.result) throw Error('此局已結束')
  let message: string
  if (move.action === 'draw') {
    const id = g.pool.pop()
    if (id === undefined) { g.passes++; message = '過牌' }
    else { p.hand.push(id); g.passes = 0; message = '摸了一張牌' }
    if (timedOut) message='逾時，'+message
    g.changed = []
  } else {
    if (move.action !== 'play' || !Array.isArray(move.board) ||
        !move.board.every(row => Array.isArray(row) && points(row))) throw Error('每組須為同數異色或同色遞增的連號，至少三張')
    const old = g.board.flat()
    const all = move.board.flat()
    const allowed = new Set([...old, ...p.hand])
    if (new Set(all).size !== all.length || all.some(id => !allowed.has(id)) ||
        old.some(id => !all.includes(id))) throw Error('牌張重複、遺漏或不屬於此回合')
    const added = all.filter(id => p.hand.includes(id))
    if (!added.length) throw Error('本回合至少要出一張手牌')
    if (!p.opened) {
      if (!g.board.every(row => move.board.some(r => same(row,r)))) throw Error('破冰前只能用自己的手牌')
      const score = move.board.filter(row => row.every(id => p.hand.includes(id))).reduce((n,row) => n+points(row),0)
      if (score < 30) throw Error('首次出牌須達 30 分，目前為 ' + score + ' 分')
    }
    g.changed = move.board.filter(row => !g.board.some(prev => same(prev,row))).flat()
    g.board = move.board
    p.hand = p.hand.filter(id => !added.includes(id))
    p.opened = true
    g.passes = 0
    message = '出了 ' + added.length + ' 張牌'
    if (!p.hand.length) g.result = p.name + '出清手牌，獲勝！'
  }
  g.log.push(p.name + ' ' + message)
  if (g.passes === g.players.length) {
    const scores = g.players.map(p => p.hand.reduce((n,id) => n + (tile(id).joker ? 30 : tile(id).value),0))
    g.result = g.players.filter((_,i) => scores[i] === Math.min(...scores)).map(p => p.name).join('、') + '以最低手牌點數獲勝！'
  }
  g.turn = (g.turn + 1) % g.players.length
  g.revision++
}

export function view(g:Game) {
  const {pool, players, ...publicState} = g
  return {...publicState, pool:pool.length, hand:players[0].hand,
    players:players.map(({hand,...p}) => ({...p,count:hand.length}))}
}
