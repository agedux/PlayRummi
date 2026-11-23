import {colors,tile,points,splitMelds} from '/rules.js'
import {readLines} from '/lines.js'
const $ = id => document.getElementById(id)
const el = (tag,text,cls) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (cls) node.className = cls
  return node
}
function btn(label,fn,cls) {
  const b = el('button',label,cls)
  b.onclick = fn
  return b
}
let game, options=[], board=[], selected=[], byValue=false, busy=false, error='', aiTimer
let rackOrder=[], drag=null, playback=null
let waiting=null
const speechWindowMs=4000
const dialogue=new Map()
function paintSpeech(seat) {
  const node=$('speech-'+seat)
  if (node) node.replaceChildren(...dialogue.get(seat).lines.map(text=>el('span',text)))
}
function say(seat,text) {
  const previous=dialogue.get(seat)
  const now=performance.now()
  const lines=previous && now-previous.time<speechWindowMs ? [...previous.lines,text] : [text]
  clearTimeout(previous?.timer)
  const entry={time:now,lines}
  dialogue.set(seat,entry)
  paintSpeech(seat)
  if (lines.length>1) entry.timer=setTimeout(()=>{
    entry.lines=[text]
    paintSpeech(seat)
  },speechWindowMs)
}
function actionLine(action) {
  if (action.startsWith('逾時，')) return action.endsWith('過牌')?'時間到了，牌池已空，這手過。':'時間到了，我摸一張。'
  return action==='摸了一張牌'?'我先摸一張。':action==='過牌'?'這手先過。':'這手'+action+'！'
}
function elapsed() {
  const seconds=Math.floor((performance.now()-waiting.start)/1000)
  return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')
}
function accept(next) {
  if (game?.id!==next?.id) {
    rackOrder=[]
    for (const entry of dialogue.values()) clearTimeout(entry.timer)
    dialogue.clear()
  }
  game=next
  board=structuredClone(game?.board || [])
  selected=[]
  error=''
}
const myTurn = () => game && !game.result && game.turn===0 && !busy
const dirty = () => JSON.stringify(board)!==JSON.stringify(game?.board)
async function post(path,extra={}) {
  const response = await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',Accept:path==='ai'?'application/x-ndjson':'application/json'},
    body:JSON.stringify({id:game?.id??null,revision:game?.revision??null,...extra})})
  if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
    for await (const line of readLines(response.body)) {
      if (!line) continue
      const message=JSON.parse(line)
      if (message.error) throw Error(message.error)
      if (message.game) return message.game
      if (message.phase && waiting) {
        const phrases={
          started:'輪到我啦。',
          thinking:game.players[game.turn].opened?'讓我看看，哪裡能接牌…':'破冰要湊 30 分，讓我算算…',
          answering:'想好了，這手我決定了。'
        }
        const phrase=phrases[message.phase]
        if (phrase) say(game.turn,phrase)
      }
    }
    throw Error('連線中斷，請重新整理以確認牌局')
  }
  const data = await response.json()
  if (!response.ok) throw Error(data.error)
  return data
}
async function act(path,extra) {
  if (busy) return
  clearTimeout(aiTimer)
  busy=true
  error=''
  if (path==='ai') {
    clearTimeout(dialogue.get(game.turn)?.timer)
    dialogue.delete(game.turn)
  }
  if (path==='ai' && game.players[game.turn].provider!=='local') {
    waiting={id:crypto.randomUUID(),start:performance.now()}
    extra={...extra,requestId:waiting.id}
  }
  render()
  const clock=waiting && setInterval(()=>{
    const timer=$('elapsed')
    if (timer && waiting) timer.textContent=elapsed()
  },500)
  try {
    const next=await post(path,extra)
    waiting=null
    try {
      if (path==='ai') {
        await showTurn(next)
        say(game.turn,actionLine(next.log.at(-1).slice(game.players[game.turn].name.length+1)))
      }
    }
    finally { playback=null; accept(next) }
    $('lobby').close()
  }
  catch(e) { error=e.message; if ($('lobby').open) $('lobbyNote').textContent=error }
  finally { clearInterval(clock); waiting=null; busy=false; render() }
  if (game && !game.result && game.turn && !error) scheduleAI()
}
function scheduleAI() {
  clearTimeout(aiTimer)
  if (!$('lobby').open && !$('settingsDialog').open) aiTimer=setTimeout(()=>act('ai'),850)
}
async function showTurn(next) {
  const existing=new Set(game.board.flat())
  const added=next.board.flat().filter(id=>!existing.has(id))
  if (!added.length) return
  const actor=game.players[game.turn]
  const freshGroup=next.board.find(row=>row.every(id=>!existing.has(id)))
  let remark='這樣排，就能再放 '+added.length+' 張！'
  if (!actor.opened) {
    const score=next.board.filter(row=>row.every(id=>!existing.has(id))).reduce((n,row)=>n+points(row),0)
    remark=score+' 分，破冰！'
  } else if (freshGroup) {
    const faces=freshGroup.map(tile).filter(t=>!t.joker)
    remark=faces.every(t=>t.value===faces[0].value)?'湊一組 '+faces[0].value+'！':colors[faces[0].color]+'色順子，上桌！'
  }
  say(game.turn,remark)
  playback={remaining:new Set(added),count:actor.count}
  const oldPositions=new Map([...$('board').querySelectorAll('[data-id]')].map(node=>[node.dataset.id,node.getBoundingClientRect()]))
  board=next.board
  render()
  const duration=matchMedia('(prefers-reduced-motion: reduce)').matches?0:360
  for (const node of $('board').querySelectorAll('[data-id]')) {
    const from=oldPositions.get(node.dataset.id)
    if (from && duration) {
      const to=node.getBoundingClientRect()
      node.animate([{transform:'translate('+(from.x-to.x)+'px,'+(from.y-to.y)+'px)'},{transform:'none'}],{duration})
    }
  }
  for (const id of added) {
    await new Promise(resolve=>setTimeout(resolve,duration?200:80))
    const node=$('board').querySelector('[data-id="'+id+'"]')
    const source=$('seats').children[game.turn-1].querySelector('.avatar').getBoundingClientRect()
    const target=node.getBoundingClientRect()
    playback.remaining.delete(id)
    playback.count--
    node.classList.remove('pending')
    $('seats').children[game.turn-1].querySelector('.amount').textContent=playback.count+' 張'
    if (duration) await node.animate([
      {transform:'translate('+(source.x+source.width/2-target.x-target.width/2)+'px,'+(source.y+source.height/2-target.y-target.height/2)+'px) rotate(-9deg) scale(.7)',opacity:.5},
      {transform:'none',opacity:1}
    ],{duration,easing:'cubic-bezier(.2,.65,.25,1)'}).finished
  }
}
function rackIds() {
  const inPlay=new Set(board.flat())
  const rack=[...(game?.hand||[]),...(game?.board.flat()||[])].filter(id=>!inPlay.has(id))
  rack.sort((a,b)=>{
    const x=tile(a),y=tile(b)
    return Number(x.joker)-Number(y.joker) || (byValue?x.value-y.value || x.color-y.color:x.color-y.color || x.value-y.value)
  })
  return [...rackOrder.filter(id=>rack.includes(id)),...rack.filter(id=>!rackOrder.includes(id))]
}
function moveTo(index,position) {
  if (!myTurn() || !selected.length) return
  const original=index==='rack'?rackIds():board[index]||[]
  if (index!=='new' && index!=='rack' && !game.players[0].opened && original.some(id=>game.board.flat().includes(id))) {
    error='破冰前只能使用自己的手牌'; render(); return
  }
  const offset=original.slice(0,position??original.length).filter(id=>!selected.includes(id)).length
  const rows=board.map(row=>row.filter(id=>!selected.includes(id)))
  if (index==='new') rows.push([...selected])
  else if (index==='rack') {
    rackOrder=original.filter(id=>!selected.includes(id))
    rackOrder.splice(offset,0,...selected)
  } else {
    rows[index].splice(offset,0,...selected)
    rows.splice(index,1,...splitMelds(rows[index]))
  }
  board=rows.filter(row=>row.length)
  selected=[]
  error=''
  render()
}
function piece(id,onBoard) {
  const t=tile(id)
  const b=btn(t.joker?'★':String(t.value),()=>{
    if (!myTurn()) return
    if (onBoard && !game.players[0].opened && game.board.flat().includes(id)) {
      error='破冰前只能使用自己的手牌'; render(); return
    }
    selected=selected.includes(id)?selected.filter(x=>x!==id):[...selected,id]
    error=''
    render()
  },'tile c'+t.color)
  const name=t.joker?'百搭':colors[t.color]
  b.dataset.id=id
  b.title=name+(t.joker?'':t.value)
  b.classList.toggle('pending',!!playback?.remaining.has(id))
  b.setAttribute('aria-label',name+(t.joker?'':t.value))
  b.setAttribute('aria-pressed',String(selected.includes(id)))
  b.classList.toggle('pick',selected.includes(id))
  b.classList.toggle('changed',onBoard && game.changed.includes(id))
  return b
}
function render() {
  const live=myTurn()
  $('setup').disabled=busy
  $('sort').disabled=busy
  $('start').disabled=busy
  $('history').disabled=!game
  $('pool').textContent=game?.pool??'—'
  $('seats').replaceChildren(...(game?.players.slice(1)||[]).map((s,i)=>{
    const active=!game.result && i+1===game.turn
    const seat=el('div',undefined,'seat'+(active?' active':''))
    const avatar=el('span',undefined,'avatar bot bot'+i)
    avatar.append(el('i',undefined,'face'))
    avatar.setAttribute('aria-hidden','true')
    seat.append(avatar,el('strong',s.name),el('span',((active && playback)?playback.count:s.count)+' 張','amount'))
    const status=el('div',undefined,'opponent-status')
    const speech=el('div',undefined,'speech-lines')
    speech.id='speech-'+(i+1)
    speech.setAttribute('aria-live','polite')
    const entry=dialogue.get(i+1)
    if (entry) speech.append(...entry.lines.map(text=>el('span',text)))
    if (active && waiting) {
      const timer=el('span',elapsed())
      timer.id='elapsed'
      timer.setAttribute('role','timer')
      status.append(speech,timer)
    } else if (active && error) {
      status.append(el('span',error),btn('重試回合',()=>act('ai')))
    } else if (entry) {
      status.append(speech)
    } else {
      // Each completed turn adds one log entry in seat order, even for namesakes.
      const last=game.log.findLast((_,index)=>index%game.players.length===i+1)
      if (last) {
        const action=last.slice(s.name.length+1)
        status.textContent=actionLine(action)
      }
    }
    if (status.hasChildNodes()) seat.append(status)
    return seat
  }))
  $('board').replaceChildren(...board.map((row,i)=>{
    const group=el('div',undefined,'group'+(points(row)?'':' bad'))
    group.dataset.row=i
    group.append(...row.map(id=>piece(id,true)))
    return group
  }))
  if (!board.length) {
    const empty=el('div',undefined,'empty')
    const motif=el('div',undefined,'motif')
    motif.setAttribute('aria-hidden','true')
    motif.append(...['7','8','9'].map(n=>el('i',n)))
    empty.append(motif,el('span',game?'等待第一組牌':'開一桌拉密'))
    $('board').append(empty)
  }
  const rack=rackIds()
  $('hand').replaceChildren(...rack.map(id=>piece(id,false)))
  $('count').textContent=game?rack.length+' 張':''
  $('sort').textContent=byValue?'依花色排列':'依數字排列'
  $('feedback').textContent=game?.result || (!game?.turn ? error : '')
  const actions=$('actions')
  actions.replaceChildren()
  if (!game || game.result) actions.append(btn('開新桌',openSetup,'primary'))
  else if (live) {
    const undo=btn('還原',()=>{accept(game);render()})
    undo.disabled=!dirty()&&!selected.length
    const draw=btn(game.pool?'摸一張':'過牌',()=>act('move',{move:{action:'draw'}}))
    draw.disabled=dirty()
    const submit=btn('完成回合',()=>act('move',{move:{action:'play',board}}),'primary')
    submit.disabled=!dirty()
    actions.append(undo,draw,submit)
  }
}
// Pointer capture keeps mouse, pen and touch on the same drag path.
document.addEventListener('pointerdown',event=>{
  const node=event.target.closest('.tile')
  if (!node || !myTurn() || drag || event.button!==0 || !event.isPrimary) return
  const id=Number(node.dataset.id)
  if (!game.players[0].opened && game.board.flat().includes(id)) return
  drag={pointer:event.pointerId,node,id,x:event.clientX,y:event.clientY,ghost:null,mark:null}
  node.setPointerCapture(event.pointerId)
})
function dropTarget(x,y) {
  const under=document.elementFromPoint(x,y)
  const group=under?.closest('.group')
  const rack=under?.closest('.rack')
  if (!group && !rack) return under?.closest('.felt')?{index:'new',mark:$('board')}:null
  const index=rack?'rack':Number(group.dataset.row)
  if (group && !game.players[0].opened && board[index].some(id=>game.board.flat().includes(id))) return null
  let node=under.closest('.tile')
  if (!node && group) {
    // The gap between adjacent tiles is also an insertion target.
    let nearest=Infinity
    for (const candidate of group.children) {
      const rect=candidate.getBoundingClientRect()
      const distance=Math.hypot(Math.max(rect.left-x,0,x-rect.right), Math.max(rect.top-y,0,y-rect.bottom))
      if (distance<nearest) { nearest=distance; node=candidate }
    }
  }
  if (!node) return {index,mark:group||rack}
  const row=rack?rackIds():board[index]
  const rect=node.getBoundingClientRect()
  const after=x>=rect.left+rect.width/2
  return {index,position:row.indexOf(Number(node.dataset.id))+Number(after),mark:node,side:after?'right':'left'}
}
function clearMark() {
  drag.mark?.classList.remove('dropzone','before','after')
}
document.addEventListener('pointermove',event=>{
  if (!drag || event.pointerId!==drag.pointer) return
  if (!drag.ghost) {
    if (Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<5) return
    drag.ids=selected.includes(drag.id)?[...selected]:[drag.id]
    drag.ghost=el('div',undefined,'drag-ghost')
    for (const id of drag.ids) {
      const node=document.querySelector('[data-id="'+id+'"]')
      node.classList.add('lifting')
      drag.ghost.append(node.cloneNode(true))
    }
    document.body.append(drag.ghost)
    const grabbed=drag.ghost.children[drag.ids.indexOf(drag.id)].getBoundingClientRect()
    drag.anchorX=grabbed.left+grabbed.width/2
    drag.anchorY=grabbed.top+grabbed.height/2
  }
  drag.ghost.style.transform='translate('+(event.clientX-drag.anchorX)+'px,'+(event.clientY-drag.anchorY)+'px)'
  clearMark()
  const target=dropTarget(event.clientX,event.clientY)
  drag.mark=target?.mark
  drag.mark?.classList.add(target.side==='right'?'after':target.side==='left'?'before':'dropzone')
})
function endDrag(event) {
  if (!drag || event.pointerId!==drag.pointer) return
  const {ghost,ids}=drag
  clearMark()
  drag=null
  if (!ghost) return
  ghost.remove()
  document.querySelectorAll('.lifting').forEach(node=>node.classList.remove('lifting'))
  if (event.type!=='pointerup') return
  // A captured pointer also dispatches a click on its source after release.
  const suppress=click=>{click.preventDefault();click.stopImmediatePropagation()}
  document.addEventListener('click',suppress,{capture:true,once:true})
  setTimeout(()=>document.removeEventListener('click',suppress,true),0)
  const target=dropTarget(event.clientX,event.clientY)
  if (target) { selected=ids;moveTo(target.index,target.position) }
}
document.addEventListener('pointerup',endDrag)
document.addEventListener('pointercancel',endDrag)
document.addEventListener('lostpointercapture',endDrag)
function fillSeats(previous=[]) {
  $('choices').replaceChildren()
  for (let i=0;i<3;i++) {
    const label=el('label','對手 '+(i+1))
    const select=el('select')
    select.add(new Option('空席',''))
    select.add(new Option('本機練習','local'))
    for (const o of options) {
      const opt=new Option(o.name+' · '+(o.ready?o.model:'未設金鑰'),o.id)
      opt.disabled=!o.ready
      select.add(opt)
    }
    select.value=previous[i] ?? (options[i]?.ready?options[i].id:'local')
    label.append(select)
    $('choices').append(label)
  }
}
function openSetup() {
  if (busy) return
  clearTimeout(aiTimer)
  fillSeats()
  $('lobbyNote').textContent=game&&!game.result?'洗牌開局將取代目前存檔。':''
  $('lobby').showModal()
}
$('setup').onclick=openSetup
const modelChoices = {
  deepseek:['deepseek-flash','deepseek-v4-pro'],
  openai:['gpt-4.1-mini','gpt-4.1'],
  gemini:['gemini-2.5-flash','gemini-2.5-pro']
}
function showProvider() {
  const option=options.find(o=>o.id===$('provider').value)
  $('timeoutLabel').hidden=option.id!=='deepseek'
  $('timeoutMinutes').value=option.timeoutMinutes??5
  $('apiKey').value=''
  $('apiKey').placeholder=option.ready?'已設定，留白可保留':'輸入 API 金鑰'
  $('model').replaceChildren()
  for (const model of new Set([option.model,...modelChoices[option.id]]))
    $('model').add(new Option(model,model))
  $('model').add(new Option('自訂模型…',''))
  $('customModel').value=''
  $('model').onchange()
  $('settingsStatus').textContent=''
}
function openSettings() {
  if (!options.length) return
  clearTimeout(aiTimer)
  $('provider').replaceChildren(...options.map(o=>new Option(o.name,o.id)))
  showProvider()
  $('settingsDialog').showModal()
}
$('aiSettings').onclick=$('lobbySettings').onclick=openSettings
$('provider').onchange=showProvider
$('model').onchange=()=>{
  const custom=$('model').value===''
  $('customLabel').hidden=!custom
  $('customModel').required=custom
}
$('settingsDialog').onclose=()=>{
  $('apiKey').value=''
  if(game?.turn && !game.result && !error && !busy) scheduleAI()
}
$('settingsForm').onsubmit=async event=>{
  event.preventDefault()
  const provider=$('provider').value
  const model=($('model').value || $('customModel').value).trim()
  const apiKey=$('apiKey').value.trim()
  const previous=[...$('choices').querySelectorAll('select')].map(s=>s.value)
  const controls=[...$('settingsForm').elements]
  controls.forEach(control=>control.disabled=true)
  try {
    const timeout=provider==='deepseek'?{timeoutMinutes:$('timeoutMinutes').valueAsNumber}:{}
    const data=await post('settings',{provider,model,...timeout,...(apiKey?{apiKey}:{})})
    options=data.options
    showProvider()
    $('settingsStatus').textContent=options.find(o=>o.id===provider).name+' 設定已儲存。'
    if ($('lobby').open) fillSeats(previous)
  } catch(e) { $('settingsStatus').textContent=e.message }
  finally { controls.forEach(control=>control.disabled=false) }
}
$('start').onclick=()=>{
  const seats=[...$('choices').querySelectorAll('select')].map(s=>s.value).filter(Boolean)
  if (!seats.length) { $('lobbyNote').textContent='請至少選一位對手'; return }
  act('new',{seats})
}
$('lobby').onclose=()=>{if(game?.turn && !game.result && !busy && !error) scheduleAI()}
$('sort').onclick=()=>{rackOrder=[];byValue=!byValue;render()}
$('history').onclick=()=>{
  $('logs').replaceChildren(...(game.log.length?game.log:['牌局剛開始']).map(line=>el('li',line)))
  $('journal').showModal()
}
try {
  const state=await (await fetch('/api/state')).json()
  options=state.options
  accept(state.game)
  render()
  if (!game) openSetup()
  else if (game.turn && !game.result) scheduleAI()
} catch(e) { $('feedback').textContent='無法讀取牌局，請重新整理。'+e.message }
