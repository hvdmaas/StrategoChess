const serverInput = document.getElementById('server');
const nameInput = document.getElementById('name');
const roomInput = document.getElementById('room');
const createBtn = document.getElementById('create');
const joinBtn = document.getElementById('join');
const localStartBtn = document.getElementById('local-start');
const modeSelect = document.getElementById('mode');
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const instructionsEl = document.getElementById('instructions');
const clockW = document.getElementById('clock-w');
const clockB = document.getElementById('clock-b');
const clockWhiteWrap = document.getElementById('clock-white');
const clockBlackWrap = document.getElementById('clock-black');
const clockMinInput = document.getElementById('clock-min');
const clockIncInput = document.getElementById('clock-inc');
const clockApplyBtn = document.getElementById('clock-apply');
const flipBoardSelect = document.getElementById('flip-board');
const opponentSelect = document.getElementById('opponent');
const aiRerollBtn = document.getElementById('ai-reroll');
const puzzleSelect = document.getElementById('puzzle');
const puzzleStartBtn = document.getElementById('puzzle-start');
const overlayEl = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayText = document.getElementById('overlay-text');
const overlayBtn = document.getElementById('overlay-btn');
const moveListEl = document.getElementById('move-list');
const resignBtn = document.getElementById('resign');
const offerDrawBtn = document.getElementById('offer-draw');
const acceptDrawBtn = document.getElementById('accept-draw');
const declineDrawBtn = document.getElementById('decline-draw');

let ws = null;
let playerColor = null;
let gameState = null;
let selected = null;
let localMode = false;
let localView = 'w';
let localOverlayLocked = false;
let localTick = null;
let lastGameOver = false;
let localClockBaseMs = 5 * 60 * 1000;
let localClockIncrementMs = 0;
let flipBoardForBlack = true;
let myFlagId = null;
let aiEnabled = false;
const aiColor = 'b';
let aiPendingTimeout = null;
let lastAiMoveKey = null;
let lastAiState = null;
let puzzleMode = false;
let puzzlePlayerColor = 'w';

const PIECES = {
  w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' },
  b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' }
};

function log(msg) {
  logEl.textContent = msg;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function randomRoom() {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

function getDefaultServer() {
  return 'ws://localhost:8787';
}

function connect() {
  const server = serverInput.value.trim();
  const room = roomInput.value.trim();
  const name = nameInput.value.trim() || 'Player';

  if (!server || !room) {
    log('Enter server URL and room code.');
    return;
  }

  localMode = false;
  overlayHide();
  aiEnabled = false;

  if (ws) ws.close();
  ws = new WebSocket(server);

  ws.onopen = () => {
    setStatus('Connected');
    ws.send(JSON.stringify({ type: 'hello', room, name }));
  };

  ws.onclose = () => {
    setStatus('Disconnected');
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'joined') {
      playerColor = msg.color;
      gameState = msg.state;
      if (msg.clock) {
        clockMinInput.value = msg.clock.minutes;
        clockIncInput.value = msg.clock.increment;
      }
      myFlagId = msg.state.flagId || null;
      render();
      log(`Joined room ${msg.room} as ${playerColor.toUpperCase()}`);
      if (playerColor !== 'spectator') {
        applyClockSettings();
      }
      return;
    }

    if (msg.type === 'state') {
      gameState = msg.state;
      myFlagId = msg.state.flagId || myFlagId;
      render();
      return;
    }

    if (msg.type === 'clock') {
      if (gameState) {
        gameState.clocks = msg.clocks;
        gameState.turn = msg.turn;
      }
      updateClocks();
    }

    if (msg.type === 'notice') {
      log(msg.text);
    }

    if (msg.type === 'clock_config') {
      clockMinInput.value = msg.minutes;
      clockIncInput.value = msg.increment;
      if (gameState) {
        gameState.clocks = msg.clocks;
      }
      updateClocks();
      log(`Clock set to ${msg.minutes}+${msg.increment}.`);
    }
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function render() {
  if (!gameState) return;
  if (!gameState.gameOver) lastGameOver = false;
  updateClocks();
  renderBoard();
  updateInstructions();
  updateMoveList();
  updateAiControls();
  updateActionButtons();
  if (localMode && aiEnabled && gameState.running && !gameState.gameOver && gameState.turn === aiColor && !aiPendingTimeout) {
    maybeAiMove();
  }
}

function updateClocks() {
  if (!gameState) return;
  clockW.textContent = fmt(gameState.clocks.w);
  clockB.textContent = fmt(gameState.clocks.b);
  clockWhiteWrap.classList.toggle('active', gameState.turn === 'w' && gameState.running);
  clockBlackWrap.classList.toggle('active', gameState.turn === 'b' && gameState.running);
}

function updateInstructions() {
  if (!gameState) return;
  if (playerColor === 'spectator') {
    instructionsEl.innerHTML = `<h3>Spectating</h3><p>Waiting for players to join and choose their flags.</p>`;
    return;
  }
  if (gameState.gameOver) {
    const winnerName = gameState.winner ? (gameState.winner === 'w' ? 'White' : 'Black') : 'Draw';
    instructionsEl.innerHTML = `<h3>Game Over</h3><p>Winner: ${winnerName} (${gameState.reason}). Flags revealed.</p>`;
    log(`Game over. Winner: ${winnerName}. Reason: ${gameState.reason}.`);
    showGameOverOverlay(winnerName, gameState.reason);
    return;
  }

  const currentColor = localMode ? localView : playerColor;
  if (!gameState.playersReady[currentColor]) {
    instructionsEl.innerHTML = `<h3>Choose Your Flag</h3><p>Click one of your pawns to mark it as the hidden flag.</p>`;
    return;
  }

  if (gameState.drawOfferedBy) {
    const offerColor = gameState.drawOfferedBy;
    if (offerColor === currentColor) {
      instructionsEl.innerHTML = `<h3>Draw Offered</h3><p>You offered a draw. Waiting for opponent to respond.</p>`;
    } else {
      instructionsEl.innerHTML = `<h3>Draw Offered</h3><p>${offerColor === 'w' ? 'White' : 'Black'} offered a draw. Accept or decline?</p>`;
    }
    return;
  }

  instructionsEl.innerHTML = `<h3>Play</h3><p>Game in progress.</p>`;
}

function renderBoard() {
  boardEl.innerHTML = '';
  const flip = (localMode ? localView : playerColor) === 'b' && flipBoardForBlack;
  const viewColor = localMode ? localView : playerColor;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const x = flip ? 7 - c : c;
      const y = flip ? 7 - r : r;
      const square = document.createElement('div');
      square.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
      square.dataset.x = x;
      square.dataset.y = y;

      if (selected && selected.x === x && selected.y === y) {
        square.classList.add('selected');
      }

      const piece = getPieceAt(x, y);
      if (piece) {
        const pieceEl = document.createElement('div');
        pieceEl.className = `piece ${piece.color}${piece.type}`;
        square.appendChild(pieceEl);
        const showFlag = (
          (gameState.gameOver && piece.isFlag) ||
          (!localMode && myFlagId && piece.id === myFlagId) ||
          (localMode && !gameState.running && !gameState.playersReady[viewColor] && piece.isFlag && piece.color === viewColor) ||
          (localMode && puzzleMode && piece.isFlag && piece.color === viewColor) ||
          (localMode && gameState.running && piece.isFlag && piece.color === 'w')
        );
        if (showFlag) square.classList.add('flagged');

        if (canDragPiece(piece, viewColor)) {
          pieceEl.setAttribute('draggable', 'true');
          pieceEl.addEventListener('dragstart', (e) => {
            selected = { x, y };
            e.dataTransfer.setData('text/plain', JSON.stringify({ x, y }));
            e.dataTransfer.effectAllowed = 'move';
          });
        }
      }

      square.addEventListener('dragover', (e) => e.preventDefault());
      square.addEventListener('drop', (e) => {
        e.preventDefault();
        let data = e.dataTransfer.getData('text/plain');
        if (data) {
          try {
            const from = JSON.parse(data);
            selected = from;
            handleSquareClick(x, y);
          } catch (err) {}
        }
      });

      square.addEventListener('click', () => handleSquareClick(x, y));
      if (gameState.lastMove) {
        const lm = gameState.lastMove;
        if ((lm.from.x === x && lm.from.y === y) || (lm.to.x === x && lm.to.y === y)) {
          square.classList.add('last-move');
        }
      }
      boardEl.appendChild(square);
    }
  }
}

function canDragPiece(piece, viewColor) {
  if (!piece) return false;
  if (localMode) {
    if (localOverlayLocked) return false;
    if (!gameState.running && !gameState.playersReady[viewColor]) return true;
    return gameState.turn === viewColor && gameState.running && piece.color === viewColor;
  }
  if (playerColor === 'spectator') return false;
  if (!gameState.playersReady[playerColor]) return piece.color === playerColor && piece.type === 'P';
  return gameState.turn === playerColor && gameState.running && piece.color === playerColor;
}

function handleSquareClick(x, y) {
  if (!gameState) return;

  if (localMode) {
    handleLocalClick(x, y);
    return;
  }

  if (playerColor === 'spectator') return;
  const piece = getPieceAt(x, y);

  if (!gameState.playersReady[playerColor]) {
    if (piece && piece.color === playerColor && piece.type === 'P') {
      send({ type: 'choose_flag', square: coordsToAlg(x, y) });
    }
    return;
  }

  if (gameState.gameOver || !gameState.running) return;
  if (gameState.turn !== playerColor) return;

  if (!selected) {
    if (piece && piece.color === playerColor) {
      selected = { x, y };
      renderBoard();
    }
    return;
  }

  if (selected.x === x && selected.y === y) {
    selected = null;
    renderBoard();
    return;
  }

  const move = { from: { x: selected.x, y: selected.y }, to: { x, y } };
  send({ type: 'move', move });
  selected = null;
  renderBoard();
}

function handleLocalClick(x, y) {
  const piece = getPieceAt(x, y);
  const viewColor = localView;

  // Allow flag selection even if overlay is still up.
  if (!gameState.playersReady[viewColor]) {
    if (piece && piece.color === viewColor && piece.type === 'P') {
      chooseFlagLocal(viewColor, x, y);
    }
    return;
  }

  if (localOverlayLocked) return;
  if (gameState.gameOver || !gameState.running) return;
  if (gameState.turn !== viewColor) return;

  if (!selected) {
    if (piece && piece.color === viewColor) {
      selected = { x, y };
      renderBoard();
    }
    return;
  }

  if (selected.x === x && selected.y === y) {
    selected = null;
    renderBoard();
    return;
  }

  const move = { from: { x: selected.x, y: selected.y }, to: { x, y } };
  const result = applyMoveLocal(move);
  selected = null;
  if (result.ok) {
    endLocalTurn();
  }
  render();
}

function coordsToAlg(x, y) {
  return String.fromCharCode(97 + x) + (8 - y);
}

function formatSANLocal(piece, from, to, capture, promotion) {
  const dest = coordsToAlg(to.x, to.y);
  const isPawn = piece.type === 'P';
  const pieceLetter = isPawn ? '' : piece.type;
  const captureMark = capture ? 'x' : '';
  const originFile = String.fromCharCode(97 + from.x);
  const pawnPrefix = isPawn && capture ? originFile : '';
  const promo = promotion ? '=Q' : '';
  return `${pieceLetter}${pawnPrefix}${captureMark}${dest}${promo}`;
}

function startLocalGame() {
  localMode = true;
  playerColor = 'w';
  localView = 'w';
  localOverlayLocked = true;
  lastGameOver = false;
  myFlagId = null;
  lastAiMoveKey = null;
  lastAiState = null;
  puzzleMode = false;
  applyClockSettings();
  gameState = createInitialState();
  render();
  setStatus('Offline');
  log('Local game started. White chooses a flag first.');
  showOverlay('White player', 'Choose your flag pawn. Then pass the device.', 'I am White');
  if (aiEnabled) {
    autoChooseFlag(aiColor);
  }
  startLocalClock();
}

function showOverlay(title, text, btnText) {
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  overlayBtn.textContent = btnText;
  overlayEl.classList.remove('hidden');
  localOverlayLocked = true;
}

function overlayHide() {
  overlayEl.classList.add('hidden');
  localOverlayLocked = false;
}

overlayBtn.addEventListener('click', () => {
  overlayHide();
  render();
});

overlayEl.addEventListener('click', (e) => {
  if (e.target === overlayEl) {
    overlayHide();
    render();
  }
});

function endLocalTurn() {
  if (gameState.gameOver) return;
  gameState.turn = gameState.turn === 'w' ? 'b' : 'w';
  localView = gameState.turn;
  const nextMoves = generateMoves(gameState, gameState.turn);
  if (nextMoves.length === 0) {
    gameState.gameOver = true;
    gameState.running = false;
    gameState.winner = gameState.turn === 'w' ? 'b' : 'w';
    gameState.reason = 'no legal moves';
  }
  gameState.lastTick = Date.now();
  if (gameState.gameOver) {
    const winner = gameState.winner ? gameState.winner.toUpperCase() : 'None';
    showGameOverOverlay(winner, gameState.reason);
  }
  render();
  // Note: render() already calls maybeAiMove() for AI, no need to duplicate
}

function showGameOverOverlay(winner, reason) {
  if (lastGameOver) return;
  lastGameOver = true;
  showOverlay('Game Over', `Winner: ${winner}. Reason: ${reason}. Flags revealed.`, 'Close');
}

function chooseFlagLocal(color, x, y) {
  const id = gameState.board[y][x];
  if (!id) return;
  const piece = gameState.pieces.get(id);
  if (piece.color !== color || piece.type !== 'P') return;

  if (gameState.flags[color] && gameState.flags[color] !== id) {
    const oldFlag = gameState.pieces.get(gameState.flags[color]);
    if (oldFlag) oldFlag.isFlag = false;
  }
  piece.isFlag = true;
  gameState.flags[color] = id;
  gameState.playersReady[color] = true;

  if (gameState.playersReady.w && gameState.playersReady.b) {
    gameState.running = true;
    gameState.lastTick = Date.now();
    gameState.turn = 'w';
    localView = 'w';
    overlayHide();
  } else {
    localView = color === 'w' ? 'b' : 'w';
    if (!aiEnabled) {
      showOverlay(`${localView === 'w' ? 'White' : 'Black'} player`, 'Choose your flag pawn.', `I am ${localView === 'w' ? 'White' : 'Black'}`);
    }
  }
  render();
}

function startLocalClock() {
  if (localTick) clearInterval(localTick);
  localTick = setInterval(() => {
    if (!localMode || !gameState || !gameState.running || gameState.gameOver) return;
    const now = Date.now();
    const elapsed = now - gameState.lastTick;
    gameState.lastTick = now;
    gameState.clocks[gameState.turn] -= elapsed;
    if (gameState.clocks[gameState.turn] <= 0) {
      gameState.clocks[gameState.turn] = 0;
      gameState.gameOver = true;
      gameState.running = false;
      gameState.winner = gameState.turn === 'w' ? 'b' : 'w';
      gameState.reason = 'timeout';
      const winner = gameState.winner ? gameState.winner.toUpperCase() : 'None';
      showGameOverOverlay(winner, gameState.reason);
    }
    updateClocks();
  }, 200);
}

function createInitialState() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  const pieces = new Map();
  const state = {
    board,
    pieces,
    turn: 'w',
    enPassant: null,
    clocks: { w: localClockBaseMs, b: localClockBaseMs },
    lastTick: Date.now(),
    running: false,
    gameOver: false,
    winner: null,
    reason: null,
    flags: { w: null, b: null },
    playersReady: { w: false, b: false },
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

function addPiece(state, type, color, x, y) {
  const id = Math.random().toString(36).slice(2, 10);
  state.pieces.set(id, { id, type, color, isFlag: false });
  state.board[y][x] = id;
}

function getPieceAt(x, y) {
  const cell = gameState.board[y][x];
  if (!cell) return null;
  if (typeof cell === 'string') {
    return gameState.pieces.get(cell);
  }
  return cell;
}

function applyMoveLocal(move) {
  const fromId = gameState.board[move.from.y][move.from.x];
  if (!fromId) return { ok: false, error: 'no piece' };
  const piece = gameState.pieces.get(fromId);

  const legalMoves = generateMoves(gameState, piece.color);
  const legalMove = legalMoves.find(m =>
    m.from.x === move.from.x && m.from.y === move.from.y && m.to.x === move.to.x && m.to.y === move.to.y
  );
  if (!legalMove) return { ok: false, error: 'illegal move' };

  let capturedId = gameState.board[move.to.y][move.to.x];
  const isEnPassant = !!legalMove.enPassant;
  const capture = !!capturedId || isEnPassant;
  if (legalMove.enPassant) {
    const dir = piece.color === 'w' ? 1 : -1;
    capturedId = gameState.board[move.to.y + dir][move.to.x];
    gameState.board[move.to.y + dir][move.to.x] = null;
  }

  if (capturedId) {
    const captured = gameState.pieces.get(capturedId);
    if (captured.isFlag) {
      gameState.gameOver = true;
      gameState.running = false;
      gameState.winner = piece.color;
      gameState.reason = 'flag captured';
    }
    gameState.pieces.delete(capturedId);
  }

  gameState.board[move.from.y][move.from.x] = null;
  gameState.board[move.to.y][move.to.x] = fromId;

  const promotion = piece.type === 'P' && (move.to.y === (piece.color === 'w' ? 0 : 7));
  if (piece.type === 'P') {
    const lastRank = piece.color === 'w' ? 0 : 7;
    if (move.to.y === lastRank) {
      piece.type = 'Q';
    }
  }

  if (!gameState.gameOver && localClockIncrementMs > 0) {
    gameState.clocks[piece.color] += localClockIncrementMs;
  }

  gameState.lastMove = { from: move.from, to: move.to };
  const san = formatSANLocal(piece, move.from, move.to, capture, promotion);
  const ply = gameState.moves.length;
  const moveNo = Math.floor(ply / 2) + 1;
  const prefix = piece.color === 'w' ? `${moveNo}. ` : `${moveNo}... `;
  gameState.moves.push(prefix + san);

  gameState.enPassant = null;
  if (piece.type === 'P' && Math.abs(move.to.y - move.from.y) === 2) {
    const dir = piece.color === 'w' ? -1 : 1;
    gameState.enPassant = { x: move.from.x, y: move.from.y + dir };
  }

  return { ok: true };
}

function autoChooseFlag(color) {
  const row = color === 'w' ? 6 : 1;
  const candidates = [];
  for (let x = 0; x < 8; x++) {
    const id = gameState.board[row][x];
    if (!id) continue;
    const piece = gameState.pieces.get(id);
    if (piece && piece.type === 'P' && piece.color === color) candidates.push({ x, y: row });
  }
  if (candidates.length === 0) return;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  chooseFlagLocal(color, pick.x, pick.y);
}

function maybeAiMove() {
  if (!localMode || !aiEnabled) return;
  if (!gameState.running || gameState.gameOver) return;
  if (gameState.turn !== aiColor) return;
  if (aiPendingTimeout) clearTimeout(aiPendingTimeout);
  aiPendingTimeout = setTimeout(() => {
    executeAiMove(false);
  }, 1200);
  updateAiControls();
}

function executeAiMove(forceDifferent) {
  aiPendingTimeout = null;
  if (!localMode || !aiEnabled) return;
  if (!gameState.running || gameState.gameOver) return;
  if (gameState.turn !== aiColor) return;
  const moves = generateMoves(gameState, aiColor);
  if (moves.length === 0) {
    // No legal moves available - end turn to trigger game over logic
    endLocalTurn();
    return;
  }
  const captureMoves = moves.filter(m => {
    const target = gameState.board[m.to.y][m.to.x];
    return !!target || m.enPassant;
  });
  const useCapture = captureMoves.length > 0 && Math.random() < 0.6;
  let pool = useCapture ? captureMoves : moves;

  if (forceDifferent && lastAiMoveKey && pool.length > 1) {
    pool = pool.filter(m => `${m.from.x}${m.from.y}${m.to.x}${m.to.y}` !== lastAiMoveKey);
    if (pool.length === 0) pool = useCapture ? captureMoves : moves;
  }

  const choice = pool[Math.floor(Math.random() * pool.length)];
  lastAiMoveKey = `${choice.from.x}${choice.from.y}${choice.to.x}${choice.to.y}`;
  lastAiState = cloneState(gameState);
  applyMoveLocal({ from: choice.from, to: choice.to });
  endLocalTurn();
}

function updateAiControls() {
  if (!aiRerollBtn) return;
  const enabled = localMode && aiEnabled && gameState && gameState.running && !gameState.gameOver && !!lastAiState;
  aiRerollBtn.disabled = !enabled;
}

function updateActionButtons() {
  if (!gameState) return;
  const inGame = gameState.running && !gameState.gameOver;
  const isPlayer = localMode || playerColor === 'w' || playerColor === 'b';
  const myColor = localMode ? localView : playerColor;
  const drawOfferedBy = gameState.drawOfferedBy;

  if (resignBtn) resignBtn.disabled = !inGame || !isPlayer;
  if (offerDrawBtn) {
    offerDrawBtn.disabled = !inGame || !isPlayer || !!drawOfferedBy;
    // Highlight the button if current player offered a draw
    if (drawOfferedBy === myColor) {
      offerDrawBtn.classList.add('draw-offered');
    } else {
      offerDrawBtn.classList.remove('draw-offered');
    }
  }
  const canRespond = drawOfferedBy && drawOfferedBy !== myColor;
  if (acceptDrawBtn) acceptDrawBtn.disabled = !inGame || !isPlayer || !canRespond;
  if (declineDrawBtn) declineDrawBtn.disabled = !inGame || !isPlayer || !canRespond;
}

function updateMoveList() {
  if (!moveListEl || !gameState) return;
  moveListEl.innerHTML = '';
  const moves = gameState.moves || [];
  moves.forEach((m, i) => {
    const li = document.createElement('li');
    li.textContent = m;
    if (i === moves.length - 1) li.classList.add('latest');
    moveListEl.appendChild(li);
  });
}

function isInside(x, y) {
  return x >= 0 && x < 8 && y >= 0 && y < 8;
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

function updateModeUI() {
  const online = modeSelect.value === 'online';
  serverInput.disabled = !online;
  roomInput.disabled = !online;
  createBtn.disabled = !online;
  joinBtn.disabled = !online;
  localStartBtn.disabled = online;
  opponentSelect.disabled = online;
  puzzleSelect.disabled = online;
  puzzleStartBtn.disabled = online;
  if (aiRerollBtn) aiRerollBtn.disabled = true;
  setStatus(online ? 'Disconnected' : 'Offline');
}


function applyClockSettings() {
  const minutes = Math.max(1, parseInt(clockMinInput.value, 10) || 5);
  const increment = Math.max(0, parseInt(clockIncInput.value, 10) || 0);
  clockMinInput.value = minutes;
  clockIncInput.value = increment;
  const baseMs = minutes * 60 * 1000;
  const incMs = increment * 1000;

  if (localMode) {
    if (gameState && (gameState.running || gameState.playersReady.w || gameState.playersReady.b)) {
      log('Clock settings can only be changed before the game starts.');
      return;
    }
    localClockBaseMs = baseMs;
    localClockIncrementMs = incMs;
    if (gameState) {
      gameState.clocks = { w: baseMs, b: baseMs };
      render();
    }
    log(`Clock set to ${minutes}+${increment}.`);
  } else {
    send({ type: 'set_clock', minutes, increment });
    log(`Requested clock ${minutes}+${increment} for this room.`);
  }
}

createBtn.addEventListener('click', () => {
  roomInput.value = randomRoom();
  connect();
});

joinBtn.addEventListener('click', () => connect());
localStartBtn.addEventListener('click', () => startLocalGame());
clockApplyBtn.addEventListener('click', () => applyClockSettings());

modeSelect.addEventListener('change', () => updateModeUI());

serverInput.value = localStorage.getItem('server') || getDefaultServer();
nameInput.value = localStorage.getItem('name') || '';
flipBoardSelect.value = localStorage.getItem('flipBoard') || 'off';
flipBoardForBlack = flipBoardSelect.value === 'on';
opponentSelect.value = localStorage.getItem('opponent') || 'human';
aiEnabled = opponentSelect.value === 'ai';

serverInput.addEventListener('change', () => localStorage.setItem('server', serverInput.value));
nameInput.addEventListener('change', () => localStorage.setItem('name', nameInput.value));
flipBoardSelect.addEventListener('change', () => {
  localStorage.setItem('flipBoard', flipBoardSelect.value);
  flipBoardForBlack = flipBoardSelect.value === 'on';
  renderBoard();
});

opponentSelect.addEventListener('change', () => {
  localStorage.setItem('opponent', opponentSelect.value);
  aiEnabled = opponentSelect.value === 'ai';
});

aiRerollBtn.addEventListener('click', () => {
  if (aiPendingTimeout) {
    clearTimeout(aiPendingTimeout);
    aiPendingTimeout = null;
  }
  if (lastAiState) {
    gameState = cloneState(lastAiState);
    lastAiState = null;
    render();
    executeAiMove(true);
  } else {
    executeAiMove(true);
  }
});

resignBtn.addEventListener('click', () => {
  if (!gameState || gameState.gameOver) return;
  if (localMode) {
    gameState.gameOver = true;
    gameState.running = false;
    gameState.winner = gameState.turn === 'w' ? 'b' : 'w';
    gameState.reason = 'resign';
    render();
    return;
  }
  send({ type: 'resign' });
});

offerDrawBtn.addEventListener('click', () => {
  if (!gameState || gameState.gameOver) return;
  if (localMode) {
    gameState.drawOfferedBy = gameState.turn;
    log(`${gameState.turn === 'w' ? 'White' : 'Black'} offered a draw.`);
    // Switch view to the other player so they can respond
    localView = gameState.turn === 'w' ? 'b' : 'w';
    render();
    return;
  }
  send({ type: 'offer_draw' });
  // Immediately update UI to show draw was offered
  if (gameState) {
    gameState.drawOfferedBy = playerColor;
    render();
  }
});

acceptDrawBtn.addEventListener('click', () => {
  if (!gameState || gameState.gameOver) return;
  if (localMode) {
    if (gameState.drawOfferedBy && gameState.drawOfferedBy !== gameState.turn) {
      gameState.gameOver = true;
      gameState.running = false;
      gameState.winner = null;
      gameState.reason = 'draw';
      gameState.drawOfferedBy = null;
      render();
    }
    return;
  }
  send({ type: 'accept_draw' });
});

declineDrawBtn.addEventListener('click', () => {
  if (!gameState || gameState.gameOver) return;
  if (localMode) {
    if (gameState.drawOfferedBy && gameState.drawOfferedBy !== gameState.turn) {
      gameState.drawOfferedBy = null;
      log('Draw declined.');
      // Switch view back to the current turn player
      localView = gameState.turn;
      render();
    }
    return;
  }
  send({ type: 'decline_draw' });
});

puzzleStartBtn.addEventListener('click', () => {
  const key = puzzleSelect.value;
  if (!key) return;
  startPuzzle(key);
});

function startPuzzle(key) {
  localMode = true;
  puzzleMode = true;
  aiEnabled = true;
  playerColor = 'w';
  localView = 'w';
  localOverlayLocked = false;
  lastGameOver = false;
  myFlagId = null;
  lastAiMoveKey = null;
  lastAiState = null;
  applyClockSettings();
  gameState = createEmptyState();

  const puzzle = getPuzzle(key);
  if (!puzzle) return;
  puzzlePlayerColor = puzzle.playerColor;
  setupPuzzlePosition(puzzle);

  gameState.running = true;
  gameState.turn = puzzle.toMove;
  gameState.lastTick = Date.now();
  render();
  setStatus('Puzzle');
  log(`Puzzle started: ${puzzle.name}`);
  if (gameState.turn === aiColor) maybeAiMove();
}

function createEmptyState() {
  return {
    board: Array.from({ length: 8 }, () => Array(8).fill(null)),
    pieces: new Map(),
    turn: 'w',
    enPassant: null,
    clocks: { w: localClockBaseMs, b: localClockBaseMs },
    lastTick: Date.now(),
    running: false,
    gameOver: false,
    winner: null,
    reason: null,
    flags: { w: null, b: null },
    playersReady: { w: true, b: true },
    lastMove: null,
    moves: [],
    drawOfferedBy: null
  };
}

function setupPuzzlePosition(puzzle) {
  puzzle.white.forEach(p => addPiece(gameState, p.type, 'w', p.x, p.y));
  puzzle.black.forEach(p => addPiece(gameState, p.type, 'b', p.x, p.y));

  setRandomFlag('w');
  setRandomFlag('b');
}

function setRandomFlag(color) {
  const pawns = [];
  for (const [id, piece] of gameState.pieces.entries()) {
    if (piece.color === color && piece.type === 'P') pawns.push(id);
  }
  if (pawns.length === 0) return;
  const flagId = pawns[Math.floor(Math.random() * pawns.length)];
  const flagPiece = gameState.pieces.get(flagId);
  flagPiece.isFlag = true;
  gameState.flags[color] = flagId;
}

function getPuzzle(key) {
  const puzzles = {
    p1: {
      name: 'Ra1/a5 vs Ra8/a7 (White to move)',
      toMove: 'w',
      playerColor: 'w',
      white: [
        algebraicPiece('R', 'a1'),
        algebraicPiece('P', 'a5')
      ],
      black: [
        algebraicPiece('R', 'a8'),
        algebraicPiece('P', 'a7')
      ]
    },
    p2: {
      name: 'White e2 vs Black d7 (White to move)',
      toMove: 'w',
      playerColor: 'w',
      white: [
        algebraicPiece('P', 'e2')
      ],
      black: [
        algebraicPiece('P', 'd7')
      ]
    },
    p3: {
      name: 'White e2,d2 vs Black d7,e7 (Black to move)',
      toMove: 'b',
      playerColor: 'w',
      white: [
        algebraicPiece('P', 'e2'),
        algebraicPiece('P', 'd2')
      ],
      black: [
        algebraicPiece('P', 'd7'),
        algebraicPiece('P', 'e7')
      ]
    },
    p4: {
      name: 'White c2,d2,e2 vs Black c7,d7,e7 (White to move)',
      toMove: 'w',
      playerColor: 'w',
      white: [
        algebraicPiece('P', 'c2'),
        algebraicPiece('P', 'd2'),
        algebraicPiece('P', 'e2')
      ],
      black: [
        algebraicPiece('P', 'c7'),
        algebraicPiece('P', 'd7'),
        algebraicPiece('P', 'e7')
      ]
    }
  };
  return puzzles[key];
}

function algebraicPiece(type, square) {
  const x = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10);
  const y = 8 - rank;
  return { type, x, y };
}

function cloneState(state) {
  const board = state.board.map(row => row.slice());
  const pieces = new Map();
  for (const [id, piece] of state.pieces.entries()) {
    pieces.set(id, { ...piece });
  }
  return {
    board,
    pieces,
    turn: state.turn,
    enPassant: state.enPassant ? { ...state.enPassant } : null,
    clocks: { ...state.clocks },
    lastTick: state.lastTick,
    running: state.running,
    gameOver: state.gameOver,
    winner: state.winner,
    reason: state.reason,
    flags: { ...state.flags },
    playersReady: { ...state.playersReady },
    lastMove: state.lastMove ? { from: { ...state.lastMove.from }, to: { ...state.lastMove.to } } : null,
    moves: state.moves ? state.moves.slice() : []
  };
}

clockMinInput.value = localStorage.getItem('clockMinutes') || '5';
clockIncInput.value = localStorage.getItem('clockIncrement') || '0';
clockMinInput.addEventListener('change', () => {
  localStorage.setItem('clockMinutes', clockMinInput.value);
  applyClockSettings();
});
clockIncInput.addEventListener('change', () => {
  localStorage.setItem('clockIncrement', clockIncInput.value);
  applyClockSettings();
});

updateModeUI();
