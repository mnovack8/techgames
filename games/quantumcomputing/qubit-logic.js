'use strict';

// ==================== BOARD CONSTANTS ====================

// Region layout: 2 rows × 3 columns
// Top half (rows 0-7):    R1=cols 0-4, R2=cols 5-10, R3=cols 11-15
// Bottom half (rows 8-15): R4=cols 0-4, R5=cols 5-10, R6=cols 11-15
function getRegion(row, col) {
  const rowHalf = row < 8 ? 0 : 1;
  const colZone = col <= 4 ? 0 : col <= 9 ? 1 : 2;
  return rowHalf * 3 + colZone + 1;
}

function buildCell(row, col) {
  const decimal  = row * 16 + col;
  const binary   = decimal.toString(2).padStart(8, '0');
  const bits     = binary.split('').map(Number);  // bits[0]=MSB=bit1
  const digits   = String(decimal).split('').map(Number);
  const digitSum = digits.reduce((s, d) => s + d, 0);
  const nibbleSum = row + col;
  const bitCount  = bits.reduce((s, b) => s + b, 0);
  const blockRow  = Math.floor(row / 4);
  const blockCol  = Math.floor(col / 4);
  const isDark    = (blockRow + blockCol) % 2 === 0;
  // Fine per-cell checkerboard (independent of the big 4x4-block one above) —
  // matches the client's qb-fine-a/qb-fine-b classes: (row+col) odd is the
  // darker overlay, even is the lighter one.
  const fineDark  = (row + col) % 2 === 1;
  const region    = getRegion(row, col);
  return { row, col, decimal, binary, bits, digitSum, nibbleSum, bitCount, isDark, fineDark, region };
}

const BOARD = [];
for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) BOARD.push(buildCell(r, c));
const CELL = {};
for (const cell of BOARD) CELL[cell.decimal] = cell;

// ==================== CLUE DATABASE ====================
// 60 clues per color. CLUES[color][id] = { text, eval }

// Clue builder helpers
// `advancedOnly` marks clues from the Bit Position / Bit Count / Ket
// Proximity categories — these require reading bits or kets off the board,
// which Beginner-mode boards don't show, so initQBGame() strips any clue id
// carrying this flag when a room is running in beginner mode.
const B   = (n, v) => ({ text: `Qubit ${n} (from left) of your code is a ${v}.`,                           eval: c => c.bits[n-1] === v, advancedOnly: true });
const DR  = (lo,hi)=> ({ text: `The decimal digit-sum of your code is between ${lo} and ${hi}.`,           eval: c => c.digitSum >= lo && c.digitSum <= hi });
const DM  = (n)    => ({ text: `The decimal digit-sum of your code is ${n} or more.`,                      eval: c => c.digitSum >= n });
const NR  = (lo,hi)=> ({ text: `(Row + column) of your cell is between ${lo} and ${hi}.`,                  eval: c => c.nibbleSum >= lo && c.nibbleSum <= hi });
const NM  = (n)    => ({ text: `(Row + column) of your cell is ${n} or more.`,                             eval: c => c.nibbleSum >= n });
// Anti-diagonal counterparts of NR/NM: row+col only distinguishes the
// top-left corner (low sum) from the bottom-right corner (high sum) — these
// two use (column - row) and (row - column) instead, covering the other two
// corners (top-right, bottom-left). Same triangular-distribution math as
// row+col, so >=0 lands at 136 matches (just over half), not exactly 128 —
// there's no integer threshold on either axis that splits the board exactly
// in half, since the middle diagonal is a 16-cell band that can't be divided
// further without a second rule.
const CD  = ()     => ({ text: `(Column minus row) of your cell is 0 or more.`,                             eval: c => (c.col - c.row) >= 0 });
const RD  = ()     => ({ text: `(Row minus column) of your cell is 0 or more.`,                             eval: c => (c.row - c.col) >= 0 });
const BC  = (vs)   => ({ text: `Your 8-qubit code contains exactly ${vs.join(' or ')} ones.`,               eval: c => vs.includes(c.bitCount), advancedOnly: true });
const R   = (rs)   => ({ text: `Your code's cell is inside region ${rs.join(', or ')}.`,                    eval: c => rs.includes(c.region) });
const DAR = ()     => ({ text: `Your code's cell is in a yellow-shaded quadrant.`,                          eval: c => c.isDark });
const LIT = ()     => ({ text: `Your code's cell is in a blue-shaded quadrant.`,                            eval: c => !c.isDark });
// Fine per-cell checkerboard (independent of the big 4x4-block shading
// above) — a dark/light overlay that alternates every single cell, so it
// applies within BOTH the yellow and blue quadrants, not one or the other.
const FDAR = ()    => ({ text: `Your code's cell is in a dark square (yellow or blue).`,                    eval: c => c.fineDark });
const FLIT = ()    => ({ text: `Your code's cell is in a light square (yellow or blue).`,                   eval: c => !c.fineDark });
// Coarsest checkerboard level: the board's actual 4 quadrants (8x8 each,
// 2 rows x 2 cols of the 4x4-block grid) — top-left+bottom-right (diagonal
// pair) vs top-right+bottom-left (the other diagonal pair). Each of these
// two clues matches exactly 128 cells.
const quadParity = c => (Math.floor(c.row / 8) + Math.floor(c.col / 8)) % 2;
const QTL = ()     => ({ text: `Your code's cell is in the top-left or bottom-right quadrant.`,              eval: c => quadParity(c) === 0 });
const QTR = ()     => ({ text: `Your code's cell is in the top-right or bottom-left quadrant.`,              eval: c => quadParity(c) === 1 });
// Adjacent-pair versions (128 cells each, never just a single 64-cell
// quarter) — pairing two quadrants that share a row (top/bottom) or a
// column (left/right), as opposed to QTL/QTR's diagonal pairing above.
const quadRow = c => Math.floor(c.row / 8);
const quadCol = c => Math.floor(c.col / 8);
const QUAD_TOP    = () => ({ text: `Your code's cell is in the top-left or top-right quadrant.`,         eval: c => quadRow(c) === 0 });
const QUAD_BOTTOM = () => ({ text: `Your code's cell is in the bottom-left or bottom-right quadrant.`,   eval: c => quadRow(c) === 1 });
const QUAD_LEFT   = () => ({ text: `Your code's cell is in the top-left or bottom-left quadrant.`,       eval: c => quadCol(c) === 0 });
const QUAD_RIGHT  = () => ({ text: `Your code's cell is in the top-right or bottom-right quadrant.`,     eval: c => quadCol(c) === 1 });
// Back to the finest (4x4-block) checkerboard grid, but a different split:
// of the 16 blocks, 8 form an "X" across the board — the 4 corner blocks
// (blockRow===blockCol on the main diagonal, blockRow+blockCol===3 on the
// anti-diagonal) plus the 4 center blocks (where the two diagonals cross).
// The other 8 blocks (off both diagonals) are the complement. 128 cells each.
const blockRow = c => Math.floor(c.row / 4);
const blockCol = c => Math.floor(c.col / 4);
const isXBlock = c => blockRow(c) === blockCol(c) || blockRow(c) + blockCol(c) === 3;
const XIN  = () => ({ text: `Your code's cell is in one of the 8 blocks forming an X across the board (the 4 corners and the 4 center blocks).`, eval: c => isXBlock(c) });
const XOUT = () => ({ text: `Your code's cell is in one of the 8 blocks NOT in the X pattern (not a corner or center block).`,                    eval: c => !isXBlock(c) });

// Entanglement clues: whether two distinct qubit positions carry the same
// value or differ. `n` and `m` are 1-indexed from the left, matching B(n,v).
const EQ  = (n, m) => ({ text: `Position ${n} and ${m} are the SAME (both 0 or both 1).`,                eval: c => c.bits[n-1] === c.bits[m-1] });
const NE  = (n, m) => ({ text: `Position ${n} and ${m} are DIFFERENT (one is 0 and the other is 1).`,     eval: c => c.bits[n-1] !== c.bits[m-1] });

// Ket Proximity clues (Advance mode): "distance" is king-move steps from the
// cell to the nearest touching corner of a qualifying ket vertex — 0 for the
// (up to) 4 cells that actually touch that vertex, 1 for the ring around
// those, etc. KETS is declared further down this file; that's fine, this
// closure only reads it when eval() actually runs (well after module load).
function cellVertexDist(row, col, vRow, vCol) {
  const rowDist = Math.max(0, vRow - (row + 1), row - vRow);
  const colDist = Math.max(0, vCol - (col + 1), col - vCol);
  return Math.max(rowDist, colDist);
}
function ketMinDist(c, predicate) {
  let min = Infinity;
  for (const k of KETS) {
    if (!predicate(k)) continue;
    const d = cellVertexDist(c.row, c.col, k.row, k.col);
    if (d < min) min = d;
  }
  return min;
}
const KP = (n, label, predicate) => ({
  text: `Your code's cell is within ${n} space${n === 1 ? '' : 's'} of ${label}.`,
  eval: c => ketMinDist(c, predicate) <= n,
  advancedOnly: true,
});

// Ket Proximity clues (Advance mode): identical across every color's book,
// same pattern as the Entanglement clues (61-80) above — mirrored in by
// spreading this shared object into each color, rather than retyping it six
// times. See qbBuildClueRefGroups() in qubit.html for the client-side mirror
// of this same category.
// Labels say "Black"/"White" (the ket's rendered color), not the internal
// 'amber'/'blue' type keys — those are just data, the board itself no longer
// shows amber/blue.
const KET_PROXIMITY_CLUES = {
  81: KP(1, 'any ket', () => true),
  82: KP(2, 'any Ket 1 (either color)', k => k.type.endsWith('1')),
  83: KP(2, 'any Ket 0 (either color)', k => k.type.endsWith('0')),
  84: KP(2, 'any White Ket (either value)', k => k.type.indexOf('blue') === 0),
  85: KP(2, 'any Black Ket (either value)', k => k.type.indexOf('amber') === 0),
  86: KP(3, 'a Black Ket 0', k => k.type === 'amber0'),
  87: KP(3, 'a Black Ket 1', k => k.type === 'amber1'),
  88: KP(3, 'a White Ket 0', k => k.type === 'blue0'),
  89: KP(3, 'a White Ket 1', k => k.type === 'blue1'),
};

// Decimal Value Range clues (Beginner-mode candidate category): the cell's
// own printed decimal number (0-255), no binary/digit-sum math required.
// Every clue is an "or" of two of the seven 64-wide blocks below — four
// row-aligned quarters (Q1-Q4, bounds are multiples of 16, so each reads as
// a clean band of whole board rows) plus three 64-wide offsets straddling
// the quarter boundaries (O1-O3). Only pairs that don't overlap are used, so
// every clue matches exactly 128 of the 256 cells — the same "half the
// board" weight for every entry in this category, none stronger than another.
//   Q1=[0,63] Q2=[64,127] Q3=[128,191] Q4=[192,255]
//   O1=[32,95] O2=[96,159] O3=[160,223]
const DVU = (lo1, hi1, lo2, hi2) => ({
  text: `Your code's decimal value is between ${lo1} and ${hi1}, or between ${lo2} and ${hi2}.`,
  eval: c => (c.decimal >= lo1 && c.decimal <= hi1) || (c.decimal >= lo2 && c.decimal <= hi2),
});
const DECIMAL_RANGE_CLUES = {
  // Quarter + Quarter (4) — Q1+Q2 ("127 or less") and Q3+Q4 ("128 or more")
  // are dropped: those are exactly Region's top-half (1,2,3) vs bottom-half
  // (4,5,6) split, so they'd be a pure duplicate of an existing Region clue.
  91: DVU(0,63, 128,191),    // Q1+Q3
  92: DVU(0,63, 192,255),    // Q1+Q4
  93: DVU(64,127, 128,191),  // Q2+Q3
  94: DVU(64,127, 192,255),  // Q2+Q4
  // Offset + Offset (3) — any two offsets are disjoint by construction.
  96: DVU(32,95, 96,159),    // O1+O2
  97: DVU(32,95, 160,223),   // O1+O3
  98: DVU(96,159, 160,223),  // O2+O3
  // Quarter + Offset (6) — only the non-adjacent combos avoid a 32-cell overlap.
  99:  DVU(0,63, 96,159),    // Q1+O2
  100: DVU(0,63, 160,223),   // Q1+O3
  101: DVU(64,127, 160,223), // Q2+O3
  102: DVU(32,95, 128,191),  // Q3+O1
  103: DVU(32,95, 192,255),  // Q4+O1
  104: DVU(96,159, 192,255), // Q4+O2
};

// Extra Bit Count clue: identical across every color's book.
const BIT_COUNT_EXTRA_CLUES = {
  105: BC([0,1,2,6,7,8]),
};

// Extra Quadrant Shading clues (fine per-cell checkerboard): identical
// across every color's book.
const FINE_CHECKER_CLUES = {
  106: FDAR(),
  107: FLIT(),
};

// Extra Row + Column Sum clues (anti-diagonal corners): identical across
// every color's book.
const CORNER_SUM_CLUES = {
  108: CD(),
  109: RD(),
};

// Extra Quadrant Shading clues (coarse quadrant checkerboard): identical
// across every color's book.
const QUADRANT_DIAGONAL_CLUES = {
  110: QTL(),
  111: QTR(),
};

// Adjacent-quadrant-pair clues: identical across every color's book.
const QUADRANT_HALF_CLUES = {
  112: QUAD_TOP(),
  113: QUAD_BOTTOM(),
  114: QUAD_LEFT(),
  115: QUAD_RIGHT(),
};

// X-pattern block clues: identical across every color's book.
const CHECKERBOARD_X_CLUES = {
  116: XIN(),
  117: XOUT(),
};

// 60 clues per color (mirrored across colors for balance)
const CLUES = {
  red: {
    1: NR(0,15), 2: R([1,2,5]), 3: DR(0,7), 4: B(6,0),
    6: BC([4,5]), 7: B(3,1), 8: B(2,1), 9: DM(10), 10: B(7,0),
    12: R([1,2,6]), 13: R([2,3,4]), 14: R([2,5,6]), 16: B(8,1),
    19: LIT(), 20: R([2,4,6]), 22: DR(7,12), 23: B(6,1),
    26: R([1,2,4]), 27: NM(15), 28: BC([3,4]), 29: R([3,4,5]),
    30: DAR(), 32: B(7,1), 33: R([1,4,5]), 35: R([3,4,6]),
    36: R([2,4,5]), 38: B(4,0), 40: B(3,0), 41: R([2,3,5]),
    42: B(4,1), 43: DR(1,9), 44: R([1,4,6]), 46: R([1,3,5]),
    47: R([1,5,6]), 48: R([2,3,6]), 50: B(2,0), 51: R([3,5,6]), 52: R([1,3,4]),
    53: DR(5,10), 55: LIT(), 56: R([1,3,6]), 59: DAR(),
    60: B(8,0), 61: EQ(1,2), 62: NE(1,2), 63: EQ(1,3), 64: NE(1,3),
    65: EQ(1,4), 66: NE(1,4), 67: EQ(1,5), 68: NE(1,5), 69: EQ(1,6),
    70: NE(1,6), 71: EQ(1,7), 72: NE(1,7), 73: EQ(1,8), 74: NE(1,8),
    75: EQ(2,3), 76: NE(2,3), 77: EQ(2,4), 78: NE(2,4), 79: EQ(2,5),
    80: NE(2,5), ...KET_PROXIMITY_CLUES, ...DECIMAL_RANGE_CLUES, ...BIT_COUNT_EXTRA_CLUES, ...FINE_CHECKER_CLUES, ...CORNER_SUM_CLUES, ...QUADRANT_DIAGONAL_CLUES, ...QUADRANT_HALF_CLUES, ...CHECKERBOARD_X_CLUES,
  },
  blue: {
    1: LIT(), 2: BC([4,5]), 3: BC([3,4]), 4: R([2,3,6]), 5: R([1,4,6]),
    6: B(2,1), 7: B(3,1), 8: R([1,2,6]), 9: DAR(), 10: R([2,4,6]),
    12: B(8,1), 16: R([1,2,5]),
    19: R([2,3,4]), 20: DR(0,7), 21: NR(0,15),
    22: R([3,5,6]), 23: R([1,5,6]), 26: DR(5,10), 27: DR(1,9), 28: R([2,3,5]),
    29: B(8,0), 31: B(7,1), 33: R([3,4,5]), 34: R([1,3,6]),
    36: R([1,2,4]), 38: B(6,0), 39: R([2,4,5]), 40: LIT(), 41: DAR(),
    42: R([2,5,6]), 45: B(2,0), 46: R([1,4,5]), 48: B(4,1),
    49: B(6,1), 50: B(4,0), 51: B(7,0), 52: DR(7,12), 53: DM(10),
    54: R([1,3,5]), 55: NM(15), 56: R([1,3,4]), 57: B(3,0), 58: R([3,4,6]),
    61: EQ(1,2), 62: NE(1,2), 63: EQ(1,3), 64: NE(1,3),
    65: EQ(1,4), 66: NE(1,4), 67: EQ(1,5), 68: NE(1,5), 69: EQ(1,6),
    70: NE(1,6), 71: EQ(1,7), 72: NE(1,7), 73: EQ(1,8), 74: NE(1,8),
    75: EQ(2,3), 76: NE(2,3), 77: EQ(2,4), 78: NE(2,4), 79: EQ(2,5),
    80: NE(2,5), ...KET_PROXIMITY_CLUES, ...DECIMAL_RANGE_CLUES, ...BIT_COUNT_EXTRA_CLUES, ...FINE_CHECKER_CLUES, ...CORNER_SUM_CLUES, ...QUADRANT_DIAGONAL_CLUES, ...QUADRANT_HALF_CLUES, ...CHECKERBOARD_X_CLUES,
  },
  green: {
    2: BC([3,4]), 3: B(2,1), 5: B(8,0), 6: B(2,0),
    7: DAR(), 8: R([3,4,5]), 10: DR(0,7), 11: R([1,2,5]), 12: B(4,1),
    13: R([2,5,6]), 14: R([2,4,5]), 16: R([1,2,4]), 17: R([3,4,6]), 18: NR(0,15),
    19: B(8,1), 20: B(7,1), 21: R([2,3,6]), 23: B(6,1), 24: R([1,3,4]),
    27: R([2,4,6]), 28: NM(15),
    30: R([1,5,6]), 33: R([2,3,5]), 35: R([1,4,6]), 37: B(7,0),
    39: B(4,0), 40: DR(5,10), 41: B(3,0), 42: LIT(),
    44: R([3,5,6]), 45: R([1,3,6]), 46: DAR(), 47: R([1,4,5]), 48: R([1,3,5]),
    50: BC([4,5]), 51: DR(7,12), 52: LIT(), 53: DR(1,9), 54: B(3,1),
    55: DM(10), 57: B(6,0), 59: R([2,3,4]),
    60: R([1,2,6]), 61: EQ(1,2), 62: NE(1,2), 63: EQ(1,3), 64: NE(1,3),
    65: EQ(1,4), 66: NE(1,4), 67: EQ(1,5), 68: NE(1,5), 69: EQ(1,6),
    70: NE(1,6), 71: EQ(1,7), 72: NE(1,7), 73: EQ(1,8), 74: NE(1,8),
    75: EQ(2,3), 76: NE(2,3), 77: EQ(2,4), 78: NE(2,4), 79: EQ(2,5),
    80: NE(2,5), ...KET_PROXIMITY_CLUES, ...DECIMAL_RANGE_CLUES, ...BIT_COUNT_EXTRA_CLUES, ...FINE_CHECKER_CLUES, ...CORNER_SUM_CLUES, ...QUADRANT_DIAGONAL_CLUES, ...QUADRANT_HALF_CLUES, ...CHECKERBOARD_X_CLUES,
  },
  yellow: {
    2: R([1,2,5]), 3: R([2,3,5]), 5: R([1,5,6]),
    8: B(6,0), 9: BC([3,4]), 10: R([1,3,4]),
    12: R([3,5,6]), 13: R([2,4,5]), 14: NM(15), 17: NR(0,15),
    18: B(8,0), 19: R([1,4,6]), 20: DR(5,10), 21: R([1,2,6]), 25: R([3,4,5]),
    26: R([2,5,6]), 27: B(4,1), 28: DAR(), 30: B(3,0),
    31: B(4,0), 32: BC([4,5]), 33: DR(0,7), 36: DAR(),
    37: R([2,3,4]), 38: LIT(), 39: B(2,0), 40: R([3,4,6]),
    43: B(8,1), 44: LIT(), 45: B(7,1), 46: DM(10), 47: R([1,3,5]),
    48: R([2,4,6]), 49: B(2,1), 51: DR(1,9), 52: B(7,0), 53: DR(7,12),
    54: R([1,2,4]), 55: R([1,3,6]), 56: R([2,3,6]), 57: B(6,1), 58: R([1,4,5]),
    59: B(3,1), 61: EQ(1,2), 62: NE(1,2), 63: EQ(1,3), 64: NE(1,3),
    65: EQ(1,4), 66: NE(1,4), 67: EQ(1,5), 68: NE(1,5), 69: EQ(1,6),
    70: NE(1,6), 71: EQ(1,7), 72: NE(1,7), 73: EQ(1,8), 74: NE(1,8),
    75: EQ(2,3), 76: NE(2,3), 77: EQ(2,4), 78: NE(2,4), 79: EQ(2,5),
    80: NE(2,5), ...KET_PROXIMITY_CLUES, ...DECIMAL_RANGE_CLUES, ...BIT_COUNT_EXTRA_CLUES, ...FINE_CHECKER_CLUES, ...CORNER_SUM_CLUES, ...QUADRANT_DIAGONAL_CLUES, ...QUADRANT_HALF_CLUES, ...CHECKERBOARD_X_CLUES,
  },
  purple: {
    1: R([1,4,5]), 2: B(7,0), 3: DR(0,7), 5: R([1,2,5]), 6: R([1,3,5]),
    7: R([1,4,6]), 8: B(3,1), 10: DR(7,12),
    13: B(7,1), 14: R([1,3,4]), 15: B(2,0), 16: BC([3,4]),
    20: DAR(), 21: B(4,0), 22: LIT(), 23: R([2,3,5]), 24: R([3,4,5]),
    25: B(8,1), 26: B(8,0), 27: R([1,5,6]), 30: R([2,4,6]),
    32: R([2,3,6]), 34: R([1,2,6]), 35: B(2,1), 36: R([1,2,4]),
    37: B(4,1), 39: R([2,4,5]), 40: DAR(), 41: BC([4,5]), 42: R([3,5,6]),
    46: R([1,3,6]), 48: B(3,0), 49: B(6,1),
    50: B(6,0), 51: DM(10), 53: NR(0,15), 54: DR(5,10),
    55: NM(15), 56: R([2,5,6]), 57: R([3,4,6]), 58: DR(1,9), 59: LIT(),
    60: R([2,3,4]), 61: EQ(1,2), 62: NE(1,2), 63: EQ(1,3), 64: NE(1,3),
    65: EQ(1,4), 66: NE(1,4), 67: EQ(1,5), 68: NE(1,5), 69: EQ(1,6),
    70: NE(1,6), 71: EQ(1,7), 72: NE(1,7), 73: EQ(1,8), 74: NE(1,8),
    75: EQ(2,3), 76: NE(2,3), 77: EQ(2,4), 78: NE(2,4), 79: EQ(2,5),
    80: NE(2,5), ...KET_PROXIMITY_CLUES, ...DECIMAL_RANGE_CLUES, ...BIT_COUNT_EXTRA_CLUES, ...FINE_CHECKER_CLUES, ...CORNER_SUM_CLUES, ...QUADRANT_DIAGONAL_CLUES, ...QUADRANT_HALF_CLUES, ...CHECKERBOARD_X_CLUES,
  },
  orange: {
    1: B(2,1), 2: R([2,3,5]), 4: R([1,3,4]), 5: R([1,3,5]),
    6: BC([4,5]), 10: R([1,5,6]), 11: B(4,0), 12: LIT(),
    13: B(6,0), 14: DAR(), 16: R([1,2,5]), 17: B(8,1),
    18: B(7,1), 19: DM(10), 20: DR(1,9), 23: R([3,4,5]),
    26: NR(0,15), 27: B(3,0), 28: B(8,0), 29: DR(5,10), 30: R([1,2,6]),
    31: R([3,5,6]), 32: NM(15), 34: R([1,4,5]), 35: R([1,4,6]), 37: R([1,2,4]),
    39: R([2,4,6]), 40: B(4,1), 41: B(6,1), 44: B(2,0),
    45: R([2,5,6]), 46: R([2,3,4]), 47: DR(0,7), 48: BC([3,4]), 49: DAR(),
    50: LIT(), 53: R([1,3,6]), 54: R([2,3,6]),
    56: B(3,1), 57: B(7,0), 58: R([2,4,5]), 59: DR(7,12),
    60: R([3,4,6]), 61: EQ(1,2), 62: NE(1,2), 63: EQ(1,3), 64: NE(1,3),
    65: EQ(1,4), 66: NE(1,4), 67: EQ(1,5), 68: NE(1,5), 69: EQ(1,6),
    70: NE(1,6), 71: EQ(1,7), 72: NE(1,7), 73: EQ(1,8), 74: NE(1,8),
    75: EQ(2,3), 76: NE(2,3), 77: EQ(2,4), 78: NE(2,4), 79: EQ(2,5),
    80: NE(2,5), ...KET_PROXIMITY_CLUES, ...DECIMAL_RANGE_CLUES, ...BIT_COUNT_EXTRA_CLUES, ...FINE_CHECKER_CLUES, ...CORNER_SUM_CLUES, ...QUADRANT_DIAGONAL_CLUES, ...QUADRANT_HALF_CLUES, ...CHECKERBOARD_X_CLUES,
  },
};

// ==================== GAME SETUPS ====================
// 4 setups per mode, one secret answer per board quadrant. initQBGame()
// picks a random one of the 4 matching the room's mode at game start, then
// builds that game's actual clue hands live (see buildClueAssignment below)
// for whichever colors the seated players actually picked — players choose
// their own color freely in the lobby, so a fixed per-player-count color
// list can't be baked in ahead of time the way the answer/quadrant can.
// Every answer here has been verified (see tools/gen-mode-setups.js) to be
// uniquely solvable for every possible 3-to-6-color combination of seated
// players, not just a specific count, since color choice is free-form.
const NORMAL_SETUPS = [
  { quadrant: 'top-left', answerDecimal: 68 },
  { quadrant: 'top-right', answerDecimal: 29 },
  { quadrant: 'bottom-left', answerDecimal: 212 },
  { quadrant: 'bottom-right', answerDecimal: 250 },
];

const ADVANCED_SETUPS = [
  { quadrant: 'top-left', answerDecimal: 4 },
  { quadrant: 'top-right', answerDecimal: 73 },
  { quadrant: 'bottom-left', answerDecimal: 194 },
  { quadrant: 'bottom-right', answerDecimal: 238 },
];

// ==================== ENVIRONMENT DECK ====================
// 27 Coherence cards (3 of them Constructive Cascade, 24 plain Maintained)
// + 3 Noise cards = 30 total.
const COHERENCE_COMPOSITION = [
  ...Array(3).fill('cascade'),   // all players verify
  ...Array(24).fill('maintained'),
];
const NOISE_COUNT = 3;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck() {
  // Split the Coherence cards into two piles and shuffle the Noise cards into
  // only one of them, then stack that pile underneath the all-safe pile —
  // the first half of the deck is guaranteed Noise-free, and all of the
  // game's risk is loaded into the second half.
  const coherence = shuffle(COHERENCE_COMPOSITION);
  const half      = Math.ceil(coherence.length / 2);
  const safePile   = coherence.slice(0, half);
  const riskPile   = shuffle(coherence.slice(half).concat(Array(NOISE_COUNT).fill('noise')));
  // drawCard() draws via Array.pop(), so the pile drawn FIRST (the safe one)
  // must sit at the end of the array.
  return [...riskPile, ...safePile];
}

// ==================== KETS (Advance mode) ====================
// 8 decorative kets sitting on board VERTICES (grid line intersections,
// 0-16 on each axis), not inside any single cell. 4 evenly-spaced vertices
// per row — one row on the boundary between row 3 and row 4, one on the
// boundary between row 11 and row 12 (no middle/center row). Columns 0 and
// 16 are the board's own left/right border; columns 5 and 10 are the
// region-boundary columns (see getRegion). Fixed layout — same 8
// positions/types every game.
const KETS = [
  { row: 4,  col: 0,  type: 'amber1' }, { row: 4,  col: 5,  type: 'blue0'  },
  { row: 4,  col: 10, type: 'amber1' }, { row: 4,  col: 16, type: 'blue0'  },
  { row: 12, col: 0,  type: 'amber0' }, { row: 12, col: 5,  type: 'blue1'  },
  { row: 12, col: 10, type: 'amber0' }, { row: 12, col: 16, type: 'blue1'  },
];

// ==================== GAME COLORS ====================
const GAME_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
const GAME_COLOR_HEX = {
  red: '#ef4444', blue: '#3b82f6', green: '#22c55e',
  yellow: '#eab308', purple: '#a855f7', orange: '#f97316',
};

// ==================== CLUE ASSIGNMENT ====================
// Builds one game's actual clue hands, live, for whichever colors are
// actually seated (players pick their own color freely in the lobby, so
// this can't be pre-baked per player count the way the answer/quadrant is —
// see gen-mode-setups.js for the offline version of this same algorithm
// used to verify every GAME_SETUPS answer ahead of time).
//
// Greedy set-cover: for each seated color in turn, pick the clue from that
// color's book that's true for the answer and eliminates the most
// still-standing candidates. Round-robin so no single player holds all the
// narrowing power; keeps handing out extra clues per color until the whole
// group's clues (plus the public entanglement fact) narrow the board down
// to exactly one candidate cell — the answer.
const CLUES_PER_PLAYER  = 2;
const MAX_EXTRA_ROUNDS  = 40;
const ENTANGLEMENT_MIN_ID = 61;
const ENTANGLEMENT_MAX_ID = 80;
// Entanglement clue text is identical across every colour's book — this is
// just a canonical place to read it from.
const ENTANGLEMENT_BOOK = 'red';

function parseBitPositions(text) {
  let m = /^Qubit (\d+) \(from left\)/.exec(text);
  if (m) return [Number(m[1])];
  m = /^Position (\d+) and (\d+) are/.exec(text);
  if (m) return [Number(m[1]), Number(m[2])];
  return [];
}

function usedBitPositions(assignment) {
  const used = new Set();
  for (const color of Object.keys(assignment)) {
    for (const id of assignment[color]) {
      for (const bp of parseBitPositions(CLUES[color][id].text)) used.add(bp);
    }
  }
  return used;
}

const _clueMatchCache = new Map();
function clueMatches(color, id) {
  const key = color + ':' + id;
  let s = _clueMatchCache.get(key);
  if (!s) {
    s = new Set(BOARD.filter(c => evalClue(color, id, c)).map(c => c.decimal));
    _clueMatchCache.set(key, s);
  }
  return s;
}

/** Clue ids on a colour's sheet true for `answer`, respecting mode's allowed categories. */
function trueClues(color, answer, mode) {
  return Object.keys(CLUES[color] || {})
    .map(Number)
    .filter(id => mode === 'advanced' || !CLUES[color][id].advancedOnly)
    .filter(id => clueMatches(color, id).has(answer));
}

/**
 * Pick the one public entanglement clue: true for the answer, preferring
 * zero overlap with bit positions the players' own clues already cover
 * (falls back to least overlap), and preferring whichever choice narrows
 * `candidates` further.
 */
function pickPublicEntanglementClue(answer, usedBits, candidates) {
  const entIds = Object.keys(CLUES[ENTANGLEMENT_BOOK])
    .map(Number)
    .filter(id => id >= ENTANGLEMENT_MIN_ID && id <= ENTANGLEMENT_MAX_ID)
    .filter(id => clueMatches(ENTANGLEMENT_BOOK, id).has(answer));

  let best = null, bestOverlap = Infinity, bestSize = Infinity;
  for (const id of entIds) {
    const [n, m] = parseBitPositions(CLUES[ENTANGLEMENT_BOOK][id].text);
    const overlap = (usedBits.has(n) ? 1 : 0) + (usedBits.has(m) ? 1 : 0);
    const mSet = clueMatches(ENTANGLEMENT_BOOK, id);
    let size = 0;
    for (const d of candidates) if (mSet.has(d)) size++;
    if (overlap < bestOverlap || (overlap === bestOverlap && size < bestSize)) {
      bestOverlap = overlap; bestSize = size; best = id;
    }
  }
  return best;
}

/**
 * Build a uniquely-solvable clue assignment for `answer` across exactly
 * `colors` (the actual seated players' colors — any subset/order of the 6).
 * Returns { assignment: {color: [ids]}, publicClueId, remaining }.
 */
function buildClueAssignment(answer, colors, mode) {
  let candidates = new Set(BOARD.map(c => c.decimal));
  const assignment = {};
  colors.forEach(c => { assignment[c] = []; });

  function assignOneRound() {
    for (const color of colors) {
      let best = null, bestSize = Infinity, bestGlobal = Infinity;
      for (const id of trueClues(color, answer, mode)) {
        if (assignment[color].includes(id)) continue;
        if (id >= ENTANGLEMENT_MIN_ID && id <= ENTANGLEMENT_MAX_ID) continue;
        const m = clueMatches(color, id);
        let size = 0;
        for (const d of candidates) if (m.has(d)) size++;
        const global = m.size;
        if (size < bestSize || (size === bestSize && global < bestGlobal)) {
          bestSize = size; bestGlobal = global; best = id;
        }
      }
      if (best == null) continue;
      assignment[color].push(best);
      const m = clueMatches(color, best);
      candidates = new Set([...candidates].filter(d => m.has(d)));
    }
  }

  for (let round = 0; round < CLUES_PER_PLAYER; round++) assignOneRound();

  let extraRounds = 0;
  while (candidates.size > 1 && extraRounds < MAX_EXTRA_ROUNDS) {
    const before = candidates.size;
    assignOneRound();
    extraRounds++;
    if (candidates.size === before) break; // no colour had a narrowing clue left
  }

  const publicClueId = pickPublicEntanglementClue(answer, usedBitPositions(assignment), candidates);
  if (publicClueId != null) {
    const m = clueMatches(ENTANGLEMENT_BOOK, publicClueId);
    candidates = new Set([...candidates].filter(d => m.has(d)));
  }

  return { assignment, publicClueId, remaining: candidates.size };
}

// ==================== STATE MANAGEMENT ====================
let _rooms, _broadcastToRoom, _trackEvent;

function init({ rooms, broadcastToRoom, trackEvent }) {
  _rooms = rooms;
  _broadcastToRoom = broadcastToRoom;
  _trackEvent = trackEvent;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function evalClue(gameColor, clueId, cell) {
  return CLUES[gameColor]?.[clueId]?.eval(cell) ?? false;
}

function placeToken(gs, playerIdx, decimal) {
  const cell      = CELL[decimal];
  if (!cell) return;
  const gameColor = gs.playerGameColors[playerIdx];
  const clueItems = gs.playerClues[playerIdx];    // [{id, text}]
  const matches   = clueItems.every(({ id }) => evalClue(gameColor, id, cell));
  const result    = matches ? 'circle' : 'square';
  if (!gs.tokens[decimal]) gs.tokens[decimal] = [];
  gs.tokens[decimal] = gs.tokens[decimal].filter(t => t.playerIdx !== playerIdx);
  gs.tokens[decimal].push({ playerIdx, result, gameColor });
}

function drawCard(gs) {
  if (gs.deck.length === 0) {
    gs.deck = gs.discardPile.filter(c => c !== 'noise');
    gs.discardPile = [];
    for (let i = gs.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [gs.deck[i], gs.deck[j]] = [gs.deck[j], gs.deck[i]];
    }
    if (!gs.deck.length) return 'maintained';
  }
  const card = gs.deck.pop();
  gs.discardPile.push(card);
  return card;
}

// ==================== ACTIVITY LOG ====================
// A running history of what happened, newest first — public information
// only (no clue contents), so it's safe to broadcast to every player and
// observer alike. Capped so the payload/UI list never grows unbounded.
const QB_LOG_MAX = 40;
function qbLog(gs, msg) {
  // Defensive: a room's persisted qbState from before this field existed
  // (loaded back in via the server's state-persistence-across-restarts) would
  // otherwise crash every action taken on it with "Cannot read properties of
  // undefined (reading 'unshift')".
  if (!Array.isArray(gs.log)) gs.log = [];
  gs.log.unshift(msg);
  if (gs.log.length > QB_LOG_MAX) gs.log.length = QB_LOG_MAX;
}
const CARD_LOG_LABEL = {
  maintained: 'Coherence Maintained',
  cascade:    'Constructive Cascade',
  noise:      'Noise',
};

// Draws the Environment card for whoever is about to act and opens their
// Propose step — called at game start and again at the top of every turn, so
// the card is always known BEFORE a cell is proposed, not after.
// proposedCell deliberately persists past the turn boundary: it's the record
// of what the previous player just did, and the next propose overwrites it.
function startTurn(gs, room) {
  gs.currentCard = drawCard(gs);
  gs.phase = 'propose';
  const name = room.players[gs.currentPlayerIdx]?.name || 'A player';
  qbLog(gs, `${name}'s turn — ${CARD_LOG_LABEL[gs.currentCard] || gs.currentCard} drawn.`);
}

function advanceTurn(gs, room) {
  if (!gs.gameOver) {
    gs.currentPlayerIdx = (gs.currentPlayerIdx + 1) % room.players.length;
    startTurn(gs, room);
  }
}

// ==================== ACTION HANDLERS ====================

// Entanglement clue text is identical across every colour's book — this is
// just a canonical place to read the public clue's text from.
const PUBLIC_CLUE_BOOK = 'red';

function initQBGame(room) {
  // Normal boards show no bits or kets, so their 4 setups are built only
  // from clues that don't require reading either off the board; Advanced's
  // 4 setups draw from the full clue bank instead (see gen-mode-setups.js).
  // Each mode's 4 setups sit one per board quadrant, so which quadrant the
  // secret code lands in varies game to game even within a single mode.
  const mode   = room.mode === 'advanced' ? 'advanced' : 'beginner';
  const setups = mode === 'advanced' ? ADVANCED_SETUPS : NORMAL_SETUPS;
  const setupIdx = Math.floor(Math.random() * setups.length);
  const setup    = setups[setupIdx];
  // Use each player's own lobby seat color as their in-game clue/token color
  // (the two color sets are identical) rather than assigning by seat
  // position — a positional assignment could give a player a badge color
  // that doesn't match the color already shown in their name/seat elsewhere
  // in the UI (e.g. a bot named "Purple (Bot)" showing green tokens). Since
  // color is a free lobby pick (not tied to player count), the clue hands
  // are built live for whichever colors actually showed up, not pre-baked.
  const playerGameColors = room.players.map(p => p.color);
  const { assignment: clueMap, publicClueId } = buildClueAssignment(setup.answerDecimal, playerGameColors, mode);
  const playerClues = room.players.map((_, i) => {
    const gc  = playerGameColors[i];
    const ids = clueMap[gc] || [];
    // Each clue's own matching-cell list (not just the AND of the whole
    // hand) lets a player highlight one clue at a time in the UI.
    return ids.map(id => ({
      id,
      text: CLUES[gc]?.[id]?.text || '?',
      matchingCells: BOARD.filter(cell => evalClue(gc, id, cell)).map(c => c.decimal),
    }));
  });

  // Build matching-cells list for each player (which cells match ALL their clues)
  const playerMatchingCells = playerClues.map((clueItems, i) => {
    const gc = playerGameColors[i];
    return BOARD.filter(cell => clueItems.every(({ id }) => evalClue(gc, id, cell))).map(c => c.decimal);
  });

  // The one entanglement clue is never private — it's announced to the whole
  // team (players and observers alike) from the start of the game.
  const publicClue = {
    id: publicClueId,
    text: CLUES[PUBLIC_CLUE_BOOK]?.[publicClueId]?.text || '?',
  };

  room.qbState = {
    mode,
    setupIdx,
    quadrant: setup.quadrant,
    answerDecimal: setup.answerDecimal,
    playerGameColors,
    playerClues,
    playerMatchingCells,
    publicClue,
    deck:         buildDeck(),
    discardPile:  [],
    noiseCount:   0,
    phase:        'propose',
    currentPlayerIdx: 0,
    proposedCell: null,
    currentCard:  null,
    lastVerify:   null,
    tokens:       {},
    gameOver:     false,
    won:          false,
    log:          [],
  };
  // Draw the first turn's Environment card before anyone has proposed anything.
  startTurn(room.qbState, room);
}

function processPropose(room, playerIdx, decimal) {
  const gs = room.qbState;
  if (!gs || gs.gameOver)               return 'Game is over';
  if (gs.currentPlayerIdx !== playerIdx) return 'Not your turn';
  if (gs.phase !== 'propose')            return 'Not in propose phase';
  if (!CELL[decimal])                    return 'Invalid cell';
  // Rulebook: "choose one code that is consistent with your own Wavelength
  // Clue" — a proposal must be a cell the proposer's own clue actually
  // matches, which also guarantees their own token is always a circle.
  if (!gs.playerMatchingCells[playerIdx].includes(decimal)) {
    return 'That cell does not match your own clue — propose one that does';
  }

  gs.proposedCell = { decimal, row: CELL[decimal].row, col: CELL[decimal].col, binary: CELL[decimal].binary };
  gs.lastVerify   = null;

  // Active player always places their own token immediately — always a
  // circle, since the check above guarantees the cell matches their clue.
  placeToken(gs, playerIdx, decimal);
  const name = room.players[playerIdx]?.name || 'A player';
  qbLog(gs, `${name} guessed cell ${decimal}.`);

  // The Environment card for this turn was already drawn by startTurn(), so
  // it's known to the player before they propose — not revealed after.
  const card = gs.currentCard;

  if (card === 'noise') {
    gs.noiseCount++;
    if (gs.noiseCount >= 3) {
      // Third strike ends the mission immediately — no Verify this turn.
      gs.gameOver = true;
      gs.won      = false;
      gs.phase    = 'game_over';
      qbLog(gs, `⚠ Decoherence card! Third strike — mission failed.`);
      return null;
    }
    qbLog(gs, `⚠ Decoherence card drawn (strike ${gs.noiseCount}/3).`);
    // A non-fatal Noise strike doesn't otherwise interrupt the turn — the
    // player still chooses a Verify target exactly as on a Maintained card.
  }
  if (card === 'cascade') {
    // Constructive Cascade replaces the usual single-player Verify: every
    // other player checks the cell against their own clue.
    const results = [];
    for (let i = 0; i < room.players.length; i++) {
      if (i === playerIdx) continue;
      placeToken(gs, i, decimal);
      const tok = gs.tokens[decimal].find(t => t.playerIdx === i);
      const pname = room.players[i]?.name || 'Player';
      results.push(`${pname} ${tok.result === 'circle' ? 'matched ✓' : 'did not match ✗'}`);
    }
    qbLog(gs, `Cascade — everyone verified cell ${decimal}: ${results.join(', ')}.`);
    advanceTurn(gs, room);
    return null;
  }
  // 'maintained' and non-fatal 'noise': still needs its Verify — the active
  // player must choose one other player to check the cell against their clue.
  gs.phase = 'choose_verifier';
  return null;
}

function processVerify(room, playerIdx, targetIdx) {
  const gs = room.qbState;
  if (!gs || gs.gameOver)                  return 'Game is over';
  if (gs.currentPlayerIdx !== playerIdx)   return 'Not your turn';
  if (gs.phase !== 'choose_verifier')      return 'Not awaiting a Verify choice';
  if (!room.players[targetIdx])            return 'Invalid player';
  if (targetIdx === playerIdx)             return 'Choose a different player to Verify with';

  placeToken(gs, targetIdx, gs.proposedCell.decimal);
  const tok = gs.tokens[gs.proposedCell.decimal].find(t => t.playerIdx === targetIdx);
  gs.lastVerify = { targetIdx, result: tok.result };
  const targetName = room.players[targetIdx]?.name || 'Player';
  qbLog(gs, `${targetName} verified cell ${gs.proposedCell.decimal}: ${tok.result === 'circle' ? 'matched ✓' : 'did not match ✗'}.`);
  advanceTurn(gs, room);
  return null;
}

function processMeasurement(room, playerIdx, decimal) {
  const gs = room.qbState;
  if (!gs || gs.gameOver)               return 'Game is over';
  if (gs.currentPlayerIdx !== playerIdx) return 'Not your turn';
  if (gs.phase !== 'propose')            return 'Not in propose phase';
  if (!CELL[decimal])                    return 'Invalid cell';
  // Bots never call a Measurement — only a human may put the team's one shot
  // on the line. Defense in depth: nothing on the bot-turn path ever sends
  // 'qb_measure', but a stray/forged action must still be rejected here.
  if (room.players[playerIdx]?.isBot)    return 'Bots cannot call a Measurement';

  const correct = decimal === gs.answerDecimal;
  gs.gameOver = true;
  gs.won      = correct;
  gs.phase    = 'game_over';
  gs.proposedCell = { decimal, row: CELL[decimal].row, col: CELL[decimal].col, binary: CELL[decimal].binary, wasMeasurement: true };
  const name = room.players[playerIdx]?.name || 'A player';
  qbLog(gs, correct
    ? `⚛ ${name} called Measurement on cell ${decimal} — CORRECT! Mission complete.`
    : `⚛ ${name} called Measurement on cell ${decimal} — WRONG. Mission failed.`);
  return null;
}

function qbHandleAction(room, playerIdx, msg) {
  const gs = room.qbState;
  if (!gs) return;
  let err = null;
  if (msg.action === 'qb_propose') {
    err = processPropose(room, playerIdx, Number(msg.decimal));
  } else if (msg.action === 'qb_verify') {
    err = processVerify(room, playerIdx, Number(msg.targetIdx));
  } else if (msg.action === 'qb_measure') {
    err = processMeasurement(room, playerIdx, Number(msg.decimal));
  } else {
    return;
  }
  if (err) {
    const p = room.players[playerIdx];
    if (p && p.ws) send(p.ws, { type: 'error', msg: err });
    return;
  }
  qbBroadcastState(room);
  maybeScheduleBotTurn(room);
}

// ==================== BOT PLAY ====================
// A bot only ever Proposes and, when it's the active player, chooses a Verify
// target — it never calls a Measurement; that decision always waits for a
// human. Both choices are uniform-random over the information a human in that
// seat would actually have (its own matching-cell list; any other seat).
function maybeScheduleBotTurn(room) {
  const gs = room.qbState;
  if (!gs || gs.gameOver) return;
  const idx = gs.currentPlayerIdx;
  const player = room.players[idx];
  if (!player || !player.isBot) return;

  if (gs.phase === 'choose_verifier') {
    const t = setTimeout(() => {
      const gs2 = room.qbState;
      if (!gs2 || gs2.gameOver || gs2.phase !== 'choose_verifier' || gs2.currentPlayerIdx !== idx) return;
      const others = room.players.map((_, i) => i).filter(i => i !== idx);
      const targetIdx = others[Math.floor(Math.random() * others.length)];
      processVerify(room, idx, targetIdx);
      qbBroadcastState(room);
      // The turn has already advanced (possibly to another bot) — keep
      // chaining until a human is up.
      maybeScheduleBotTurn(room);
    }, 700);
    if (t.unref) t.unref();
    return;
  }

  if (gs.phase !== 'propose') return;
  const t = setTimeout(() => {
    // Re-validate — the room may have been cancelled, or the state moved on,
    // during this delay (e.g. the game ended from a Noise card elsewhere).
    const gs2 = room.qbState;
    if (!gs2 || gs2.gameOver || gs2.phase !== 'propose' || gs2.currentPlayerIdx !== idx) return;
    const matching = gs2.playerMatchingCells[idx] || [];
    // A bot's matching-cell list should never be empty (every setup card gives
    // every seat at least one clue), but fall back to any cell rather than
    // stall the game if it somehow is.
    const pool = matching.length ? matching : BOARD.map(c => c.decimal);
    const decimal = pool[Math.floor(Math.random() * pool.length)];
    processPropose(room, idx, decimal);
    qbBroadcastState(room);
    // Cascade/Noise already advanced the turn; Maintained still needs this
    // bot to choose a Verify target next.
    maybeScheduleBotTurn(room);
  }, 900);
  if (t.unref) t.unref();
}

// ==================== STATE BROADCAST ====================

function qbBroadcastState(room) {
  const gs = room.qbState;
  if (!gs) return;

  const base = {
    type: 'qb_state',
    phase: gs.phase,
    mode: gs.mode,
    setupIdx: gs.setupIdx,
    quadrant: gs.quadrant,
    currentPlayerIdx: gs.currentPlayerIdx,
    playerGameColors: gs.playerGameColors,
    publicClue:  gs.publicClue,
    noiseCount:  gs.noiseCount,
    deckCount:   gs.deck.length,
    proposedCell: gs.proposedCell,
    currentCard:  gs.currentCard,
    lastVerify:   gs.lastVerify,
    tokens:       gs.tokens,
    gameOver:     gs.gameOver,
    won:          gs.won,
    answerDecimal: gs.gameOver ? gs.answerDecimal : null,
    answerBinary:  gs.gameOver ? CELL[gs.answerDecimal]?.binary : null,
    log: gs.log,
    players: room.players.map((p, i) => ({
      name: p.name, lobbyColor: p.color,
      gameColor: gs.playerGameColors[i],
      connected: p.connected, isBot: !!p.isBot,
    })),
  };

  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (!p.connected || !p.ws) continue;
    send(p.ws, {
      ...base,
      myPlayerIdx:     i,
      myGameColor:     gs.playerGameColors[i],
      myClues:         gs.playerClues[i],
      myMatchingCells: gs.playerMatchingCells[i],
    });
  }

  for (const o of (room.observers || [])) {
    if (!o.connected || !o.ws) continue;
    send(o.ws, {
      ...base,
      myPlayerIdx: -1,
      myGameColor: null,
      myClues:     null,
      myMatchingCells: [],
      allClues:          gs.playerClues,
      allMatchingCells:  gs.playerMatchingCells,
    });
  }
}

module.exports = {
  init,
  initQBGame,
  qbHandleAction,
  qbBroadcastState,
  maybeScheduleBotTurn,
  BOARD,
  CELL,
  KETS,
  GAME_COLORS,
  GAME_COLOR_HEX,
  // Exposed for the setup generator (tools/gen-mode-setups.js) and solvability tests.
  CLUES,
  NORMAL_SETUPS,
  ADVANCED_SETUPS,
  evalClue,
  buildClueAssignment,
};
