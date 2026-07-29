'use strict';
/**
 * games/quantumcomputing/tools/gen-setup-cards.js
 *
 * Regenerates the SETUP_CARDS table in qubit-logic.js.
 *
 * A setup card hands each player a private clue or two. For the game to be a
 * deduction game rather than a guessing game, that pile of clues has to satisfy
 * two properties which the hand-authored table did not:
 *
 *   1. Every assigned clue is TRUE for the card's answer. (A false clue makes
 *      the puzzle unwinnable and poisons the token evidence on the board.)
 *   2. Intersecting all assigned clues leaves exactly one candidate cell — the
 *      answer. Otherwise the team can narrow things down and still be forced to
 *      guess between survivors.
 *
 * Strategy: greedy set-cover. For each colour slot in turn, pick the clue from
 * that colour's sheet that is true for the answer and eliminates the most
 * still-standing candidates. Ties break toward the lower clue id so runs are
 * deterministic. Two clues per player at every player count, so more players
 * means more information and an easier game — the right curve for a co-op.
 *
 * Run:  node games/quantumcomputing/tools/gen-setup-cards.js         (report)
 *       node games/quantumcomputing/tools/gen-setup-cards.js --write (patch file)
 */
const fs   = require('fs');
const path = require('path');
const q    = require('../qubit-logic');

const { CLUES, ANSWERS, BOARD, GAME_COLORS, evalClue } = q;
const LOGIC_PATH = path.join(__dirname, '..', 'qubit-logic.js');

const CLUES_PER_PLAYER = 2;
const COUNTS = [
  ['3p', 3], ['4p', 4], ['5p', 5], ['6p', 6],
];

// Entanglement clues (ids 61-80: EQ/NE — "are digits #X and #Y the same or
// different?") only ever say something about a RELATIONSHIP between two
// bits, never a bit's actual value. A player holding one privately has no
// anchor at all to reason from — they'd know e.g. "bit 3 and bit 5 match"
// but not what either one IS. So entanglement is never handed to a player as
// part of their private hand; instead every card gets exactly one
// entanglement clue that's announced to the WHOLE team as a public fact
// (see qb_state.publicClue). Its two bit positions are chosen to avoid
// whichever bits the players' own B(n,v) clues already pin down directly, so
// it always contributes genuinely new information rather than restating
// something a player's hand already nails down.
const ENTANGLEMENT_MIN_ID = 61;

/** Bit position(s) a clue's text refers to directly, or [] if it's not a
 *  bit-anchored clue (B() gives one position, EQ/NE gives two). */
function parseBitPositions(text) {
  let m = /^Qubit (\d+) \(from left\)/.exec(text);
  if (m) return [Number(m[1])];
  m = /^Position (\d+) and (\d+) are/.exec(text);
  if (m) return [Number(m[1]), Number(m[2])];
  return [];
}

/** Every bit position referenced by any player's assigned clues this tier. */
function usedBitPositions(assignment) {
  const used = new Set();
  for (const color of Object.keys(assignment)) {
    for (const id of assignment[color]) {
      for (const bp of parseBitPositions(CLUES[color][id].text)) used.add(bp);
    }
  }
  return used;
}

// Entanglement clue content is identical across every colour's book (see
// qubit-logic.js) — 'red' is just a canonical place to read it from.
const ENTANGLEMENT_BOOK = 'red';

/**
 * Pick the one public entanglement clue for this card/tier: true for the
 * answer, and preferring zero overlap with bits the players' own clues
 * already cover (falls back to least overlap if none is perfectly clean).
 * Also prefers whichever remaining choice narrows `candidates` further.
 */
function pickPublicEntanglementClue(answer, usedBits, candidates) {
  const entIds = Object.keys(CLUES[ENTANGLEMENT_BOOK])
    .map(Number)
    .filter(id => id >= ENTANGLEMENT_MIN_ID)
    .filter(id => matches(ENTANGLEMENT_BOOK, id).has(answer));

  let best = null, bestOverlap = Infinity, bestSize = Infinity;
  for (const id of entIds) {
    const [n, m] = parseBitPositions(CLUES[ENTANGLEMENT_BOOK][id].text);
    const overlap = (usedBits.has(n) ? 1 : 0) + (usedBits.has(m) ? 1 : 0);
    const mSet = matches(ENTANGLEMENT_BOOK, id);
    let size = 0;
    for (const d of candidates) if (mSet.has(d)) size++;
    if (overlap < bestOverlap || (overlap === bestOverlap && size < bestSize)) {
      bestOverlap = overlap; bestSize = size; best = id;
    }
  }
  return best;
}

/** Cells matching a clue, as a Set of decimals. */
const matchCache = new Map();
function matches(color, id) {
  const key = color + ':' + id;
  let s = matchCache.get(key);
  if (!s) {
    s = new Set(BOARD.filter(c => evalClue(color, id, c)).map(c => c.decimal));
    matchCache.set(key, s);
  }
  return s;
}

/** Clue ids on a colour's sheet that hold for `answer`, ascending. */
function trueClues(color, answer) {
  return Object.keys(CLUES[color] || {})
    .map(Number)
    .filter(id => matches(color, id).has(answer))
    .sort((a, b) => a - b);
}

/**
 * Build one card's clue assignment for a given player count.
 * Returns { assignment: {color: [ids]}, publicClueId, remaining, candidates }.
 */
function buildAssignment(answer, nPlayers) {
  const colors = GAME_COLORS.slice(0, nPlayers);
  let candidates = new Set(BOARD.map(c => c.decimal));
  const assignment = {};
  colors.forEach(c => { assignment[c] = []; });

  function assignOneRound() {
    for (const color of colors) {
      let best = null, bestSize = Infinity, bestGlobal = Infinity;
      for (const id of trueClues(color, answer)) {
        if (assignment[color].includes(id)) continue;
        // Entanglement is never a player's private clue — it's always the
        // one public fact announced to the whole team instead (below).
        if (id >= ENTANGLEMENT_MIN_ID) continue;
        const m = matches(color, id);
        let size = 0;
        for (const d of candidates) if (m.has(d)) size++;
        const global = m.size;
        // Primary: shrink the live candidate set. Secondary (and the only
        // signal left once the set is already a singleton): prefer the more
        // selective clue, so nobody is handed a near-tautology.
        if (size < bestSize || (size === bestSize && global < bestGlobal)) {
          bestSize = size; bestGlobal = global; best = id;
        }
      }
      if (best == null) continue;
      assignment[color].push(best);
      const m = matches(color, best);
      candidates = new Set([...candidates].filter(d => m.has(d)));
    }
  }

  // Round-robin over colours so no single player holds all the narrowing power.
  // Every player gets the full CLUES_PER_PLAYER even once the answer is pinned
  // down — a player with an empty hand has nothing to contribute or verify.
  for (let round = 0; round < CLUES_PER_PLAYER; round++) assignOneRound();

  // Low player counts sometimes can't reach a unique answer in CLUES_PER_PLAYER
  // rounds (fewer clues in play). Keep handing out one more clue per colour,
  // round-robin, until it's uniquely solvable or the clue pool runs dry.
  let extraRounds = 0;
  while (candidates.size > 1 && extraRounds < 10) {
    const before = candidates.size;
    assignOneRound();
    extraRounds++;
    if (candidates.size === before) break; // no colour had a narrowing clue left
  }

  // The one public entanglement clue: always present, chosen to avoid the
  // bit positions the players' own clues already pin down, and folded into
  // the same uniqueness check since the whole team knows it from turn one.
  const publicClueId = pickPublicEntanglementClue(answer, usedBitPositions(assignment), candidates);
  if (publicClueId != null) {
    const m = matches(ENTANGLEMENT_BOOK, publicClueId);
    candidates = new Set([...candidates].filter(d => m.has(d)));
  }

  return { assignment, publicClueId, remaining: candidates.size, candidates: [...candidates] };
}

// ── Build all nine cards ──────────────────────────────────────────────────────
const cards = {};
const report = [];
for (const cardId of Object.keys(ANSWERS).map(Number).sort((a, b) => a - b)) {
  const answer = ANSWERS[cardId];
  cards[cardId] = { answerIdx: cardId, clues: {} };
  const row = { cardId, answer, counts: {} };
  for (const [key, n] of COUNTS) {
    const { assignment, publicClueId, remaining, candidates } = buildAssignment(answer, n);
    cards[cardId].clues[key] = { colors: assignment, public: publicClueId };
    row.counts[key] = { remaining, ok: candidates.includes(answer), hasPublic: publicClueId != null };
  }
  report.push(row);
}

// ── Report ────────────────────────────────────────────────────────────────────
let allGood = true;
console.log('card  answer   ' + COUNTS.map(([k]) => k.padEnd(9)).join(''));
for (const r of report) {
  const cells = COUNTS.map(([k]) => {
    const c = r.counts[k];
    if (!c.ok || !c.hasPublic) { allGood = false; return 'BAD'.padEnd(9); }
    if (c.remaining !== 1) allGood = false;
    return String(c.remaining).padEnd(9);
  });
  console.log(String(r.cardId).padEnd(6) + String(r.answer).padEnd(9) + cells.join(''));
}
console.log('\n(value = candidate cells left after intersecting all clues + the public entanglement fact; 1 = uniquely solvable)');
console.log(allGood ? '\nAll cards uniquely solvable at every player count, every card has its public clue.' : '\nSome cards are not uniquely solvable, or missing a public clue.');

// ── Emit ──────────────────────────────────────────────────────────────────────
function fmtCard(cardId) {
  const card = cards[cardId];
  const answer = ANSWERS[cardId];
  const bin = answer.toString(2).padStart(8, '0');
  const lines = [];
  lines.push(`  // Answer ${answer} = ${bin}`);
  lines.push(`  ${cardId}: { answerIdx: ${cardId}, clues: {`);
  for (const [key] of COUNTS) {
    const a = card.clues[key].colors;
    const parts = GAME_COLORS
      .filter(c => a[c])
      .map(c => `${c}:[${a[c].join(',')}]`);
    lines.push(`    '${key}': { colors: { ${parts.join(', ')} }, public: ${card.clues[key].public} },`);
  }
  lines.push('  }},');
  return lines.join('\n');
}

const block = 'const SETUP_CARDS = {\n'
  + Object.keys(cards).map(Number).sort((a, b) => a - b).map(fmtCard).join('\n')
  + '\n};';

if (process.argv.includes('--write')) {
  const src = fs.readFileSync(LOGIC_PATH, 'utf8');
  const re = /const SETUP_CARDS = \{[\s\S]*?\n\};/;
  if (!re.test(src)) { console.error('Could not locate SETUP_CARDS block.'); process.exit(1); }
  fs.writeFileSync(LOGIC_PATH, src.replace(re, block), 'utf8');
  console.log('\nWrote SETUP_CARDS into qubit-logic.js');
} else {
  console.log('\n--- generated block (rerun with --write to apply) ---\n');
  console.log(block);
}
