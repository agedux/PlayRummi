import { createServer } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createGame, play, view, type Game } from './game.ts'
import { choose, providers, ModelTimeout } from './opponents.ts'

const port = Number(process.env.PORT || 4173)
const dataDir = new URL('./data/',import.meta.url)
mkdirSync(dataDir,{recursive:true})
const db = new DatabaseSync(new URL('game.sqlite',dataDir))
db.exec('CREATE TABLE IF NOT EXISTS saves (slot INTEGER PRIMARY KEY, state TEXT NOT NULL)')
const load = ():Game|null => {
  const row = db.prepare('SELECT state FROM saves WHERE slot=1').get()
  return row ? JSON.parse(String(row.state)) : null
}
const save = (g:Game) => db.prepare('INSERT OR REPLACE INTO saves VALUES(1,?)').run(JSON.stringify(g))
const settingsDb = new DatabaseSync(new URL('settings.sqlite',dataDir))
settingsDb.exec('CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, api_key TEXT, model TEXT NOT NULL)')
if (!settingsDb.prepare('PRAGMA table_info(providers)').all().some(column=>column.name==='timeout_minutes'))
  settingsDb.exec('ALTER TABLE providers ADD COLUMN timeout_minutes INTEGER NOT NULL DEFAULT 5')
type ProviderId = keyof typeof providers
function settings(id:ProviderId) {
  const defaults = providers[id]
  const row = settingsDb.prepare('SELECT api_key, model, timeout_minutes FROM providers WHERE id=?').get(id)
  return {
    key:String(row?.api_key ?? process.env[defaults.key+'_API_KEY'] ?? ''),
    model:String(row?.model || process.env[defaults.key+'_MODEL'] || defaults.model),
    timeoutMinutes:Number(row?.timeout_minutes ?? 5)
  }
}
const options = () => Object.entries(providers).map(([id,c]) => {
  const {key,model,timeoutMinutes} = settings(id as ProviderId)
  return {id,name:c.name,ready:!!key,model,...(id==='deepseek'?{timeoutMinutes}:{})}
})
const assets:Record<string,[string,string]> = {'/':['public/index.html','text/html'],'/app.js':['public/app.js','text/javascript'],
  '/rules.js':['rules.js','text/javascript'],'/lines.js':['public/lines.js','text/javascript'],
  '/audio.js':['public/audio.js','text/javascript'],'/style.css':['public/style.css','text/css']}
let busy = false
let pendingAI:{requestId:string, id:string, revision:number, controller:AbortController}|null=null
createServer(async (req,res) => {
  const json = (code:number,data:unknown) => { res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)) }
  let locked = false
  let streaming = false
  const event=(value:unknown)=>res.write(JSON.stringify(value)+'\n')
  try {
    const hosts = ['localhost:'+port,'127.0.0.1:'+port]
    if (!hosts.includes(req.headers.host || '') || (req.headers.origin && req.headers.origin !== 'http://'+req.headers.host))
      return json(403,{error:'只接受本機同源連線'})
    const path = req.url || '/'
    if (req.method === 'GET' && Object.hasOwn(assets,path)) {
      const [file,type] = assets[path]
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-cache'})
      return res.end(readFileSync(new URL(file,import.meta.url)))
    }
    const g = load()
    if (req.method === 'GET' && path === '/api/state') return json(200,{game:g && view(g),options:options()})
    if (req.method !== 'POST' || !['/api/settings','/api/new','/api/move','/api/ai','/api/cancel'].includes(path)) return json(404,{error:'找不到頁面'})
    if (req.headers['content-type'] !== 'application/json') return json(415,{error:'需要 JSON'})
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 16384) return json(413,{error:'資料過大'})
    }
    let input
    try { input = JSON.parse(raw) } catch { return json(400,{error:'資料格式不正確'}) }
    if (path === '/api/settings') {
      const {provider,model,apiKey} = input
      if (typeof provider !== 'string' || !Object.hasOwn(providers,provider) ||
          typeof model !== 'string' || !model.trim() || model.length>200 ||
          (apiKey !== undefined && (typeof apiKey !== 'string' || !/^[!-~]{1,4096}$/.test(apiKey))))
        return json(400,{error:'請確認供應商、模型名稱與金鑰格式'})
      const minutes=input.timeoutMinutes ?? settings(provider as ProviderId).timeoutMinutes
      if (!Number.isInteger(minutes) || minutes<1 || minutes>30) return json(400,{error:'等待上限須為 1 至 30 分鐘的整數'})
      settingsDb.prepare('INSERT INTO providers(id,api_key,model,timeout_minutes) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET api_key=COALESCE(excluded.api_key,providers.api_key),model=excluded.model,timeout_minutes=excluded.timeout_minutes').run(provider,apiKey ?? null,model.trim(),minutes)
      return json(200,{options:options()})
    }
    if (path==='/api/cancel') {
      if (!pendingAI || pendingAI.requestId!==input.requestId || pendingAI.id!==input.id || pendingAI.revision!==input.revision)
        return json(409,{error:'這次請求已結束'})
      pendingAI.controller.abort(new Error('已取消請求，回合已保留'))
      return json(200,{cancelled:true})
    }
    if (busy) return json(409,{error:'牌桌正在處理回合'})
    busy = locked = true
    const current = load()
    if ((current?.id ?? null) !== input.id || (current?.revision ?? null) !== input.revision)
      return json(409,{error:'牌局已更新，請重新整理'})
    if (path === '/api/new') {
      const seats = input.seats
      if (!Array.isArray(seats) || seats.length<1 || seats.length>3) throw Error('請選 1 至 3 個對手')
      const newGame = createGame(seats.map((id,i) => {
        if (id === 'local') return {provider:id,name:'練習對手 '+(i+1)}
        const opt = options().find(o => o.id === id && o.ready)
        if (!opt) throw Error('此對手尚未設定 API 金鑰')
        return {provider:id,name:opt.name}
      }))
      save(newGame)
      return json(200,view(newGame))
    }
    if (!current || current.result) throw Error('請開新局')
    if ((path === '/api/ai') !== (current.turn !== 0)) throw Error('回合已改變')
    const provider = current.players[current.turn].provider
    const aiSettings = Object.hasOwn(providers,provider) ? settings(provider as ProviderId) : undefined
    let move=input.move
    let timedOut=false
    if (path==='/api/ai') {
      const controller=new AbortController()
      pendingAI={id:current.id,revision:current.revision,requestId:input.requestId,controller}
      res.once('close',()=>controller.abort(new Error('連線已關閉')))
      streaming=!!aiSettings && req.headers.accept==='application/x-ndjson'
      if (streaming) {
        res.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'})
        res.flushHeaders()
      }
      try { move=await choose(current,aiSettings,controller.signal,streaming?phase=>event({phase}):undefined) }
      catch (e) {
        if (!(e instanceof ModelTimeout)) throw e
        timedOut=true
        move={action:'draw'}
      }
      controller.signal.throwIfAborted()
    }
    play(current,move,timedOut)
    save(current)
    if (streaming) { event({game:view(current)}); res.end() }
    else json(200,view(current))
  } catch (e) {
    const failure={error:e instanceof Error ? e.message : '回合失敗，請重試'}
    if (streaming) { event(failure); res.end() }
    else json(400,failure)
  }
  finally { if (locked) { busy = false; pendingAI=null } }
}).listen(port,'127.0.0.1',() => console.log('PlayRummi  http://127.0.0.1:'+port))
