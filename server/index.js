import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8787;
const START_CLOCK_MS = 5 * 60 * 1000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Stratego Chess server\n');
});

const wss = new WebSocketServer({ server });

const rooms = new Map();

function makeId() {
  return crypto.randomBytes(6).toString('hex');
}

function createEmptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}

function addPiece(state, type, color, x, y) {
  const id = makeId();
  state.pieces.set(id, { id, type, color, isFlag: false });
  state.board[y][x] = id;
}

function createInitialState() {
  const board = createEmptyBoard();
  const pieces = new Map();
  const state = {
    board,
    pieces,
    turn: 'w',
    enPassant: null,
    clocks: { w: START_CLOCK_MS, b: START_CLOCK_MS },
    lastTick: Date.now(),
    running: false,
    gameOver: false,
    winner: null,
    reason: null,
    flags: { w: null, b: null },
    playersReady: { w: false, b: false },
    incrementMs: 0,
    lastMove: null,
    moves: [],
    drawOfferedBy: null
  };

  const backRank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
  for (let x = 0; x < 8; x++) {
    addPiece(state, backRank[x], 'w', x, 7);
    addPiece(state, 'P', 'w', x, 6);
    addPiece(state, backRank[x], 'b', x, 0);
    addPiece(state, 'P', 'b', x, 1);
  }

  return state;
}

function getRoom(code) {
  if (!rooms.has(code)) {
    const room = {
      code,
      state: createInitialState(),
      players: { w: null, b: null },
      spectators: new Set(),
      tickInterval: null,
      lastClockBroadcast: { w: START_CLOCK_MS, b: START_CLOCK_MS },
      clockConfig: { minutes: 5, increment: 0 }
    };
    room.tickInterval = setInterval(() => tickRoom(room), 250);
    rooms.set(code, room);
  }
  return rooms.get(code);
}

function coordsToAlgebraic(x, y) {
  return String.fromCharCode(97 + x) + (8 - y);
}

function algebraicToCoords(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10);
  return { x: file, y: 8 - rank };
}

function formatSAN(piece, from, to, capture, promotion) {
  const dest = coordsToAlgebraic(to.x, to.y);
  const isPawn = piece.type === 'P';
  const pieceLetter = isPawn ? '' : piece.type;
  const captureMark = capture ? 'x' : '';
  const originFile = String.fromCharCode(97 + from.x);
  const pawnPrefix = isPawn && capture ? originFile : '';
  const promo = promotion ? '=Q' : '';
  return `${pieceLetter}${pawnPrefix}${captureMark}${dest}${promo}`;
}

function serializeState(state, perspective) {
  const revealFlags = state.gameOver;
  const board = state.board.map((row, y) =>
    row.map((id, x) => {
      if (!id) return null;
      const piece = state.pieces.get(id);
      return {
        id,
        type: piece.type,
        color: piece.color,
        isFlag: revealFlags ? piece.isFlag : (piece.isFlag && piece.color === perspective)
      };
    })
  );

  return {
    board,
    turn: state.turn,
    enPassant: state.enPassant,
    clocks: state.clocks,
    running: state.running,
    gameOver: state.gameOver,
    winner: state.winner,
    reason: state.reason,
    playersReady: state.playersReady,
    flagId: revealFlags ? null : (perspective === 'w' || perspective === 'b' ? state.flags[perspective] : null),
    incrementMs: state.incrementMs,
    lastMove: state.lastMove,
    moves: state.moves,
    drawOfferedBy: state.drawOfferedBy
  };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg) {
  if (room.players.w) send(room.players.w, msg);
  if (room.players.b) send(room.players.b, msg);
  for (const ws of room.spectators) send(ws, msg);
}

function broadcastState(room) {
  if (room.players.w) {
    send(room.players.w, { type: 'state', state: serializeState(room.state, 'w') });
  }
  if (room.players.b) {
    send(room.players.b, { type: 'state', state: serializeState(room.state, 'b') });
  }
  for (const ws of room.spectators) {
    send(ws, { type: 'state', state: serializeState(room.state, 'w') });
  }
}

function tickRoom(room) {
  const state = room.state;
  if (!state.running || state.gameOver) return;
  const now = Date.now();
  const elapsed = now - state.lastTick;
  state.lastTick = now;
  state.clocks[state.turn] -= elapsed;

  if (state.clocks[state.turn] <= 0) {
    state.clocks[state.turn] = 0;
    state.gameOver = true;
    state.running = false;
    state.winner = state.turn === 'w' ? 'b' : 'w';
    state.reason = 'timeout';
    broadcastState(room);
    return;
  }

  const curSeconds = {
    w: Math.floor(state.clocks.w / 1000),
    b: Math.floor(state.clocks.b / 1000)
  };
  const lastSeconds = {
    w: Math.floor(room.lastClockBroadcast.w / 1000),
    b: Math.floor(room.lastClockBroadcast.b / 1000)
  };

  if (curSeconds.w !== lastSeconds.w || curSeconds.b !== lastSeconds.b) {
    room.lastClockBroadcast = { ...state.clocks };
    broadcast(room, { type: 'clock', clocks: state.clocks, turn: state.turn });
  }
}

function isInside(x, y) {
  return x >= 0 && x < 8 && y >= 0 && y < 8;
}

function getPieceAt(state, x, y) {
  const id = state.board[y][x];
  return id ? state.pieces.get(id) : null;
}

function generateMoves(state, color) {
  const moves = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const id = state.board[y][x];
      if (!id) continue;
      const piece = state.pieces.get(id);
      if (piece.color !== color) continue;

      switch (piece.type) {
        case 'P':
          generatePawnMoves(state, moves, x, y, piece);
          break;
        case 'N':
          generateKnightMoves(state, moves, x, y, piece);
          break;
        case 'B':
          generateSlidingMoves(state, moves, x, y, piece, [[1,1],[1,-1],[-1,1],[-1,-1]]);
          break;
        case 'R':
          generateSlidingMoves(state, moves, x, y, piece, [[1,0],[-1,0],[0,1],[0,-1]]);
          break;
        case 'Q':
          generateSlidingMoves(state, moves, x, y, piece, [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]);
          break;
        case 'K':
          generateKingMoves(state, moves, x, y, piece);
          break;
        default:
          break;
      }
    }
  }
  return moves;
}

function addMove(moves, from, to, options = {}) {
  moves.push({ from, to, ...options });
}

function generatePawnMoves(state, moves, x, y, piece) {
  const dir = piece.color === 'w' ? -1 : 1;
  const startRank = piece.color === 'w' ? 6 : 1;
  const lastRank = piece.color === 'w' ? 0 : 7;

  const oneStep = y + dir;
  if (isInside(x, oneStep) && !state.board[oneStep][x]) {
    addMove(moves, { x, y }, { x, y: oneStep }, { promotion: oneStep === lastRank });
    const twoStep = y + dir * 2;
    if (y === startRank && !state.board[twoStep][x]) {
      addMove(moves, { x, y }, { x, y: twoStep }, { doubleStep: true });
    }
  }

  for (const dx of [-1, 1]) {
    const nx = x + dx;
    const ny = y + dir;
    if (!isInside(nx, ny)) continue;
    const targetId = state.board[ny][nx];
    if (targetId) {
      const target = state.pieces.get(targetId);
      if (target.color !== piece.color) {
        addMove(moves, { x, y }, { x: nx, y: ny }, { capture: true, promotion: ny === lastRank });
      }
    } else if (state.enPassant && state.enPassant.x === nx && state.enPassant.y === ny) {
      addMove(moves, { x, y }, { x: nx, y: ny }, { enPassant: true });
    }
  }
}

function generateKnightMoves(state, moves, x, y, piece) {
  const deltas = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
  for (const [dx, dy] of deltas) {
    const nx = x + dx;
    const ny = y + dy;
    if (!isInside(nx, ny)) continue;
    const targetId = state.board[ny][nx];
    if (!targetId || state.pieces.get(targetId).color !== piece.color) {
      addMove(moves, { x, y }, { x: nx, y: ny }, { capture: !!targetId });
    }
  }
}

function generateSlidingMoves(state, moves, x, y, piece, deltas) {
  for (const [dx, dy] of deltas) {
    let nx = x + dx;
    let ny = y + dy;
    while (isInside(nx, ny)) {
      const targetId = state.board[ny][nx];
      if (!targetId) {
        addMove(moves, { x, y }, { x: nx, y: ny });
      } else {
        if (state.pieces.get(targetId).color !== piece.color) {
          addMove(moves, { x, y }, { x: nx, y: ny }, { capture: true });
        }
        break;
      }
      nx += dx;
      ny += dy;
    }
  }
}

function generateKingMoves(state, moves, x, y, piece) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (!isInside(nx, ny)) continue;
      const targetId = state.board[ny][nx];
      if (!targetId || state.pieces.get(targetId).color !== piece.color) {
        addMove(moves, { x, y }, { x: nx, y: ny }, { capture: !!targetId });
      }
    }
  }
}

function applyMove(state, move) {
  const fromId = state.board[move.from.y][move.from.x];
  if (!fromId) return { ok: false, error: 'no piece' };
  const piece = state.pieces.get(fromId);

  const legalMoves = generateMoves(state, piece.color);
  const legalMove = legalMoves.find(m =>
    m.from.x === move.from.x && m.from.y === move.from.y && m.to.x === move.to.x && m.to.y === move.to.y
  );
  if (!legalMove) return { ok: false, error: 'illegal move' };

  let capturedId = state.board[move.to.y][move.to.x];
  const isEnPassant = !!legalMove.enPassant;
  if (isEnPassant) {
    const dir = piece.color === 'w' ? 1 : -1;
    capturedId = state.board[move.to.y + dir][move.to.x];
    state.board[move.to.y + dir][move.to.x] = null;
  }
  const capture = !!capturedId || isEnPassant;
  const promotion = piece.type === 'P' && (move.to.y === (piece.color === 'w' ? 0 : 7));

  if (capturedId) {
    const captured = state.pieces.get(capturedId);
    if (captured.isFlag) {
      state.gameOver = true;
      state.running = false;
      state.winner = piece.color;
      state.reason = 'flag captured';
    }
    state.pieces.delete(capturedId);
  }

  state.board[move.from.y][move.from.x] = null;
  state.board[move.to.y][move.to.x] = fromId;

  if (piece.type === 'P') {
    const lastRank = piece.color === 'w' ? 0 : 7;
    if (move.to.y === lastRank) {
      piece.type = 'Q';
    }
  }

  if (!state.gameOver && state.incrementMs > 0) {
    state.clocks[piece.color] += state.incrementMs;
  }

  state.lastMove = { from: move.from, to: move.to };
  const san = formatSAN(piece, move.from, move.to, capture, promotion);
  const ply = state.moves.length;
  const moveNo = Math.floor(ply / 2) + 1;
  const prefix = piece.color === 'w' ? `${moveNo}. ` : `${moveNo}... `;
  state.moves.push(prefix + san);

  state.enPassant = null;
  if (piece.type === 'P' && Math.abs(move.to.y - move.from.y) === 2) {
    const dir = piece.color === 'w' ? -1 : 1;
    state.enPassant = { x: move.from.x, y: move.from.y + dir };
  }

  return { ok: true };
}

function startGameIfReady(room) {
  const state = room.state;
  if (state.playersReady.w && state.playersReady.b && !state.running && !state.gameOver) {
    state.running = true;
    state.lastTick = Date.now();
    broadcastState(room);
  }
}

function handleChooseFlag(room, ws, color, square) {
  if (!square) return;
  const coords = algebraicToCoords(square);
  if (!isInside(coords.x, coords.y)) return;
  const id = room.state.board[coords.y][coords.x];
  if (!id) return;
  const piece = room.state.pieces.get(id);
  if (piece.color !== color || piece.type !== 'P') return;

  if (room.state.flags[color] && room.state.flags[color] !== id) {
    const oldFlagId = room.state.flags[color];
    const oldFlag = room.state.pieces.get(oldFlagId);
    if (oldFlag) oldFlag.isFlag = false;
  }

  piece.isFlag = true;
  room.state.flags[color] = id;
  room.state.playersReady[color] = true;
  startGameIfReady(room);
  broadcastState(room);
}

function handleMove(room, color, move) {
  if (room.state.gameOver || !room.state.running) return;
  if (room.state.turn !== color) return;

  const result = applyMove(room.state, move);
  if (!result.ok) return;

  if (!room.state.gameOver) {
    room.state.turn = room.state.turn === 'w' ? 'b' : 'w';
    const nextMoves = generateMoves(room.state, room.state.turn);
    if (nextMoves.length === 0) {
      room.state.gameOver = true;
      room.state.running = false;
      room.state.winner = room.state.turn === 'w' ? 'b' : 'w';
      room.state.reason = 'no legal moves';
    }
  }

  room.state.lastTick = Date.now();
  broadcastState(room);
}

function handleClockConfig(room, ws, color, minutes, increment) {
  if (room.state.running || room.state.gameOver) return;
  if (!['w', 'b'].includes(color)) return;
  const m = Math.max(1, Math.min(60, parseInt(minutes, 10) || 5));
  const inc = Math.max(0, Math.min(30, parseInt(increment, 10) || 0));
  room.clockConfig = { minutes: m, increment: inc };
  room.state.clocks = { w: m * 60 * 1000, b: m * 60 * 1000 };
  room.state.incrementMs = inc * 1000;
  room.lastClockBroadcast = { ...room.state.clocks };
  broadcast(room, { type: 'clock_config', minutes: m, increment: inc, clocks: room.state.clocks });
  broadcastState(room);
}

function handleResign(room, color) {
  if (room.state.gameOver) return;
  room.state.gameOver = true;
  room.state.running = false;
  room.state.winner = color === 'w' ? 'b' : 'w';
  room.state.reason = 'resign';
  broadcast(room, { type: 'notice', text: `${color === 'w' ? 'White' : 'Black'} resigned.` });
  broadcastState(room);
}

function handleOfferDraw(room, color) {
  if (room.state.gameOver) return;
  room.state.drawOfferedBy = color;
  broadcast(room, { type: 'notice', text: `${color === 'w' ? 'White' : 'Black'} offered a draw.` });
  broadcastState(room);
}

function handleAcceptDraw(room, color) {
  if (room.state.gameOver) return;
  if (!room.state.drawOfferedBy || room.state.drawOfferedBy === color) return;
  room.state.gameOver = true;
  room.state.running = false;
  room.state.winner = null;
  room.state.reason = 'draw';
  room.state.drawOfferedBy = null;
  broadcast(room, { type: 'notice', text: 'Draw agreed.' });
  broadcastState(room);
}

function handleDeclineDraw(room, color) {
  if (room.state.gameOver) return;
  if (!room.state.drawOfferedBy || room.state.drawOfferedBy === color) return;
  room.state.drawOfferedBy = null;
  broadcast(room, { type: 'notice', text: `${color === 'w' ? 'White' : 'Black'} declined the draw.` });
  broadcastState(room);
}

wss.on('connection', (ws) => {
  let room = null;
  let color = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return;
    }

    if (msg.type === 'hello') {
      const code = (msg.room || '').trim().toUpperCase();
      room = getRoom(code || 'DEFAULT');
      if (!room.players.w) {
        room.players.w = ws;
        color = 'w';
      } else if (!room.players.b) {
        room.players.b = ws;
        color = 'b';
      } else {
        room.spectators.add(ws);
        color = 'spectator';
      }

      send(ws, {
        type: 'joined',
        room: room.code,
        color,
        state: serializeState(room.state, color === 'b' ? 'b' : 'w'),
        clock: room.clockConfig
      });
      return;
    }

    if (!room || !color || color === 'spectator') return;

    if (msg.type === 'choose_flag') {
      handleChooseFlag(room, ws, color, msg.square);
      return;
    }

    if (msg.type === 'move') {
      handleMove(room, color, msg.move);
    }

    if (msg.type === 'set_clock') {
      handleClockConfig(room, ws, color, msg.minutes, msg.increment);
    }

    if (msg.type === 'resign') {
      handleResign(room, color);
    }

    if (msg.type === 'offer_draw') {
      handleOfferDraw(room, color);
    }

    if (msg.type === 'accept_draw') {
      handleAcceptDraw(room, color);
    }

    if (msg.type === 'decline_draw') {
      handleDeclineDraw(room, color);
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (room.players.w === ws) room.players.w = null;
    if (room.players.b === ws) room.players.b = null;
    room.spectators.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Stratego Chess server running on ${PORT}`);
});
