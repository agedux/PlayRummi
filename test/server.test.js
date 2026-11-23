import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,copyFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:net'

test('browser endpoints save, resume and reject stale turns',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'playrummi-'))
  let child
  async function stop(){
    if(child && child.exitCode===null && !child.killed){
      const done=once(child,'exit')
      child.kill()
      await done
    }
  }
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true})})
  await mkdir(join(dir,'public'))
  for(const f of ['package.json','server.ts','game.ts','opponents.ts','rules.js','public/index.html','public/app.js','public/lines.js','public/audio.js','public/style.css'])
    await copyFile(new URL('../'+f,import.meta.url),join(dir,f))
  const probe=createServer()
  probe.listen(0,'127.0.0.1')
  await once(probe,'listening')
  const port=probe.address().port
  await new Promise(resolve=>probe.close(resolve))
  const base='http://127.0.0.1:'+port
  async function start(flags=[]){
    child=spawn(process.execPath,[...flags,'server.ts'],{cwd:dir,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']})
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('server exited')})])
  }
  const post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  await start()
  const configured=await post('settings',{provider:'deepseek',model:'test-model',apiKey:'test-secret'})
  assert.equal(configured.status,200)
  const details=await configured.text()
  assert.ok(!details.includes('test-secret'))
  assert.deepEqual(JSON.parse(details).options.find(o=>o.id==='deepseek'),
    {id:'deepseek',name:'DeepSeek',ready:true,model:'test-model',timeoutMinutes:5})
  assert.equal((await post('settings',{provider:'deepseek',model:'changed-model',timeoutMinutes:0})).status,400)
  assert.equal((await post('settings',{provider:'deepseek',model:'changed-model',timeoutMinutes:8})).status,200)
  for(const path of ['/','/app.js','/audio.js','/style.css','/rules.js'])
    assert.equal((await fetch(base+path)).status,200)
  const game=await (await post('new',{id:null,revision:null,seats:['local']})).json()
  assert.equal(game.hand.length,14)
  const input={id:game.id,revision:0,move:{action:'draw'}}
  assert.equal((await post('move',input)).status,200)
  assert.equal((await post('move',input)).status,409)
  const reply=await (await post('ai',{id:game.id,revision:1})).json()
  assert.equal(reply.turn,0)
  await stop()
  const delayedProvider=`let calls=0;const timeout=AbortSignal.timeout.bind(AbortSignal)
  AbortSignal.timeout=ms=>timeout(calls>=2?10:ms)
  globalThis.fetch=async(url,{signal})=>{
    if(++calls===1) await new Promise((_,reject)=>{process.stdout.write('waiting');signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})
    if(calls>=3) await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
    const chunks=[{reasoning_content:'private reasoning'},{content:'{"action":'},{content:'"draw"}'}]
    const frames=chunks.map(delta=>'data: '+JSON.stringify({choices:[{delta}]}))
    return new Response([': keep-alive',...frames,'data: [DONE]'].join('\\r\\n\\r\\n'),{headers:{'Content-Type':'text/event-stream'}})
  }`
  await start(['--import','data:text/javascript,'+encodeURIComponent(delayedProvider)])
  const loaded=await (await fetch(base+'/api/state')).json()
  assert.deepEqual(loaded.game,reply)
  assert.deepEqual(loaded.options.find(o=>o.id==='deepseek'),
    {id:'deepseek',name:'DeepSeek',ready:true,model:'changed-model',timeoutMinutes:8})
  const aiGame=await (await post('new',{id:reply.id,revision:reply.revision,seats:['deepseek']})).json()
  const turn=await (await post('move',{id:aiGame.id,revision:0,move:{action:'draw'}})).json()
  const request={id:turn.id,revision:turn.revision,requestId:'first'}
  const waiting=once(child.stdout,'data')
  const attempt=post('ai',request)
  await waiting
  assert.equal((await post('cancel',{...request,requestId:'stale'})).status,409)
  assert.equal((await post('cancel',request)).status,200)
  assert.match((await (await attempt).json()).error,/已取消/)
  assert.deepEqual((await (await fetch(base+'/api/state')).json()).game,turn)
  const retry=await fetch(base+'/api/ai',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'},body:JSON.stringify({...request,requestId:'retry'})})
  const text=await retry.text()
  assert.ok(!text.includes('private reasoning'))
  const events=text.trim().split('\n').map(line=>JSON.parse(line))
  assert.deepEqual(events.slice(0,-1),[{phase:'thinking'},{phase:'answering'}])
  assert.equal(events.at(-1).game.revision,turn.revision+1)
  const human=events.at(-1).game
  const before=await (await post('move',{id:human.id,revision:human.revision,move:{action:'draw'}})).json()
  const timeoutRequest={id:before.id,revision:before.revision,requestId:'timeout'}
  const after=await (await post('ai',timeoutRequest)).json()
  assert.equal(after.pool,before.pool-1)
  assert.equal(after.players[1].count,before.players[1].count+1)
  assert.equal(after.turn,0)
  assert.match(after.log.at(-1),/逾時，摸了一張牌/)
  assert.equal((await post('ai',timeoutRequest)).status,409)
})
