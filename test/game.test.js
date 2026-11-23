import test from 'node:test'
import assert from 'node:assert/strict'
import {createGame,play,view} from '../game.ts'
import {choose,practice,providers} from '../opponents.ts'
import {findMelds,points} from '../rules.js'

test('a timed-out opponent passes when the pool is empty',()=>{
  const g=createGame([{name:'GPT',provider:'openai'}])
  g.turn=1
  g.pool=[]
  const count=g.players[1].hand.length
  play(g,{action:'draw'},true)
  assert.equal(g.players[1].hand.length,count)
  assert.equal(g.turn,0)
  assert.equal(g.passes,1)
  assert.equal(g.log.at(-1),'GPT 逾時，過牌')
})

test('GPT and Gemini signal progress and assemble only answer text',async t=>{
  for (const provider of ['openai','gemini']) {
    const g=createGame([{name:'AI',provider}])
    g.turn=1
    const phases=[]
    const mock=t.mock.method(globalThis,'fetch',async(url,init)=>{
      const parts=['{"action":','"draw"}']
      let frames
      if (provider==='openai') {
        assert.equal(JSON.parse(init.body).stream,true)
        frames=[{role:'assistant'},...parts.map(content=>({content}))].map(delta=>({choices:[{delta}]}))
      } else {
        assert.match(url,/streamGenerateContent\?alt=sse/)
        frames=[{thought:true,text:'summary'},...parts.map(text=>({text}))].map(part=>({candidates:[{content:{parts:[part]}}]}))
        frames.push({candidates:[{finishReason:'STOP'}]})
      }
      const lines=frames.map(frame=>'data: '+JSON.stringify(frame))
      if (provider==='openai') lines.push('data: [DONE]')
      return new Response(lines.join('\n\n'),{headers:{'Content-Type':'text/event-stream'}})
    })
    assert.deepEqual(await choose(g,undefined,undefined,p=>phases.push(p)),{action:'draw'})
    assert.deepEqual(phases,[provider==='gemini'?'thinking':'started','answering'])
    mock.mock.restore()
  }
})

test('groups, runs, jokers and opening rollback',()=>{
  assert.equal(points([12,25,104]),39)
  assert.equal(points([8,104,10]),30)
  assert.equal(points([12,104,0]),0)
  assert.equal(points([1,53,14]),0)
  const g=createGame([{name:'A',provider:'local'}])
  g.players[0].hand=[0,1,2,8,9,10,12]
  const original=structuredClone(g)
  assert.throws(()=>play(g,{action:'play',board:[[0,1,2]]}),/30/)
  assert.deepEqual(g,original)
  play(g,{action:'play',board:[[8,9,10]]})
  assert.equal(g.players[0].opened,true)
  g.players[1].hand=[11,12,25,38]
  assert.throws(()=>play(g,{action:'play',board:[[8,9,10,11],[12,25,38]]}),/破冰/)
  g.players[1].opened=true
  assert.throws(()=>play(g,{action:'play',board:[[12,25,38]]}),/遺漏/)
  play(g,{action:'play',board:[[8,9,10,11],[12,25,38]]})
  assert.ok(g.result)
})
test('rack sorting shows sets by number and runs by color',()=>{
  const hand=[3,4,5,18,31,44]
  assert.deepEqual(findMelds(hand,'set'),{groups:[[5,18,31,44]],remaining:[3,4]})
  assert.deepEqual(findMelds(hand,'run'),{groups:[[3,4,5]],remaining:[18,31,44]})
})
test('four-seat games reach a result and conserve tiles',()=>{
  const g=createGame(['A','B','C'].map(name=>({name,provider:'local'})))
  while(!g.result && g.revision<500) {
    play(g,practice(g))
    const ids=[...g.pool,...g.board.flat(),...g.players.flatMap(p=>p.hand)]
    assert.equal(ids.length,106)
    assert.equal(new Set(ids).size,106)
  }
  assert.ok(g.result)
  assert.equal(view(g).players[1].hand,undefined)
})
test('provider adapters submit only visible state and decode replies',async t=>{
  const g=createGame([{name:'AI',provider:'local'}])
  g.turn=1
  for(const id of Object.keys(providers)){
    g.players[1].provider=id
    const call=t.mock.method(globalThis,'fetch',async(url,init)=>{
      const body=JSON.parse(init.body)
      const prompt=id==='gemini'?body.contents[0].parts[0].text:body.messages[0].content
      const visible=JSON.parse(prompt.split('State: ')[1])
      assert.deepEqual(visible.hand.map(t=>t.id),g.players[1].hand)
      assert.deepEqual(Object.keys(visible).sort(),['board','counts','hand','opened','pool'])
      const answer='{"action":"draw"}'
      return Response.json(id==='gemini'?{candidates:[{content:{parts:[{text:answer}]}}]}:{choices:[{message:{content:answer}}]})
    })
    assert.deepEqual(await choose(g),{action:'draw'})
    call.mock.restore()
  }
})
