# Stratego Chess Online

Play Stratego Chess online: standard chess pieces, but you win by capturing a hidden flag pawn. No check rules, no castling. En passant is allowed.

## Local Run

1. Start the server:

```bash
cd server
npm install
npm start
```

2. Serve the client (any static server is fine). Example:

```bash
cd public
python3 -m http.server 8000
```

3. Open the client at `http://localhost:8000` and set the server URL to `ws://localhost:8787`.

## Deploy

- Frontend: GitHub Pages via `.github/workflows/pages.yml`.
- Backend: Render (or similar) running `npm start` in the `server` folder.

After deploying the backend, set the client `Server URL` to the `wss://...` URL.

## Notes

- Pawn promotion auto-queens.
- If a player has no legal moves, they lose.
- Draw rules (50-move, repetition) are not implemented in this MVP.
