'use strict';
/**
 * games/quantumcomputing/tools/gen-mode-setups.js
 *
 * Picks the 4 secret answers per mode (Normal/Advanced) — one randomly
 * chosen cell per board quadrant — that qubit-logic.js's NORMAL_SETUPS /
 * ADVANCED_SETUPS constants hold. The actual clue hand for a given game is
 * built live at game start by qubit-logic.js's buildClueAssignment(), since
 * players pick their own seat color freely in the lobby (not a fixed
 * per-player-count list) — this tool exists only to pick and verify the
 * answers themselves, not to bake in any clue assignment.
 *
 * A candidate answer is accepted only once buildClueAssignment() reaches a
 * uniquely-solvable hand (exactly 1 remaining candidate + a public clue) for
 * EVERY possible 3-to-6-color combination of the 6 seat colors — the
 * smallest player count (3) with the least favorable color combination is
 * the hardest case; anything that clears every 3-color combination also
 * clears every larger one; since extra players/colors only ever add more
 * narrowing clues on top, never fewer.
 *
 * Run:  node games/quantumcomputing/tools/gen-mode-setups.js         (report)
 *       node games/quantumcomputing/tools/gen-mode-setups.js --write (patch file)
 */
const fs   = require('fs');
const path = require('path');
const q    = require('../qubit-logic');

const { GAME_COLORS, buildClueAssignment } = q;
const LOGIC_PATH = path.join(__dirname, '..', 'qubit-logic.js');

const QUADRANTS = [
  { name: 'top-left',     rows: [0, 7],  cols: [0, 7]  },
  { name: 'top-right',    rows: [0, 7],  cols: [8, 15] },
  { name: 'bottom-left',  rows: [8, 15], cols: [0, 7]  },
  { name: 'bottom-right', rows: [8, 15], cols: [8, 15] },
];

function randomCellInQuadrant(quadrant) {
  const row = quadrant.rows[0] + Math.floor(Math.random() * (quadrant.rows[1] - quadrant.rows[0] + 1));
  const col = quadrant.cols[0] + Math.floor(Math.random() * (quadrant.cols[1] - quadrant.cols[0] + 1));
  return row * 16 + col;
}

/** Every combination of `k` items out of `arr`. */
function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst    = combinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

// Every 3-color subset of the 6 seat colors — the worst case (fewest clues
// in play). See file header for why clearing all of these is sufficient.
const WORST_CASE_COLOR_SETS = combinations(GAME_COLORS, 3);

function isUniquelySolvable(answer, mode) {
  return WORST_CASE_COLOR_SETS.every(colors => {
    const { remaining, publicClueId } = buildClueAssignment(answer, colors, mode);
    return remaining === 1 && publicClueId != null;
  });
}

function buildModeSetups(mode) {
  const setups = [];
  const report = [];
  for (const quadrant of QUADRANTS) {
    let chosen = null;
    for (let attempt = 0; attempt < 50 && chosen == null; attempt++) {
      const answer = randomCellInQuadrant(quadrant);
      if (isUniquelySolvable(answer, mode)) chosen = answer;
    }
    if (chosen == null) throw new Error(`Could not find a uniquely-solvable answer in the ${quadrant.name} quadrant for ${mode} mode.`);
    setups.push({ quadrant: quadrant.name, answerDecimal: chosen });
    report.push({ mode, quadrant: quadrant.name, answer: chosen });
  }
  return { setups, report };
}

// ── Build both modes ──────────────────────────────────────────────────────────
const normal   = buildModeSetups('beginner');
const advanced = buildModeSetups('advanced');

console.log('mode        quadrant         answer  binary');
[...normal.report, ...advanced.report].forEach(r => {
  console.log(r.mode.padEnd(12) + r.quadrant.padEnd(17) + String(r.answer).padEnd(8) + r.answer.toString(2).padStart(8, '0'));
});
console.log(`\nAll 8 answers (4 Normal + 4 Advanced) verified uniquely solvable for every 3-to-6-color combination of seated players (${WORST_CASE_COLOR_SETS.length} worst-case 3-color combos checked per answer).`);

// ── Emit ──────────────────────────────────────────────────────────────────────
function fmtSetups(varName, setups) {
  const lines = [`const ${varName} = [`];
  for (const s of setups) {
    lines.push(`  { quadrant: '${s.quadrant}', answerDecimal: ${s.answerDecimal} },`);
  }
  lines.push('];');
  return lines.join('\n');
}

const block = fmtSetups('NORMAL_SETUPS', normal.setups) + '\n\n' + fmtSetups('ADVANCED_SETUPS', advanced.setups);

if (process.argv.includes('--write')) {
  const src = fs.readFileSync(LOGIC_PATH, 'utf8');
  const re = /const NORMAL_SETUPS = \[[\s\S]*?\n\];\n\nconst ADVANCED_SETUPS = \[[\s\S]*?\n\];/;
  if (!re.test(src)) { console.error('Could not locate NORMAL_SETUPS/ADVANCED_SETUPS block.'); process.exit(1); }
  fs.writeFileSync(LOGIC_PATH, src.replace(re, block), 'utf8');
  console.log('\nWrote NORMAL_SETUPS / ADVANCED_SETUPS into qubit-logic.js');
} else {
  console.log('\n--- generated block (rerun with --write to apply) ---\n');
  console.log(block);
}
