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
// bits, never a bit's actual value. A player holding one in isolation has no
// anchor at all — they'd know e.g. "bit 3 and bit 5 match" but not what
// either one IS, so they could never say with certainty which cells are
// consistent with their own clue in a way that helps the team. It's only
// useful bolted onto an anchoring clue the player already has, narrowing an
// already-known set further. So: never a player's first clue, only a later
// (second, third, ...) one.
const ENTANGLEMENT_MIN_ID = 61;

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
 * Returns { assignment: {color: [ids]}, remaining: number }.
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
        // Never hand out an entanglement clue as a player's first/only clue.
        if (assignment[color].length === 0 && id >= ENTANGLEMENT_MIN_ID) continue;
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
  while (candidates.size > 1 && extraRounds < 6) {
    const before = candidates.size;
    assignOneRound();
    extraRounds++;
    if (candidates.size === before) break; // no colour had a narrowing clue left
  }
  return { assignment, remaining: candidates.size, candidates: [...candidates] };
}

// ── Build all nine cards ──────────────────────────────────────────────────────
const cards = {};
const report = [];
for (const cardId of Object.keys(ANSWERS).map(Number).sort((a, b) => a - b)) {
  const answer = ANSWERS[cardId];
  cards[cardId] = { answerIdx: cardId, clues: {} };
  const row = { cardId, answer, counts: {} };
  for (const [key, n] of COUNTS) {
    const { assignment, remaining, candidates } = buildAssignment(answer, n);
    cards[cardId].clues[key] = assignment;
    row.counts[key] = { remaining, ok: candidates.includes(answer) };
  }
  report.push(row);
}

// ── Report ────────────────────────────────────────────────────────────────────
let allGood = true;
console.log('card  answer   ' + COUNTS.map(([k]) => k.padEnd(6)).join(''));
for (const r of report) {
  const cells = COUNTS.map(([k]) => {
    const c = r.counts[k];
    if (!c.ok) { allGood = false; return 'BAD'.padEnd(6); }
    if (c.remaining !== 1) allGood = false;
    return String(c.remaining).padEnd(6);
  });
  console.log(String(r.cardId).padEnd(6) + String(r.answer).padEnd(9) + cells.join(''));
}
console.log('\n(value = candidate cells left after intersecting all clues; 1 = uniquely solvable)');
console.log(allGood ? '\nAll cards uniquely solvable at every player count.' : '\nSome cards are not uniquely solvable.');

// ── Emit ──────────────────────────────────────────────────────────────────────
function fmtCard(cardId) {
  const card = cards[cardId];
  const answer = ANSWERS[cardId];
  const bin = answer.toString(2).padStart(8, '0');
  const lines = [];
  lines.push(`  // Answer ${answer} = ${bin}`);
  lines.push(`  ${cardId}: { answerIdx: ${cardId}, clues: {`);
  for (const [key] of COUNTS) {
    const a = card.clues[key];
    const parts = GAME_COLORS
      .filter(c => a[c])
      .map(c => `${c}:[${a[c].join(',')}]`);
    lines.push(`    '${key}': { ${parts.join(', ')} },`);
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
