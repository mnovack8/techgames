'use strict';

// Dependency injection — set by game-manager.js after shared state is defined
let _rooms, _broadcastToRoom, _trackEvent;
function init({ rooms, broadcastToRoom, trackEvent }) {
  _rooms = rooms;
  _broadcastToRoom = broadcastToRoom;
  _trackEvent = trackEvent;
}

// ==================== CLUSTERFLICK CONSTANTS ====================
const CF_ANIMALS = ['Frog','Fish','Rabbit','Dog','Bird','Squirrel'];
const CF_ROUNDS = 6;
const CF_FLICKS_PER_PLAYER = 5;
const CF_WIN_THRESHOLD = 8;
const CF_CX = 500, CF_CY = 500;
const CF_BOARD_R = 414;
const CF_UNCLASSIFIED_R = 107;
const CF_ANIMAL_CR = 258;
const CF_CR5 = 31, CF_CR3 = 66, CF_CR2 = 103;
const CF_ZONE_CIRCLES = (function(){
  const z=[];
  for(let a=0;a<6;a++){
    const ang=(a*60+30)*Math.PI/180;
    const cx=CF_CX+CF_ANIMAL_CR*Math.cos(ang), cy=CF_CY+CF_ANIMAL_CR*Math.sin(ang);
    z.push({x:cx,y:cy,r:CF_CR5,animalIdx:a,confidence:5});
    z.push({x:cx,y:cy,r:CF_CR3,animalIdx:a,confidence:3});
    z.push({x:cx,y:cy,r:CF_CR2,animalIdx:a,confidence:2});
  }
  return z;
})();
const CF_TOKEN_R = 18;
const CF_SQUARE_R = 20; // collision radius — covers full visual diamond (corners at ~14*√2≈20px)
const CF_FRICTION = 0.955;
const CF_BOUNCE = 0.60;
const CF_MAX_SPEED = 49;
const CF_FLICK_ZONES = [
  {x:175, y:825}, // Player 0 (bottom-left)
  {x:825, y:825}, // Player 1 (bottom-right)
  {x:825, y:175}, // Player 2 (top-right)
  {x:175, y:175}, // Player 3 (top-left)
];

// ==================== COLOR INFO (needed for broadcasting) ====================
const COLOR_INFO = {
  blue:   { hex: '#4a9eff', name: 'Blue' },
  red:    { hex: '#ff4a4a', name: 'Red' },
  green:  { hex: '#4aff8a', name: 'Green' },
  purple: { hex: '#c880ff', name: 'Purple' },
};

function cfGetZone(x,y) {
  const dx=x-CF_CX,dy=y-CF_CY,d=Math.hypot(dx,dy);
  if(d>CF_BOARD_R) return null;
  if(d<=CF_UNCLASSIFIED_R) return {animalIdx:-1,confidence:0};
  for(const z of CF_ZONE_CIRCLES){if(Math.hypot(x-z.x,y-z.y)<=z.r)return{animalIdx:z.animalIdx,confidence:z.confidence};}
  // On board but outside all target circles = 1pt, sector angle determines animal
  let ang=Math.atan2(dy,dx)*180/Math.PI;if(ang<0)ang+=360;
  return{animalIdx:Math.floor(ang/60)%6,confidence:1};
}

function cfSimulatePhysics(tokens, walls, sx, sy, vx, vy) {
  // walls = sampleSquares (immovable — tokens bounce off them, walls don't move)
  // moved=true means this object is part of the active chain (flicked or hit by it)
  // SUBSTEPS: split each frame into 3 mini-steps so fast tokens can't tunnel through
  // walls.  Max speed=49px/frame → 16px/substep, well under the 32px collision radius.
  if(walls.length>0) console.log(`[PHYSICS] starting with ${walls.length} wall(s):`, walls.map(w=>`(${w.x.toFixed(0)},${w.y.toFixed(0)})`).join(' '));
  let wallHits=0;
  const waypoints=[]; // Wall contact positions for objs[0] (used by client for path animation)
  const SUBSTEPS=3;
  const objs=[
    {x:sx,y:sy,vx,vy,r:CF_TOKEN_R,moved:true},
    ...tokens.map(t=>({x:t.x,y:t.y,vx:0,vy:0,r:CF_TOKEN_R,moved:false})),
  ];
  for(let f=0;f<600;f++){
    // Early-exit if nothing is moving
    let mv=false;
    for(const o of objs){if(Math.hypot(o.vx,o.vy)>=0.08)mv=true;}
    if(!mv)break;

    // ── substep loop: move + boundary + wall checks ──────────────────────────
    for(let sub=0;sub<SUBSTEPS;sub++){
      // Move each object by 1/SUBSTEPS of its velocity
      for(const o of objs){
        if(Math.hypot(o.vx,o.vy)<0.08)continue;
        o.x+=o.vx/SUBSTEPS; o.y+=o.vy/SUBSTEPS;
      }
      // Board boundary reflection (moving objects only)
      for(const o of objs){
        if(!o.moved)continue;
        const dx=o.x-CF_CX,dy=o.y-CF_CY,d=Math.hypot(dx,dy);
        if(d+o.r>CF_BOARD_R){
          const nx=dx/d,ny=dy/d;
          o.x=CF_CX+nx*(CF_BOARD_R-o.r); o.y=CF_CY+ny*(CF_BOARD_R-o.r);
          const dot=o.vx*nx+o.vy*ny;
          if(dot>0){o.vx-=(1+CF_BOUNCE)*dot*nx; o.vy-=(1+CF_BOUNCE)*dot*ny;
          o.vx*=CF_BOUNCE; o.vy*=CF_BOUNCE;}
        }
      }
      // Immovable wall (sample square) collisions — moving objects bounce off
      for(const o of objs){
        if(!o.moved)continue;
        for(const w of walls){
          const dx=o.x-w.x,dy=o.y-w.y,d=Math.hypot(dx,dy),minD=o.r+CF_SQUARE_R;
          if(d>=minD||d<0.001)continue;
          wallHits++;
          console.log(`[PHYSICS] Wall hit #${wallHits}: token=(${o.x.toFixed(1)},${o.y.toFixed(1)}) wall=(${w.x.toFixed(0)},${w.y.toFixed(0)}) d=${d.toFixed(1)} minD=${minD}`);
          const nx=dx/d,ny=dy/d;
          o.x=w.x+nx*minD; o.y=w.y+ny*minD;
          // Record contact point so client can animate along actual path
          if(o===objs[0]) waypoints.push({x:o.x,y:o.y});
          const dot=o.vx*nx+o.vy*ny;
          if(dot<0){o.vx-=(1+CF_BOUNCE)*dot*nx; o.vy-=(1+CF_BOUNCE)*dot*ny;}
        }
      }
    }
    // ── end substeps ─────────────────────────────────────────────────────────

    // Apply friction and hard-stop once per frame (not per substep)
    for(const o of objs){
      o.vx*=CF_FRICTION; o.vy*=CF_FRICTION;
      if(Math.hypot(o.vx,o.vy)<0.08){o.vx=0;o.vy=0;}
    }

    // Flicked token stops at contact and transfers its velocity to the hit token
    const f0=objs[0];
    if(Math.hypot(f0.vx,f0.vy)>0.01){
      for(let j=1;j<objs.length;j++){
        const b=objs[j];
        if(Math.hypot(b.vx,b.vy)>0.01)continue;
        const dx=f0.x-b.x,dy=f0.y-b.y,d=Math.hypot(dx,dy),minD=f0.r+b.r;
        if(d>=minD||d<0.001)continue;
        b.vx=f0.vx;b.vy=f0.vy;b.moved=true;
        f0.x=b.x+(dx/d)*minD;f0.y=b.y+(dy/d)*minD;
        f0.vx=0;f0.vy=0;
        break;
      }
    }
    // Knocked tokens hard-stop on contact — no further transfer
    for(let i=1;i<objs.length;i++){
      const m=objs[i];
      if(!m.moved||Math.hypot(m.vx,m.vy)<0.01)continue;
      for(let j=1;j<objs.length;j++){
        if(i===j)continue;
        const s=objs[j];
        const dx=m.x-s.x,dy=m.y-s.y,d=Math.hypot(dx,dy),minD=m.r+s.r;
        if(d>=minD||d<0.001)continue;
        m.x=s.x+(dx/d)*minD;m.y=s.y+(dy/d)*minD;
        m.vx=0;m.vy=0;
        break;
      }
    }
  }
  for(const o of objs){
    o.vx=0;o.vy=0;
    if(!o.moved)continue;
    const dx=o.x-CF_CX,dy=o.y-CF_CY,d=Math.hypot(dx,dy);
    if(d+o.r>CF_BOARD_R){o.x=CF_CX+(dx/d)*(CF_BOARD_R-o.r);o.y=CF_CY+(dy/d)*(CF_BOARD_R-o.r);}
  }
  if(walls.length>0) console.log(`[PHYSICS] done. Total wall hits: ${wallHits}. Token final pos: (${objs[0].x.toFixed(1)},${objs[0].y.toFixed(1)})`);
  return {objs,waypoints};
}

// ==================== CLUSTERFLICK GAME LOGIC ====================
function createCFGameState(numPlayers) {
  const da=[0,1,2,3,4,5];
  for(let i=da.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[da[i],da[j]]=[da[j],da[i]];}
  return {
    phase:'flicking',
    round:1,
    currentPlayer:0,
    flicksLeft:CF_FLICKS_PER_PLAYER,
    tokens:[],
    sampleSquares:[],
    nextSquareId:0,
    players:Array.from({length:numPlayers},(_,i)=>({
      _idx:i,
      confidence:[0,0,0,0,0,0],
      flicksThisRound:0,
      actionMode:'identify',
      unidentifiedFlickedThisRound:0,
      usedSampleThisRound:false,
    })),
    doubledAnimals:da,
    roundDoubledAnimal:da[0],
    nextTokenId:0,
    gameOver:false,
    winner:-1,
  };
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function cfAdvanceTurn(room) {
  const s=room.cfState;
  s.phase='flicking';
  // If every player has used all their flicks, end the round
  if(s.players.every(pl=>pl.flicksThisRound>=CF_FLICKS_PER_PLAYER)){cfScoreRound(room);return;}
  // Cycle to the next player who still has flicks remaining
  const n=room.players.length;
  do{s.currentPlayer=(s.currentPlayer+1)%n;}
  while(s.players[s.currentPlayer].flicksThisRound>=CF_FLICKS_PER_PLAYER);
  s.flicksLeft=CF_FLICKS_PER_PLAYER-s.players[s.currentPlayer].flicksThisRound;
  // Reset incoming player's action mode to identify at the start of their turn
  s.players[s.currentPlayer].actionMode='identify';
  if(room.players[s.currentPlayer].isBot)setTimeout(()=>executeCFBotTurn(room),800);
}

function cfScoreRound(room) {
  const s=room.cfState;
  const da=s.roundDoubledAnimal;
  for(const tok of s.tokens){
    if(!tok.active||tok.sampleConsumed||tok.animalIdx<0)continue;
    let conf=tok.confidence;
    // Square bonus: +1 per sample square in same confidence zone as token OR touching it
    let diceBonus=0;
    for(const sq of s.sampleSquares){
      if(sq.animalIdx!==tok.animalIdx)continue;
      const sz=cfGetZone(sq.x,sq.y);
      const tz=cfGetZone(tok.x,tok.y);
      if(sz&&tz&&sz.confidence===tz.confidence){diceBonus++;continue;}
      if(Math.hypot(tok.x-sq.x,tok.y-sq.y)<CF_TOKEN_R+CF_SQUARE_R+2)diceBonus++;
    }
    conf+=diceBonus;
    if(tok.animalIdx===da)conf*=2;
    s.players[tok.playerIdx].confidence[tok.animalIdx]+=conf;
  }
  // Check instant win
  for(let i=0;i<s.players.length;i++){
    if(s.players[i].confidence.every(c=>c>=CF_WIN_THRESHOLD)){s.gameOver=true;s.winner=i;cfEndGame(room);return;}
  }
  // Clear board for next round
  s.tokens=[];
  s.round++;
  if(s.round>CF_ROUNDS){cfEndGame(room);return;}
  s.roundDoubledAnimal=s.doubledAnimals[s.round-1];
  for(const pl of s.players){pl.flicksThisRound=0;}
  // Reset sample squares and per-round player fields
  s.sampleSquares=[];s.nextSquareId=0;delete s.placingInfo;
  for(const pl of s.players){pl.actionMode='identify';pl.unidentifiedFlickedThisRound=0;pl.usedSampleThisRound=false;}
  // First player rotates clockwise each round: round 1→player 0, round 2→player 1, etc.
  const firstOfRound=(s.round-1)%s.players.length;
  s.currentPlayer=firstOfRound;s.flicksLeft=CF_FLICKS_PER_PLAYER;s.phase='flicking';
  if(room.players[firstOfRound].isBot)setTimeout(()=>executeCFBotTurn(room),800);
}

function cfEndGame(room) {
  const s=room.cfState;
  s.gameOver=true;s.phase='game_over';
  if(s.winner<0){
    let best=-1,bestC=-1,bestT=-1;
    for(let i=0;i<s.players.length;i++){
      const pl=s.players[i],completed=pl.confidence.filter(c=>c>=CF_WIN_THRESHOLD).length,total=pl.confidence.reduce((a,b)=>a+b,0);
      if(completed>bestC||(completed===bestC&&total>bestT)){best=i;bestC=completed;bestT=total;}
    }
    s.winner=best;
  }
  const mode=room.players.some(p=>p.isBot)?'1p_bot':room.players.length===2?'2p':room.players.length===3?'3p':'4p';
  const dur=room.sessionStartedAt?Math.round((Date.now()-room.sessionStartedAt)/1000):null;
  _trackEvent('session_completed',{gameType:'clusterflick',mode,uvKey:room.uvKey||'',duration:dur});
}

function cfBroadcastState(room, flickWaypoints=null) {
  const s=room.cfState;
  const base={type:'state_update',code:room.code,state:{
    phase:s.phase,round:s.round,currentPlayer:s.currentPlayer,flicksLeft:s.flicksLeft,
    tokens:s.tokens,
    sampleSquares:s.sampleSquares,
    placingInfo:s.placingInfo,
    sampleReflickFor:s.sampleReflickFor,
    players:s.players.map((pl,i)=>({...pl,color:room.players[i].color,name:room.players[i].name,
      hex:COLOR_INFO[room.players[i].color].hex,connected:room.players[i].connected,isBot:!!room.players[i].isBot,
      actionMode:pl.actionMode})),
    roundDoubledAnimal:s.roundDoubledAnimal,doubledAnimals:s.doubledAnimals,gameOver:s.gameOver,winner:s.winner,
    flickWaypoints: flickWaypoints||null,  // wall-bounce path for client animation (null if no bounces)
  }};
  for(let i=0;i<room.players.length;i++){const p=room.players[i];if(p.connected&&p.ws)send(p.ws,{...base,yourId:i});}
  for(const o of(room.observers||[])){if(o.connected&&o.ws)send(o.ws,{...base,yourId:-1,isObserver:true});}
}

function processCFAction(room, playerIdx, msg) {
  const s=room.cfState;
  if(s.gameOver)return'Game is over';
  // For special phases, allow only the relevant player's action
  if(msg.action==='place_sample_square'){
    if(!s.placingInfo||s.placingInfo.playerIdx!==playerIdx)return'Not your placement';
  } else if(msg.action!=='skip_sample_reflick'&&msg.action!=='sample_reflick_token'){
    if(s.currentPlayer!==playerIdx)return'Not your turn';
  }
  const pl=s.players[playerIdx];

  switch(msg.action){
    case 'set_action_mode':{
      const{mode}=msg;
      if(mode!=='identify'&&mode!=='sample')return'Invalid mode';
      if(mode==='sample'&&pl.usedSampleThisRound)return'Already used Add Samples this round';
      pl.actionMode=mode;
      return null;
    }
    case 'flick_token':{
      if(s.phase!=='flicking')return'Wrong phase';
      if(pl.flicksThisRound>=CF_FLICKS_PER_PLAYER)return'No flicks left';
      const{angle,power}=msg;
      if(typeof angle!=='number'||typeof power!=='number')return'Invalid params';
      const pw=Math.max(0.05,Math.min(1.05,power));
      const fz=CF_FLICK_ZONES[playerIdx%4];
      const vx=Math.cos(angle)*pw*CF_MAX_SPEED,vy=Math.sin(angle)*pw*CF_MAX_SPEED;
      const actToks=s.tokens.filter(t=>t.active);
      const {objs,waypoints}=cfSimulatePhysics(actToks,s.sampleSquares,fz.x,fz.y,vx,vy);
      const nObj=objs[0];
      // Update tokens that were knocked
      for(let i=0;i<actToks.length;i++){const o=objs[i+1];if(!o||!o.moved)continue;actToks[i].x=o.x;actToks[i].y=o.y;const z=cfGetZone(o.x,o.y);if(z){actToks[i].animalIdx=z.animalIdx;actToks[i].confidence=z.confidence;}}
      const zone=cfGetZone(nObj.x,nObj.y)||{animalIdx:-1,confidence:0};
      pl.flicksThisRound++;
      room._lastFlickWaypoints=waypoints.length>0?waypoints:null;
      if(pl.actionMode==='sample'){
        if(zone.animalIdx>=0&&zone.confidence>=1){
          // Token lands in any animal zone (confidence 1-5) — slide it, then enter placing phase
          // Confidence 1 grants 1 square; higher confidence grants that many squares
          const squaresToPlace=zone.confidence;
          const tokId=s.nextTokenId++;
          s.tokens.push({id:tokId,playerIdx,x:nObj.x,y:nObj.y,animalIdx:zone.animalIdx,confidence:zone.confidence,active:true,sampleConsumed:true});
          s.phase='placing_samples';
          s.placingInfo={playerIdx,animalIdx:zone.animalIdx,squaresLeft:squaresToPlace,tokenId:tokId};
          pl.usedSampleThisRound=true;
        } else {
          // Landed in unclassified zone or off-board — no squares, no reflick
          cfAdvanceTurn(room);
        }
        return null;
      } else {
        // identify mode
        s.tokens.push({id:s.nextTokenId++,playerIdx,x:nObj.x,y:nObj.y,animalIdx:zone.animalIdx,confidence:zone.confidence,active:true});
        pl.unidentifiedFlickedThisRound++;
        cfAdvanceTurn(room);
        return null;
      }
    }
    case 'place_sample_square':{
      if(s.phase!=='placing_samples')return'Wrong phase';
      if(!s.placingInfo||s.placingInfo.playerIdx!==playerIdx)return'Not your placement';
      const{x,y}=msg;
      if(typeof x!=='number'||typeof y!=='number')return'Invalid position';
      // Validate inside the animal circle (within CF_CR2 of the animal zone centre)
      const ang=(s.placingInfo.animalIdx*60+30)*Math.PI/180;
      const acx=CF_CX+CF_ANIMAL_CR*Math.cos(ang),acy=CF_CY+CF_ANIMAL_CR*Math.sin(ang);
      if(Math.hypot(x-acx,y-acy)>CF_CR2-CF_SQUARE_R-2)return'Outside animal zone';
      // Prevent overlap with existing squares and active tokens
      const tooClose=[...s.sampleSquares,...s.tokens.filter(t=>t.active&&!t.sampleConsumed)].some(o=>{
        const r=o.animalIdx!==undefined&&o.confidence!==undefined&&o.active!==undefined?CF_TOKEN_R:CF_SQUARE_R;
        return Math.hypot(x-o.x,y-o.y)<CF_SQUARE_R+r+2;
      });
      if(tooClose)return'Too close to another piece';
      s.sampleSquares.push({id:s.nextSquareId++,x,y,animalIdx:s.placingInfo.animalIdx});
      s.placingInfo.squaresLeft--;
      if(s.placingInfo.squaresLeft<=0){
        // Remove the consumed token
        const consumedTok=s.tokens.find(t=>t.id===s.placingInfo.tokenId);
        if(consumedTok)consumedTok.active=false;
        const placingPlayer=s.placingInfo.playerIdx;
        const placingPl=s.players[placingPlayer];
        delete s.placingInfo;
        // Offer reflick if this player has any identified tokens on the board
        const hasIdentified=s.tokens.some(t=>t.active&&!t.sampleConsumed&&t.playerIdx===placingPlayer);
        if(hasIdentified&&placingPl.unidentifiedFlickedThisRound>0){
          s.phase='sample_reflick';
          s.sampleReflickFor=placingPlayer;
        } else {
          cfAdvanceTurn(room);
        }
      }
      return null;
    }
    case 'skip_sample_reflick':{
      if(s.phase!=='sample_reflick')return'Wrong phase';
      if(s.sampleReflickFor!==playerIdx)return'Not your reflick';
      s.phase='flicking';
      delete s.sampleReflickFor;
      cfAdvanceTurn(room);
      return null;
    }
    case 'sample_reflick_token':{
      if(s.phase!=='sample_reflick')return'Wrong phase';
      if(s.sampleReflickFor!==playerIdx)return'Not your reflick';
      const{angle,power,tokenId}=msg;
      const tok=s.tokens.find(t=>t.id===tokenId&&t.playerIdx===playerIdx&&t.active&&!t.sampleConsumed);
      if(!tok)return'Invalid token';
      // Remove the old token from the board — it was "picked up"
      tok.active=false;
      const pw=Math.max(0.05,Math.min(1.05,power));
      const fz=CF_FLICK_ZONES[playerIdx%4];
      const vx=Math.cos(angle)*pw*CF_MAX_SPEED,vy=Math.sin(angle)*pw*CF_MAX_SPEED;
      // Physics identical to identify flick: all remaining active tokens are obstacles
      const actToks=s.tokens.filter(t=>t.active);
      const {objs,waypoints}=cfSimulatePhysics(actToks,s.sampleSquares,fz.x,fz.y,vx,vy);
      const nObj=objs[0];
      // Update knocked tokens (same as flick_token identify path)
      for(let i=0;i<actToks.length;i++){const o=objs[i+1];if(!o||!o.moved)continue;actToks[i].x=o.x;actToks[i].y=o.y;const z=cfGetZone(o.x,o.y);if(z){actToks[i].animalIdx=z.animalIdx;actToks[i].confidence=z.confidence;}}
      // Add the re-flicked token as a brand-new token so the client animates it from the flick zone
      const zone=cfGetZone(nObj.x,nObj.y)||{animalIdx:-1,confidence:0};
      s.tokens.push({id:s.nextTokenId++,playerIdx,x:nObj.x,y:nObj.y,animalIdx:zone.animalIdx,confidence:zone.confidence,active:true});
      room._lastFlickWaypoints=waypoints.length>0?waypoints:null;
      s.phase='flicking';
      delete s.sampleReflickFor;
      cfAdvanceTurn(room);
      return null;
    }
    default:return'Unknown action';
  }
}

// ==================== CLUSTERFLICK BOT ====================
function cfBotDecideFlick(room) {
  const s=room.cfState,botIdx=s.currentPlayer,pl=s.players[botIdx];
  const fz=CF_FLICK_ZONES[botIdx%4];
  // Only target animals not yet at the win threshold; fall back to any lowest if all done
  const needsWork=Array.from({length:6},(_,a)=>a).filter(a=>pl.confidence[a]<CF_WIN_THRESHOLD);
  const pool=needsWork.length>0?needsWork:Array.from({length:6},(_,a)=>a);
  let tgtAnimal=pool[0],minC=pl.confidence[pool[0]];
  for(const a of pool){if(pl.confidence[a]<minC){minC=pl.confidence[a];tgtAnimal=a;}}
  const confOpts=[5,3,2];
  const tgtConf=confOpts[Math.floor(Math.random()*3)];
  const confToOffset={5:0,3:(CF_CR3+CF_CR5)/2,2:(CF_CR2+CF_CR3)/2};
  const zoneR=CF_ANIMAL_CR+(confToOffset[tgtConf]||0);
  const animalAng=(tgtAnimal*60+30)*Math.PI/180;
  const tx=CF_CX+Math.cos(animalAng)*zoneR,ty=CF_CY+Math.sin(animalAng)*zoneR;
  const baseAng=Math.atan2(ty-fz.y,tx-fz.x);
  return{angle:baseAng+(Math.random()-0.5)*0.45,power:0.45+Math.random()*0.45};
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function executeCFBotTurn(room) {
  const s=room.cfState;
  const botIdx=s.currentPlayer;
  if(!room.players[botIdx]?.isBot||s.gameOver||s.phase!=='flicking')return;
  if(room._cfBotRunning)return;
  room._cfBotRunning=true;
  try{
    await delay(800+Math.random()*600);
    if(s.currentPlayer===botIdx&&s.phase==='flicking'&&!s.gameOver){
      const{angle,power}=cfBotDecideFlick(room);
      processCFAction(room,botIdx,{action:'flick_token',angle,power});
      cfBroadcastState(room,room._lastFlickWaypoints||null);
      room._lastFlickWaypoints=null;
    }
  }finally{
    room._cfBotRunning=false;
  }
}

module.exports = {
  init,
  createCFGameState,
  processCFAction,
  cfBroadcastState,
  cfAdvanceTurn,
  executeCFBotTurn,
};
