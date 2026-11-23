const beat=0.75
const score=[
  {bass:48, chord:[55,59,62,64], melody:[[0,76],[1.5,74],[2.5,71]]},
  {bass:47, chord:[55,59,62,67], melody:[[0.5,74],[2,71],[3,67]]},
  {bass:45, chord:[55,60,64,71], melody:[[0,72],[1.5,76],[2.5,79]]},
  {bass:43, chord:[55,60,64,69], melody:[[0.5,76],[2,72],[3,69]]},
  {bass:41, chord:[53,57,60,64], melody:[[0,72],[1,76],[2.5,77]]},
  {bass:40, chord:[55,59,62,64], melody:[[0,76],[1.5,74],[2.5,71]]},
  {bass:38, chord:[53,57,60,64], melody:[[0.5,69],[2,72],[3,76]]},
  {bass:43, chord:[53,57,59,62], melody:[[0,74],[1.5,71],[2.5,67]]}
]
const loopLength=score.length*4*beat
const effects={
  select:[[0,81,.045,.095,'sine'],[0,100,.023,.025,'triangle']],
  place:[[0,49,.09,.19,'triangle'],[0,85,.035,.055,'sine']],
  play:[[0,52,.11,.23,'triangle'],[0,88,.04,.075,'sine'],[.06,48,.13,.13,'triangle']],
  turn:[[0,76,.28,.13,'sine'],[.12,81,.38,.12,'triangle'],[.24,84,.48,.12,'sine']]
}

function note(output,time,pitch,length,volume,wave,attack=.005) {
  const context=output.context
  const voice=context.createOscillator()
  const envelope=context.createGain()
  voice.type=wave
  voice.frequency.value=440*2**((pitch-69)/12)
  envelope.gain.setValueAtTime(0,time)
  envelope.gain.linearRampToValueAtTime(volume,time+attack)
  envelope.gain.exponentialRampToValueAtTime(.0001,time+length)
  voice.connect(envelope).connect(output)
  voice.start(time)
  voice.stop(time+length)
}

async function renderMusic() {
  const sampleRate=22050
  const render=new OfflineAudioContext(1,2*loopLength*sampleRate,sampleRate)
  const piano=(time,pitch,volume,length)=>{
    note(render.destination,time,pitch,length,volume,'sine',.018)
    note(render.destination,time,pitch+12,length*.6,volume*.16,'triangle',.012)
  }
  // The first pass supplies the decaying notes that carry across the loop boundary.
  for (const offset of [0,loopLength]) {
    score.forEach(({bass,chord,melody},index)=>{
      const start=offset+index*4*beat
      piano(start,bass,.07,2.7)
      chord.forEach((pitch,i)=>piano(start+(i+.5)*beat,pitch,.042,1.6))
      melody.forEach(([at,pitch])=>piano(start+at*beat,pitch,.082,1.95))
    })
  }
  return render.startRendering()
}

let context, music, soundtrack
let inGame=false
const gains={}
const volumes={music:100,effects:100}

async function startMusic() {
  if (!volumes.music || !inGame || context?.state!=='running' || music) return
  soundtrack ??= renderMusic()
  const buffer=await soundtrack
  if (!volumes.music || !inGame || context.state!=='running' || music) return
  music=context.createBufferSource()
  music.buffer=buffer
  music.loop=true
  music.loopStart=loopLength
  music.connect(gains.music)
  music.start(0,loopLength)
}

export function setMusicActive(active) {
  inGame=active
  if (active) startMusic().catch(()=>{})
  else if (music) {
    music.stop()
    music.disconnect()
    music=null
  }
}

export function playSound(name,delay=0) {
  if (!volumes.effects || !context) return
  // A first tap can schedule a note while the audio context is still resuming.
  const start=context.currentTime+.01+delay
  for (const [offset,pitch,length,volume,wave] of effects[name])
    note(gains.effects,start+offset,pitch,length,volume,wave)
}

export function setupAudio(dialog) {
  function unlock() {
    try {
      if (!context) {
        context=new AudioContext()
        for (const channel of Object.keys(volumes)) {
          const gain=context.createGain()
          gain.gain.value=volumes[channel]/100
          gain.connect(context.destination)
          gains[channel]=gain
        }
      }
      if (context.state==='running') startMusic().catch(()=>{})
      else context.resume().then(startMusic).catch(()=>{})
    } catch {}
  }
  for (const slider of dialog.querySelectorAll('input[type="range"]')) {
    const channel=slider.name
    const output=dialog.querySelector('output[for="'+slider.id+'"]')
    const key='playrummi-volume-'+channel
    try {
      const fallback=localStorage.getItem('playrummi-muted')==='true'?0:100
      const saved=Number(localStorage.getItem(key) ?? fallback)
      if (Number.isInteger(saved) && saved>=0 && saved<=100) volumes[channel]=saved
    } catch {}
    const showVolume=()=>{
      output.value=volumes[channel]+'%'
      slider.setAttribute('aria-valuetext',output.value)
    }
    slider.value=volumes[channel]
    showVolume()
    slider.oninput=()=>{
      volumes[channel]=slider.valueAsNumber
      showVolume()
      unlock()
      if (gains[channel]) gains[channel].gain.setTargetAtTime(volumes[channel]/100,context.currentTime,.015)
    }
    slider.onchange=()=>{
      try { localStorage.setItem(key,slider.value) } catch {}
      if (channel==='effects') playSound('play')
    }
  }
  window.addEventListener('pointerdown',event=>{
    if (event.pointerType==='mouse' && event.button===0) unlock()
  },true)
  window.addEventListener('pointerup',event=>{
    if (event.pointerType!=='mouse') unlock()
  },true)
  window.addEventListener('keydown',unlock,true)
}
