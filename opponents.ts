import type {Game, Move} from './game.ts'
import { readLines } from './public/lines.js'
import { tile, points, colors, findMelds } from './rules.js'

export const providers = {
  deepseek: {name:'DeepSeek', key:'DEEPSEEK', model:'deepseek-flash'},
  openai: {name:'GPT', key:'OPENAI', model:'gpt-4.1-mini'},
  gemini: {name:'Gemini', key:'GEMINI', model:'gemini-2.5-flash'}
}
export function practice(g:Game): Move {
  const p = g.players[g.turn]
  const {groups, remaining} = findMelds(p.hand)
  if (!p.opened && groups.reduce((n,row) => n+points(row),0)<30) return {action:'draw'}
  const board = structuredClone(g.board)
  if (p.opened) {
    for (const id of remaining) {
      let used = false
      for (const row of board) {
        for (let i=0; i<=row.length; i++) {
          const trial = row.toSpliced(i,0,id)
          if (points(trial)) { row.splice(i,0,id); used = true; break }
        }
        if (used) break
      }
    }
  }
  board.push(...groups)
  return board.flat().length > g.board.flat().length ? {action:'play',board} : {action:'draw'}
}

type Progress = (phase:'started'|'thinking'|'answering')=>void
export class ModelTimeout extends Error {}
async function streamedAnswer(response:Response, provider:keyof typeof providers, progress:Progress) {
  const name=providers[provider].name
  if (!response.body) throw Error(name+' 沒有回傳內容，請重試')
  let answer='', phase=''
  for await (const line of readLines(response.body)) {
    if (!line.startsWith('data:')) continue
    const event=line.slice(5).trim()
    if (event==='[DONE]' && provider!=='gemini') return answer
    if (!event) continue
    const chunk=JSON.parse(event)
    if (chunk.error) throw Error(name+' 串流中斷，請重試')
    if (provider==='gemini') {
      const candidate=chunk.candidates?.[0]
      for (const part of candidate?.content?.parts ?? []) {
        if (!part.text) continue
        if (part.thought) {
          if (!phase) { phase='thinking'; progress('thinking') }
        } else {
          if (phase!=='answering') { phase='answering'; progress('answering') }
          answer+=part.text
        }
      }
      if (candidate?.finishReason==='STOP') return answer
      if (candidate?.finishReason || chunk.promptFeedback?.blockReason) throw Error(name+' 未完成出牌，請重試')
      continue
    }
    const delta=chunk.choices?.[0]?.delta
    if (provider==='openai' && delta?.role==='assistant' && !phase) { phase='started'; progress('started') }
    if (delta?.reasoning_content && !phase) { phase='thinking'; progress('thinking') }
    if (delta?.content) {
      if (phase!=='answering') { phase='answering'; progress('answering') }
      answer+=delta.content
    }
  }
  throw Error(name+' 回應未完成，請重試')
}

export async function choose(g:Game, settings?:{key:string,model:string,timeoutMinutes?:number}, cancel?:AbortSignal, progress?:Progress):Promise<Move> {
  const p = g.players[g.turn]
  if (p.provider === 'local') return practice(g)
  const config = providers[p.provider as keyof typeof providers]
  const key = settings?.key ?? process.env[config.key+'_API_KEY']
  const model = settings?.model ?? (process.env[config.key+'_MODEL'] || config.model)
  const describe = (id:number) => ({id,face:tile(id).joker?'Joker':colors[tile(id).color]+tile(id).value})
  let goal='Minimize remaining rack.'
  if (p.provider==='deepseek') {
    goal=p.opened
      ? 'Choose the first sound legal play. Check for a new rack meld or a simple extension first. If neither works, try one obvious local table split or rearrangement. If that fails, draw. Stop searching once a play is legal.'
      : 'Look only at your rack for one meld or a combination of melds totaling at least 30. Copy existing table groups unchanged. Return the first legal opening you find. If no opening is apparent after one pass, draw.'
  }
  const prompt = 'Play competitive Rummikub. Return only JSON {"action":"draw"} or {"action":"play","board":[[1,2,3]]} with the COMPLETE final table of physical tile IDs. Use one or more rack tiles, preserve every old table tile. Melds: 3-4 equal ranks distinct colors, or 3+ consecutive ascending same-color ranks 1-13. Jokers wild. Before opening, preserve existing groups exactly and add only new rack melds totaling at least 30. After opening, free rearrangement. '+goal+' State: '+JSON.stringify({
    opened:p.opened, hand:p.hand.map(describe), board:g.board.map(row => row.map(describe)),
    counts:g.players.map(x => x.hand.length), pool:g.pool.length
  })
  const gemini = p.provider === 'gemini'
  const url = gemini ? 'https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+(progress?':streamGenerateContent?alt=sse':':generateContent')
    : p.provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.deepseek.com/chat/completions'
  const auth:Record<string,string> = gemini ? {'x-goog-api-key':key!} : {Authorization:'Bearer '+key}
  const includeThoughts=progress && /^gemini-(?:2\.5|3(?:\.\d+)?)-(?:flash|pro)/.test(model)
  const body = gemini ? {contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',...(includeThoughts?{thinkingConfig:{includeThoughts:true}}:{})}} :
    {model,messages:[{role:'user',content:prompt}],response_format:{type:'json_object'},...(progress?{stream:true}:{})}
  const seconds = p.provider === 'deepseek' ? (settings?.timeoutMinutes ?? 5)*60 : 75
  const deadline = AbortSignal.timeout(seconds*1000)
  const signal = cancel ? AbortSignal.any([cancel,deadline]) : deadline
  let raw
  try {
    const response = await fetch(url,{method:'POST', headers:{'Content-Type':'application/json',...auth},
      signal,body:JSON.stringify(body)})
    if (response.status===408 || response.status===504) throw new ModelTimeout()
    if (!response.ok) throw Error(config.name+' API 回應 HTTP '+response.status+'，請檢查金鑰、模型及額度後重試')
    if (progress && response.headers.get('content-type')?.includes('text/event-stream')) {
      raw=await streamedAnswer(response,p.provider as keyof typeof providers,progress)
    } else {
      const data=await response.json()
      raw=gemini ? data.candidates?.[0]?.content?.parts?.filter((x:{thought?:boolean}) => !x.thought).map((x:{text:string})=>x.text).join('') : data.choices?.[0]?.message?.content
    }
  } catch (e) {
    if (deadline.aborted && signal.reason===deadline.reason) throw new ModelTimeout()
    throw e
  }
  try { return JSON.parse(raw) } catch { throw Error(config.name+' 未回傳可用的出牌格式，請重試') }
}
