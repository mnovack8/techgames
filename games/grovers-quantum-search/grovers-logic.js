'use strict';

// ==================== NUMBER PROPERTIES ====================

function longestRun(bits, val) {
  let max = 0, cur = 0;
  for (const b of bits) {
    if (b === val) { cur++; if (cur > max) max = cur; }
    else cur = 0;
  }
  return max;
}

function countBlocks(bits, val) {
  let blocks = 0, inBlock = false;
  for (const b of bits) {
    if (b === val) { if (!inBlock) { blocks++; inBlock = true; } }
    else inBlock = false;
  }
  return blocks;
}

function buildNum(n) {
  const binary        = n.toString(2).padStart(8, '0');
  const bits          = binary.split('').map(Number); // bits[0] = MSB = bit 1
  const digitSum      = String(n).split('').reduce((s, d) => s + +d, 0);
  const bitCount      = bits.reduce((s, b) => s + b, 0);
  const upperNibble   = Math.floor(n / 16);
  const lowerNibble   = n % 16;
  const upperBitCount = bits[0]+bits[1]+bits[2]+bits[3];
  const lowerBitCount = bits[4]+bits[5]+bits[6]+bits[7];
  const maxRun1       = longestRun(bits, 1);
  const maxRun0       = longestRun(bits, 0);
  const blocks1       = countBlocks(bits, 1);
  const blocks0       = countBlocks(bits, 0);
  return { n, binary, bits, digitSum, bitCount, upperNibble, lowerNibble, upperBitCount, lowerBitCount, maxRun1, maxRun0, blocks1, blocks0 };
}

const NUMS = [];
for (let i = 0; i < 256; i++) NUMS.push(buildNum(i));

// ==================== CLUE DATABASE ====================
// 70 clues across 11 categories. Each clue: { id, text, test, matchingNumbers }

function buildClue(id, text, testFn) {
  const matchingNumbers = NUMS.filter(x => testFn(x)).map(x => x.n);
  return { id, text, test: testFn, matchingNumbers };
}

const CLUES = (() => {
  const clues = [];

  // ── Decimal Range — always exactly 2 quarters ────────────────────────────
  const quarterPairs = [
    [0,63,   64,127],
    [0,63,  128,191],
    [0,63,  192,255],
    [64,127, 128,191],
    [64,127, 192,255],
    [128,191, 192,255],
  ];
  for (const [lo1,hi1,lo2,hi2] of quarterPairs) {
    clues.push(buildClue(clues.length+1,
      `The number is in ${lo1}–${hi1} or ${lo2}–${hi2}.`,
      x => (x.n >= lo1 && x.n <= hi1) || (x.n >= lo2 && x.n <= hi2)
    ));
  }

  // ── Even / Odd + Divisibility ─────────────────────────────────────────────
  clues.push(buildClue(clues.length+1, 'The number is even.',            x => x.n % 2 === 0));
  clues.push(buildClue(clues.length+1, 'The number is odd.',             x => x.n % 2 !== 0));
  clues.push(buildClue(clues.length+1, 'The number is divisible by 3.',  x => x.n % 3 === 0));
  clues.push(buildClue(clues.length+1, 'The number is divisible by 4.',  x => x.n % 4 === 0));
  clues.push(buildClue(clues.length+1, 'The number is divisible by 5.',  x => x.n % 5 === 0));

  // ── Digit Sum ─────────────────────────────────────────────────────────────
  clues.push(buildClue(clues.length+1, 'The decimal digit sum is 0–9.',   x => x.digitSum <= 9));
  clues.push(buildClue(clues.length+1, 'The decimal digit sum is 10–18.', x => x.digitSum >= 10 && x.digitSum <= 18));
  clues.push(buildClue(clues.length+1, 'The decimal digit sum is 19+.',   x => x.digitSum >= 19));

  // ── Bit Count (2–6 ones) ─────────────────────────────────────────────────
  for (let k = 2; k <= 6; k++) {
    clues.push(buildClue(clues.length+1,
      `The number has exactly ${k} ones in binary.`,
      x => x.bitCount === k
    ));
  }

  // ── Bit Position (bits 1–7 from left; bit 8 = LSB = even/odd, omitted) ──
  for (let n = 1; n <= 7; n++) {
    for (const v of [1, 0]) {
      clues.push(buildClue(clues.length+1,
        `Bit ${n} (from the left) of the 8-bit binary is ${v}.`,
        x => x.bits[n-1] === v
      ));
    }
  }

  // ── Nibble ────────────────────────────────────────────────────────────────
  clues.push(buildClue(clues.length+1, 'The upper nibble value (first 4 bits, 0–15) is greater than the lower nibble value (last 4 bits).', x => x.upperNibble > x.lowerNibble));
  clues.push(buildClue(clues.length+1, 'The upper nibble value (first 4 bits, 0–15) is less than the lower nibble value (last 4 bits).',    x => x.upperNibble < x.lowerNibble));
  clues.push(buildClue(clues.length+1, 'The upper nibble value (first 4 bits) equals the lower nibble value (last 4 bits).',                 x => x.upperNibble === x.lowerNibble));
  clues.push(buildClue(clues.length+1, 'The upper nibble value (first 4 bits, 0–15) is even.',                                               x => x.upperNibble % 2 === 0));
  clues.push(buildClue(clues.length+1, 'The upper nibble value (first 4 bits, 0–15) is odd.',                                                x => x.upperNibble % 2 !== 0));
  clues.push(buildClue(clues.length+1, 'The lower nibble value (last 4 bits, 0–15) is even.',                                                x => x.lowerNibble % 2 === 0));
  clues.push(buildClue(clues.length+1, 'The lower nibble value (last 4 bits, 0–15) is odd.',                                                 x => x.lowerNibble % 2 !== 0));

  // ── Dominant Half ─────────────────────────────────────────────────────────
  clues.push(buildClue(clues.length+1, 'The upper half (bits 1–4) has more 1s than the lower half (bits 5–8).',         x => x.upperBitCount > x.lowerBitCount));
  clues.push(buildClue(clues.length+1, 'The lower half (bits 5–8) has more 1s than the upper half (bits 1–4).',         x => x.lowerBitCount > x.upperBitCount));
  clues.push(buildClue(clues.length+1, 'The upper half (bits 1–4) and lower half (bits 5–8) have equal count of 1s.',  x => x.upperBitCount === x.lowerBitCount));
  clues.push(buildClue(clues.length+1, 'The count of 1s in the upper half (bits 1–4) is even.',                         x => x.upperBitCount % 2 === 0));
  clues.push(buildClue(clues.length+1, 'The count of 1s in the upper half (bits 1–4) is odd.',                          x => x.upperBitCount % 2 !== 0));
  clues.push(buildClue(clues.length+1, 'The count of 1s in the lower half (bits 5–8) is even.',                         x => x.lowerBitCount % 2 === 0));
  clues.push(buildClue(clues.length+1, 'The count of 1s in the lower half (bits 5–8) is odd.',                          x => x.lowerBitCount % 2 !== 0));

  // ── Consecutive Runs (1–6) ────────────────────────────────────────────────
  for (let k = 1; k <= 6; k++) {
    clues.push(buildClue(clues.length+1,
      `The longest run of consecutive 1s in binary is exactly ${k}.`,
      x => x.maxRun1 === k
    ));
  }
  for (let k = 1; k <= 6; k++) {
    clues.push(buildClue(clues.length+1,
      `The longest run of consecutive 0s in binary is exactly ${k}.`,
      x => x.maxRun0 === k
    ));
  }

  // ── Blocks of 1s (1–4) ───────────────────────────────────────────────────
  for (let k = 1; k <= 4; k++) {
    clues.push(buildClue(clues.length+1,
      `The binary has exactly ${k} separate block${k > 1 ? 's' : ''} of 1s.`,
      x => x.blocks1 === k
    ));
  }

  // ── Blocks of 0s (1–4) ───────────────────────────────────────────────────
  for (let k = 1; k <= 4; k++) {
    clues.push(buildClue(clues.length+1,
      `The binary has exactly ${k} separate block${k > 1 ? 's' : ''} of 0s.`,
      x => x.blocks0 === k
    ));
  }

  // ── Longest Run Type ─────────────────────────────────────────────────────
  clues.push(buildClue(clues.length+1, 'The longest run in binary is of 1s (more consecutive 1s than 0s).', x => x.maxRun1 > x.maxRun0));
  clues.push(buildClue(clues.length+1, 'The longest run in binary is of 0s (more consecutive 0s than 1s).', x => x.maxRun0 > x.maxRun1));
  clues.push(buildClue(clues.length+1, 'The longest run of 1s equals the longest run of 0s in binary.',     x => x.maxRun1 === x.maxRun0));

  return clues;
})();

// CLUE_MAP[id] → clue (for O(1) lookup)
const CLUE_MAP = {};
for (const c of CLUES) CLUE_MAP[c.id] = c;

// ==================== SHARED STATE (injected by game-manager) ====================
let _rooms, _broadcastToRoom, _trackEvent;

function init(deps) {
  _rooms          = deps.rooms;
  _broadcastToRoom = deps.broadcastToRoom;
  _trackEvent      = deps.trackEvent;
}

// ==================== HELPERS ====================

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function intersect(sets) {
  if (!sets.length) return NUMS.map(x => x.n);
  let result = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    const s = new Set(sets[i]);
    result = new Set([...result].filter(n => s.has(n)));
  }
  return [...result];
}

function gsLog(state, msg) {
  state.log.unshift(msg);
  if (state.log.length > 60) state.log.pop();
}

// ==================== PRESET CLUE SETUPS ====================
// Hardcoded verified clue sets for targets 42 and 170.
// Each player count gets a different set — fewer players = narrower clues,
// more players = broader clues. One public entanglement clue per target.

function makeClue(text, testFn) {
  return { text, matchingNumbers: NUMS.filter(testFn).map(x => x.n) };
}

const PRESET_SETUPS = {
  42: {
    entanglement: makeClue(
      'ENTANGLEMENT — Bit 3 and Bit 7 (from the left) are the SAME value.',
      x => x.bits[2] === x.bits[6]
    ),
    playerClues: {
      3: [
        makeClue('The number is in the range 0–59.',
          x => x.n <= 59),
        makeClue('The number is even AND divisible by 3.',
          x => x.n % 2 === 0 && x.n % 3 === 0),
        makeClue('The number has exactly 3 ones in binary.',
          x => x.bitCount === 3),
      ],
      4: [
        makeClue('The number is in the range 0–84.',
          x => x.n <= 84),
        makeClue('The number is divisible by 3.',
          x => x.n % 3 === 0),
        makeClue('The number has exactly 3 ones in binary.',
          x => x.bitCount === 3),
        makeClue('Both the upper nibble (first 4 bits) and lower nibble (last 4 bits) are even.',
          x => x.upperNibble % 2 === 0 && x.lowerNibble % 2 === 0),
      ],
      5: [
        makeClue('The number is in the range 0–84.',
          x => x.n <= 84),
        makeClue('The number is divisible by 3.',
          x => x.n % 3 === 0),
        makeClue('The binary has exactly 3 separate blocks of 1s.',
          x => x.blocks1 === 3),
        makeClue('The lower half (bits 5–8) has more 1s than the upper half (bits 1–4).',
          x => x.lowerBitCount > x.upperBitCount),
        makeClue('Both the upper nibble (first 4 bits) and lower nibble (last 4 bits) are even.',
          x => x.upperNibble % 2 === 0 && x.lowerNibble % 2 === 0),
      ],
    },
  },
  170: {
    entanglement: makeClue(
      'ENTANGLEMENT — Bit 1 and Bit 5 (from the left) are the SAME value.',
      x => x.bits[0] === x.bits[4]
    ),
    playerClues: {
      3: [
        makeClue('The longest run of consecutive 1s in binary is exactly 1.',
          x => x.maxRun1 === 1),
        makeClue('The number has exactly 4 ones in binary.',
          x => x.bitCount === 4),
        makeClue('Both the upper nibble (first 4 bits) and lower nibble (last 4 bits) are even.',
          x => x.upperNibble % 2 === 0 && x.lowerNibble % 2 === 0),
      ],
      4: [
        makeClue('The number has exactly 4 ones in binary.',
          x => x.bitCount === 4),
        makeClue('The upper half (bits 1–4) and lower half (bits 5–8) have an equal count of 1s.',
          x => x.upperBitCount === x.lowerBitCount),
        makeClue('The longest run of consecutive 1s in binary is exactly 1.',
          x => x.maxRun1 === 1),
        makeClue('Both the upper nibble (first 4 bits) and lower nibble (last 4 bits) are even.',
          x => x.upperNibble % 2 === 0 && x.lowerNibble % 2 === 0),
      ],
      5: [
        makeClue('The number is in the range 128–207.',
          x => x.n >= 128 && x.n <= 207),
        makeClue('The number is even.',
          x => x.n % 2 === 0),
        makeClue('The number has exactly 4 ones in binary.',
          x => x.bitCount === 4),
        makeClue('The upper half (bits 1–4) and lower half (bits 5–8) have an equal count of 1s.',
          x => x.upperBitCount === x.lowerBitCount),
        makeClue('The longest run of consecutive 1s in binary is exactly 1.',
          x => x.maxRun1 === 1),
      ],
    },
  },
};

// ==================== GAME INIT ====================

const HAND_SIZE   = 3;
const TOTAL_ROUNDS = 10;

// Shared Quantum Board tokens unlock progressively as gate cards are
// revealed, so the team has some public evidence before they start
// committing to a signal:
//   - Number Estimate unlocks after the 1st gate card is resolved.
//   - Confidence unlocks after the 3rd gate card is resolved.
//   - Focus (on played cards) unlocks after the 5th gate card is resolved.
const UNLOCK_ESTIMATE_AT_CARDS   = 1;
const UNLOCK_CONFIDENCE_AT_CARDS = 3;
const UNLOCK_FOCUS_AT_CARDS      = 5;

function initGSGame(room) {
  const playerCount = room.players.length;

  // Pick one of the two supported targets at random
  const TARGET_NUMBERS = [42, 170];
  const targetNumber = TARGET_NUMBERS[Math.floor(Math.random() * TARGET_NUMBERS.length)];

  const setup = PRESET_SETUPS[targetNumber];
  const clueList = setup.playerClues[playerCount];

  // Build deck (0..255 shuffled), deal hands
  const deck = shuffle([...Array(256)].map((_, i) => i));
  const hands = [];
  for (let p = 0; p < playerCount; p++) {
    hands.push(deck.splice(0, HAND_SIZE));
  }

  const confidence = {};
  const estimate   = {};
  const focus      = {};
  for (let p = 0; p < playerCount; p++) {
    confidence[p] = '?';
    estimate[p]   = null;
    focus[p]      = null;
  }

  room.gsState = {
    phase: 'playing',
    round: 1,
    totalRounds: TOTAL_ROUNDS,
    currentPlayerIdx: 0,
    // The host is the team's Quantum Lead: first player and tie-breaker.
    quantumTokenPlayerIdx: 0,

    targetNumber,

    // Public entanglement clue — broadcast to all players
    entanglementClue: { text: setup.entanglement.text, matchingNumbers: setup.entanglement.matchingNumbers },

    // Private clue per player (indexed by playerIdx)
    playerClues: clueList.map(c => ({ text: c.text, matchingNumbers: c.matchingNumbers })),

    deck,
    hands,
    playedCards: [],
    focus,
    pendingCard: null,
    confidence,
    estimate,
    finalVotes: {},
    tieBreakPending: false,
    tieBreakOptions: [],
    gameOver: false,
    won:      false,
    answer:   null,
    correctAnswer:      null,
    log: [],
  };

  gsLog(room.gsState, `Game started. Round 1 of ${TOTAL_ROUNDS}. ${room.players[0].name} is the Quantum Lead and goes first.`);
}

// ==================== BROADCAST ====================

function gsBroadcastState(room) {
  const gs = room.gsState;
  if (!gs) return;

  for (let pi = 0; pi < room.players.length; pi++) {
    const p = room.players[pi];
    if (!p.ws || !p.connected) continue;

    const msg = buildStateMsg(gs, pi, room.players);
    try { p.ws.send(JSON.stringify(msg)); } catch (_) {}
  }
}

// ==================== BOT LOGIC ====================

// When a bot must choose which gate card to play from its hand, prefer a
// card whose YES/NO result under the bot's OWN clue would NOT already be
// predictable from another player's private clue (i.e. avoid cards that are
// "redundant" because every other player's clue agrees with the bot's on
// that number). This keeps each bot's played cards genuinely informative
// instead of just re-confirming information teammates' clues already imply,
// while the card the bot plays always remains true to its own clue's
// YES/NO verdict (the vote is still derived from the bot's real clue).
function gsPickBotCard(room, botIdx, hand) {
  const gs = room.gsState;
  const myClue = gs.playerClues[botIdx];
  const otherClues = gs.playerClues.filter((_, pi) => pi !== botIdx);

  let bestCard = hand[0];
  let bestScore = -Infinity;
  for (const cardNumber of hand) {
    const myVote = myClue.matchingNumbers.includes(cardNumber);
    // Count how many other players' clues would give the SAME yes/no verdict
    // on this number — a high count means this card reveals little that
    // isn't already implied by clues everyone else holds.
    let agreeCount = 0;
    for (const oc of otherClues) {
      const otherVote = oc.matchingNumbers.includes(cardNumber);
      if (otherVote === myVote) agreeCount++;
    }
    // Lower agreement = more distinguishing information for the team.
    const score = -agreeCount + Math.random() * 0.01; // tiny jitter to break ties
    if (score > bestScore) {
      bestScore = score;
      bestCard = cardNumber;
    }
  }
  return bestCard;
}

function gsMaybeScheduleBotTurn(room) {
  const gs = room.gsState;
  if (!gs || gs.gameOver) return;

  if (gs.phase === 'playing') {
    if (gs.pendingCard) {
      // Any bot that still needs to vote
      const botsNeeded = gs.pendingCard.tokensNeeded.filter(pi => room.players[pi] && room.players[pi].isBot);
      for (const pi of botsNeeded) {
        (function(botIdx) {
          const t = setTimeout(() => {
            const gs2 = room.gsState;
            if (!gs2 || gs2.gameOver || !gs2.pendingCard) return;
            if (!gs2.pendingCard.tokensNeeded.includes(botIdx)) return;
            const clue = gs2.playerClues[botIdx];
            const vote = clue.matchingNumbers.includes(gs2.pendingCard.number) ? 'yes' : 'no';
            gsHandleAction(room, botIdx, { action: 'gs_vote_card', vote });
          }, 600 + Math.random() * 400);
          if (t.unref) t.unref();
        })(pi);
      }
    } else {
      // Current player's turn — if bot, choose a card from hand.
      const curIdx = gs.currentPlayerIdx;
      if (room.players[curIdx] && room.players[curIdx].isBot) {
        const t = setTimeout(() => {
          const gs2 = room.gsState;
          if (!gs2 || gs2.gameOver || gs2.pendingCard) return;
          if (gs2.currentPlayerIdx !== curIdx) return;
          const hand = gs2.hands[curIdx];
          if (!hand || hand.length === 0) return;
          const cardNumber = gsPickBotCard(room, curIdx, hand);
          gsHandleAction(room, curIdx, { action: 'gs_play_card', cardNumber });
        }, 800 + Math.random() * 600);
        if (t.unref) t.unref();
      }
    }
  }

  if (gs.phase === 'voting') {
    if (gs.tieBreakPending) {
      const tieIdx = gs.quantumTokenPlayerIdx;
      if (room.players[tieIdx] && room.players[tieIdx].isBot) {
        const t = setTimeout(() => {
          const gs2 = room.gsState;
          if (!gs2 || gs2.gameOver || !gs2.tieBreakPending) return;
          const options = gs2.tieBreakOptions || [];
          const preferred = gs2.finalVotes[tieIdx];
          const chosen = options.includes(preferred) ? preferred : options[0];
          gsHandleAction(room, tieIdx, { action: 'gs_tie_break', number: chosen });
        }, 700 + Math.random() * 500);
        if (t.unref) t.unref();
      }
      return;
    }
    for (let pi = 0; pi < room.players.length; pi++) {
      if (!room.players[pi].isBot) continue;
      if (gs.finalVotes[pi] !== undefined) continue;
      (function(botIdx) {
        const t = setTimeout(() => {
          const gs2 = room.gsState;
          if (!gs2 || gs2.gameOver || gs2.phase !== 'voting') return;
          if (gs2.finalVotes[botIdx] !== undefined) return;
          // Bot votes its best guess: intersection of all clues it "knows"
          // Simple heuristic: pick the number that matches most clues across all players
          const allMatches = gs2.playerClues.map(c => new Set(c.matchingNumbers));
          const scores = new Array(256).fill(0);
          for (const s of allMatches) for (const n of s) scores[n]++;
          const best = scores.indexOf(Math.max(...scores));
          gsHandleAction(room, botIdx, { action: 'gs_final_vote', number: best });
        }, 700 + Math.random() * 500);
        if (t.unref) t.unref();
      })(pi);
    }
  }
}

function buildStateMsg(gs, playerIdx, players) {
  const pendingCard = gs.pendingCard ? {
    number:           gs.pendingCard.number,
    binaryStr:        gs.pendingCard.binaryStr,
    playedByPlayerIdx: gs.pendingCard.playedByPlayerIdx,
    tokens:           gs.pendingCard.tokens,
    needsVote:        gs.pendingCard.tokensNeeded.includes(playerIdx),
    // The token placement is dictated by the player's own clue, not their choice.
    myVote:           gs.playerClues[playerIdx].matchingNumbers.includes(gs.pendingCard.number) ? 'yes' : 'no',
  } : null;

  return {
    type:               'gs_state',
    phase:              gs.phase,
    round:              gs.round,
    totalRounds:        gs.totalRounds,
    currentPlayerIdx:   gs.currentPlayerIdx,
    quantumTokenPlayerIdx: gs.quantumTokenPlayerIdx,
    players:            players.map((p, i) => ({ name: p.name, color: p.color, connected: p.connected, isBot: !!p.isBot })),
    myPlayerIdx:        playerIdx,
    entanglementClue:   gs.entanglementClue,
    myClue:             gs.playerClues[playerIdx],
    myHand:             gs.hands[playerIdx],
    playedCards:        gs.playedCards,
    focus:              gs.focus,
    pendingCard,
    confidence:         gs.confidence,
    estimate:           gs.estimate,
    finalVotes:         gs.finalVotes,
    tieBreakPending:    !!gs.tieBreakPending,
    tieBreakOptions:    gs.tieBreakOptions || [],
    tieBreakPlayerIdx:  gs.quantumTokenPlayerIdx,
    gameOver:           gs.gameOver,
    won:                gs.won,
    answer:             gs.answer,
    correctAnswer:      gs.correctAnswer,
    log:                gs.log,
    unlocks: {
      estimateAt:   UNLOCK_ESTIMATE_AT_CARDS,
      confidenceAt: UNLOCK_CONFIDENCE_AT_CARDS,
      focusAt:      UNLOCK_FOCUS_AT_CARDS,
      cardsPlayed:  gs.playedCards.length,
    },
  };
}

// ==================== ACTION HANDLER ====================

function gsHandleAction(room, playerIdx, msg) {
  const gs = room.gsState;
  if (!gs || gs.gameOver) return;

  const action = msg.action;

  // ── Central board updates (any time once unlocked, any player) ─────────────
  if (action === 'gs_set_confidence') {
    if (gs.playedCards.length < UNLOCK_CONFIDENCE_AT_CARDS) return; // still locked
    const level = msg.level;
    if (!['?', 'low', 'medium', 'high'].includes(level)) return;
    gs.confidence[playerIdx] = level;
    gsBroadcastState(room);
    return;
  }

  if (action === 'gs_set_estimate') {
    if (gs.playedCards.length < UNLOCK_ESTIMATE_AT_CARDS && gs.phase !== 'voting') return; // still locked
    const est = msg.estimate; // null | { type: 'tenth'|'number', value: N }
    if (est !== null) {
      if (!['tenth', 'number'].includes(est.type)) return;
      if (typeof est.value !== 'number') return;
      if (est.type === 'tenth'   && (est.value < 0 || est.value > 9)) return;
      if (est.type === 'number'  && (est.value < 0 || est.value > 255)) return;
    }
    gs.estimate[playerIdx] = est;
    gsBroadcastState(room);
    return;
  }

  if (action === 'gs_set_focus') {
    if (gs.playedCards.length < UNLOCK_FOCUS_AT_CARDS) return; // still locked
    const idx = msg.cardIndex;
    if (idx !== null) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= gs.playedCards.length) return;
    }
    gs.focus[playerIdx] = idx;
    gsBroadcastState(room);
    return;
  }

  // ── Playing phase ─────────────────────────────────────────────────────────
  if (gs.phase === 'playing') {
    if (action === 'gs_play_card') {
      if (gs.pendingCard) return; // already a card pending
      if (playerIdx !== gs.currentPlayerIdx) return;

      const cardNumber = msg.cardNumber;
      if (typeof cardNumber !== 'number' || cardNumber < 0 || cardNumber > 255) return;

      const hand = gs.hands[playerIdx];
      const cardIdx = hand.indexOf(cardNumber);
      if (cardIdx === -1) return; // not in hand

      // Remove card from hand
      hand.splice(cardIdx, 1);

      // Determine active player's token placement
      const clue = gs.playerClues[playerIdx];
      const activeVote = clue.matchingNumbers.includes(cardNumber) ? 'yes' : 'no';

      const binaryStr = cardNumber.toString(2).padStart(8, '0');
      const tokensNeeded = [];
      for (let pi = 0; pi < room.players.length; pi++) {
        if (pi !== playerIdx) tokensNeeded.push(pi);
      }

      gs.pendingCard = {
        number:            cardNumber,
        binaryStr,
        playedByPlayerIdx: playerIdx,
        tokens:            { [playerIdx]: activeVote },
        tokensNeeded,
      };

      const playerName = room.players[playerIdx].name;
      gsLog(gs, `Round ${gs.round}: ${playerName} played card ${cardNumber} (${binaryStr}).`);
      gsBroadcastState(room);
      gsMaybeScheduleBotTurn(room);
      return;
    }

    if (action === 'gs_vote_card') {
      // A non-active player votes on the pending card
      if (!gs.pendingCard) return;
      if (playerIdx === gs.pendingCard.playedByPlayerIdx) return;
      if (!gs.pendingCard.tokensNeeded.includes(playerIdx)) return;

      // The vote is determined by the player's clue, not by their input — the
      // client only acknowledges it.
      const vote = gs.playerClues[playerIdx].matchingNumbers.includes(gs.pendingCard.number) ? 'yes' : 'no';

      // Record vote
      gs.pendingCard.tokens[playerIdx] = vote;
      gs.pendingCard.tokensNeeded = gs.pendingCard.tokensNeeded.filter(p => p !== playerIdx);

      const playerName = room.players[playerIdx].name;
      gsLog(gs, `${playerName} voted ${vote.toUpperCase()} on card ${gs.pendingCard.number}.`);

      // All votes received?
      if (gs.pendingCard.tokensNeeded.length === 0) {
        _resolveCard(room);
      } else {
        gsBroadcastState(room);
        gsMaybeScheduleBotTurn(room);
      }
      return;
    }
  }

  // ── Voting phase ─────────────────────────────────────────────────────────
  if (gs.phase === 'voting') {
    if (action === 'gs_tie_break') {
      if (!gs.tieBreakPending || playerIdx !== gs.quantumTokenPlayerIdx) return;
      const num = msg.number;
      if (!Number.isInteger(num) || !gs.tieBreakOptions.includes(num)) return;
      gs.tieBreakPending = false;
      gs.tieBreakOptions = [];
      gsLog(gs, `${room.players[playerIdx].name}, the Quantum Lead, broke the tie in favor of ${num}.`);
      _finishVoting(room, num);
      return;
    }

    if (action === 'gs_final_vote') {
      if (gs.tieBreakPending) return;
      const num = msg.number;
      if (typeof num !== 'number' || num < 0 || num > 255) return;

      gs.finalVotes[playerIdx] = num;

      const playerName = room.players[playerIdx].name;
      gsLog(gs, `${playerName} voted for ${num} as the answer.`);

      // Automatically set their estimate token to this number
      gs.estimate[playerIdx] = { type: 'number', value: num };

      // Check if all players have voted
      const allVoted = room.players.every((_, pi) => gs.finalVotes[pi] !== undefined);
      if (allVoted) {
        _resolveVoting(room);
      } else {
        gsBroadcastState(room);
        gsMaybeScheduleBotTurn(room);
      }
      return;
    }
  }
}

function _resolveCard(room) {
  const gs = room.gsState;
  const pc = gs.pendingCard;

  // Commit card to played list
  gs.playedCards.push({
    number:             pc.number,
    binaryStr:          pc.binaryStr,
    round:              gs.round,
    playedByPlayerIdx:  pc.playedByPlayerIdx,
    tokens:             { ...pc.tokens },
  });
  gs.pendingCard = null;

  // The active player discards whatever is left in their hand and draws a
  // fresh hand of HAND_SIZE cards for their next turn.
  const activeIdx = gs.currentPlayerIdx;
  gs.hands[activeIdx] = [];
  for (let i = 0; i < HAND_SIZE && gs.deck.length > 0; i++) {
    gs.hands[activeIdx].push(gs.deck.pop());
  }

  // Bots re-evaluate their confidence, estimate, and focus token now that a
  // full round of play (a new gate card + all its votes) is public information.
  for (let pi = 0; pi < room.players.length; pi++) {
    if (room.players[pi].isBot) gsBotReasonAndUpdate(room, pi);
  }

  // Advance round / advance player
  if (gs.round >= gs.totalRounds) {
    gs.phase = 'voting';
    gsLog(gs, `All ${gs.totalRounds} rounds complete! Now each player votes for the number they think is the answer.`);
    gsBroadcastState(room);
    gsMaybeScheduleBotTurn(room);
    return;
  }

  gs.round++;
  gs.currentPlayerIdx = (gs.currentPlayerIdx + 1) % room.players.length;
  gsLog(gs, `Round ${gs.round} begins. ${room.players[gs.currentPlayerIdx].name}'s turn.`);
  gsBroadcastState(room);
  gsMaybeScheduleBotTurn(room);
}

// ==================== BOT REASONING ====================
// Bots reason about their own private clue plus all public information (the
// entanglement clue and every YES/NO token placed on played gate cards) to
// decide where to place their Confidence and Number Estimate tokens, and
// which played card is most worth the team's attention (Focus token).
// This is intentionally a simple heuristic, not a full deduction solver:
//   - A bot's "candidate set" is every number consistent with its own clue
//     AND the public entanglement clue.
//   - A played card that got a unanimous YES from every player is a strong
//     public signal that its number is very close to (or is) the target,
//     since every player's private clue matched it.
//   - Confidence tracks how narrow the candidate set is (and whether a
//     strong unanimous card was found); Estimate/Focus point at the best
//     supporting evidence found so far.
function gsBotReasonAndUpdate(room, botIdx) {
  const gs = room.gsState;
  if (!gs || gs.gameOver) return;
  if (!room.players[botIdx] || !room.players[botIdx].isBot) return;

  const clue = gs.playerClues[botIdx];
  const entanglement = gs.entanglementClue;
  const entSet = new Set(entanglement.matchingNumbers);
  const candidates = clue.matchingNumbers.filter(n => entSet.has(n));

  // Score each played card as evidence, favoring unanimous YES votes and
  // numbers that also fall inside this bot's own candidate set.
  let focusIdx = null;
  let bestNumber = null;
  let bestScore = -1;
  gs.playedCards.forEach((card, idx) => {
    const tokens = card.tokens || {};
    const voteVals = Object.values(tokens);
    if (voteVals.length === 0) return;
    const yesCount = voteVals.filter(v => v === 'yes').length;
    const unanimous = yesCount === voteVals.length && voteVals.length === room.players.length;
    const inOwnCandidates = candidates.includes(card.number);
    let score = yesCount + (unanimous ? 6 : 0) + (inOwnCandidates ? 4 : 0);
    if (score > bestScore) {
      bestScore   = score;
      bestNumber  = card.number;
      focusIdx    = idx;
    }
  });

  // Confidence tracks how narrow our candidate set is, boosted if we found
  // strong corroborating public evidence (a near-unanimous played card).
  let confidenceLevel;
  const narrowness = candidates.length;
  if (bestScore >= 10 || narrowness <= 8)       confidenceLevel = 'high';
  else if (narrowness <= 32)                    confidenceLevel = 'medium';
  else if (narrowness <= 96)                    confidenceLevel = 'low';
  else                                          confidenceLevel = '?';

  // Estimate: prefer the strongest supporting played-card number when it is
  // consistent with our own candidate set; otherwise fall back to a
  // representative candidate at a granularity matching our confidence.
  let estimate = null;
  if (bestNumber !== null && candidates.includes(bestNumber)) {
    estimate = { type: 'number', value: bestNumber };
  } else if (candidates.length > 0) {
    const sorted = [...candidates].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    if (confidenceLevel === 'high')        estimate = { type: 'number', value: mid };
    else if (confidenceLevel === 'medium') estimate = { type: 'tenth',  value: Math.min(9, Math.floor(mid / 25.5)) };
    else if (confidenceLevel === 'low')    estimate = { type: 'tenth', value: Math.min(9, Math.floor(mid / 25.5)) };
  }
  // Respect the same progressive token unlocks as human players — bots only
  // set a token once enough gate cards have been publicly revealed.
  const cardsPlayed = gs.playedCards.length;
  if (cardsPlayed >= UNLOCK_ESTIMATE_AT_CARDS)   gs.estimate[botIdx]   = estimate;
  if (cardsPlayed >= UNLOCK_CONFIDENCE_AT_CARDS) gs.confidence[botIdx] = confidenceLevel;
  if (cardsPlayed >= UNLOCK_FOCUS_AT_CARDS)      gs.focus[botIdx]      = focusIdx;
}

function _resolveVoting(room) {
  const gs = room.gsState;

  // Tally votes
  const tally = {};
  for (const v of Object.values(gs.finalVotes)) {
    tally[v] = (tally[v] || 0) + 1;
  }

  // Find max vote count
  const maxVotes = Math.max(...Object.values(tally));
  const topNumbers = Object.keys(tally).filter(n => tally[n] === maxVotes).map(Number);

  let answer;
  if (topNumbers.length === 1) {
    _finishVoting(room, topNumbers[0]);
    return;
  } else {
    gs.tieBreakPending = true;
    gs.tieBreakOptions = topNumbers;
    gsLog(gs, `Tie between ${topNumbers.join(' and ')}! ${room.players[gs.quantumTokenPlayerIdx].name}, the Quantum Lead, must choose one of the tied values.`);
    gsBroadcastState(room);
    gsMaybeScheduleBotTurn(room);
    return;
  }
}

function _finishVoting(room, answer) {
  const gs = room.gsState;
  gs.answer    = answer;
  gs.correctAnswer = gs.targetNumber;
  gs.gameOver  = true;
  gs.won       = gs.answer === gs.correctAnswer;

  if (gs.won) {
    gsLog(gs, `Correct! The number was ${gs.targetNumber}. Mission accomplished!`);
  } else {
    gsLog(gs, `The team guessed ${answer}, but the correct number was ${gs.targetNumber}. Mission failed.`);
  }

  gsBroadcastState(room);
}

module.exports = { init, initGSGame, gsHandleAction, gsBroadcastState, gsMaybeScheduleBotTurn };
