const express = require('express');

const http = require('http');

const { Server } = require('socket.io');

const path = require('path');

const fs = require('fs');

const app = express();

const server = http.createServer(app);

const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

function loadQuestions() {

  const data = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');

  return JSON.parse(data);

}

let DECKS = loadQuestions();

let gameState = {

  phase: 'LOBBY',

  deck: 'day1',

  stage1Index: 0,

  stage2Index: 0,

  stage3Index: 0,

  players: {},

  clusters: [],

  finalists: []

};

function normalize(str) {

  return (str || '')

    .toLowerCase()

    .trim()

    .replace(/[^\w\s]/gi, '')

    .replace(/^(the|a|an)\s+/i, '');

}

function similarity(s1, s2) {

  let longer = s1.length < s2.length ? s2 : s1;

  let shorter = s1.length < s2.length ? s1 : s2;

  if (longer.length === 0) return 1.0;

  let costs = [];

  for (let i = 0; i <= longer.length; i++) {

    let lastValue = i;

    for (let j = 0; j <= shorter.length; j++) {

      if (i === 0) costs[j] = j;

      else if (j > 0) {

        let newValue = costs[j - 1];

        if (longer.charAt(i - 1) !== shorter.charAt(j - 1)) {

          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;

        }

        costs[j - 1] = lastValue;

        lastValue = newValue;

      }

    }

    if (i > 0) costs[shorter.length] = lastValue;

  }

  return (longer.length - costs[shorter.length]) / parseFloat(longer.length);

}

io.on('connection', (socket) => {

  socket.on('player_join', ({ playerId, name }) => {

    if (!playerId) return;

    socket.playerId = playerId;

    if (!gameState.players[playerId]) {

      gameState.players[playerId] = {

        id: playerId,

        name: (name || 'Guest').slice(0, 20),

        score: 0,

        locked: false,

        currentAnswer: null,

        lastPoints: 0,

        lastBreakdown: ''

      };

    } else if (name && name.trim()) {

      gameState.players[playerId].name = name.slice(0, 20);

    }

    io.emit('state_sync', gameState);

  });

  socket.on('host_action', ({ action, payload }) => {

    DECKS = loadQuestions();

    if (action === 'SET_DECK') {

      gameState.deck = payload.deck;

      gameState.stage1Index = 0;

      gameState.stage2Index = 0;

      gameState.stage3Index = 0;

    }

    else if (action === 'START_LOBBY') {

      gameState.phase = 'LOBBY';

      gameState.stage1Index = 0;

      gameState.stage2Index = 0;

      gameState.stage3Index = 0;

      gameState.clusters = [];

      gameState.finalists = [];

      Object.values(gameState.players).forEach(p => {

        p.score = 0;

        p.locked = false;

        p.currentAnswer = null;

        p.lastPoints = 0;

        p.lastBreakdown = '';

      });

    }

    else if (action === 'SET_STAGE_1_QUESTION') {

      gameState.stage1Index = payload.index;

      gameState.phase = 'STAGE_1';

      Object.values(gameState.players).forEach(p => {

        p.locked = false;

        p.currentAnswer = null;

        p.lastPoints = 0;

        p.lastBreakdown = '';

      });

    }

    else if (action === 'REVEAL_STAGE_1') {

      if (gameState.phase !== 'STAGE_1') return;

      const q = DECKS[gameState.deck].stage1[gameState.stage1Index];

      Object.values(gameState.players).forEach(player => {

        let earned = 0;

        let exact = 0;

        let close = 0;

        if (Array.isArray(player.currentAnswer)) {

          player.currentAnswer.forEach((itemId, idx) => {

            const correctIdx = q.correctOrder.indexOf(itemId);

            if (correctIdx === idx) {

              earned += 20;

              exact++;

            } else if (Math.abs(correctIdx - idx) === 1) {

              earned += 10;

              close++;

            }

          });

          player.lastBreakdown = `${exact} exact spot${exact === 1 ? '' : 's'} (+${exact * 20}), ${close} off-by-one (+${close * 10})`;

        } else {

          player.lastBreakdown = 'No ranking locked in before the reveal.';

        }

        player.score += earned;

        player.lastPoints = earned;

      });

      gameState.phase = 'STAGE_1_REVEAL';

    }

    else if (action === 'SET_STAGE_2_QUESTION') {

      gameState.stage2Index = payload.index;

      gameState.phase = 'STAGE_2';

      gameState.clusters = [];

      Object.values(gameState.players).forEach(p => {

        p.locked = false;

        p.currentAnswer = null;

        p.lastPoints = 0;

        p.lastBreakdown = '';

      });

    }

    else if (action === 'CALCULATE_STAGE_2') {

      if (gameState.phase !== 'STAGE_2') return;

      const clusters = [];

      Object.values(gameState.players).forEach(p => {

        p.lastPoints = 0;

        if (!p.currentAnswer || typeof p.currentAnswer !== 'string') {

          p.lastBreakdown = 'No answer submitted before the reveal.';

          return;

        }

        p.lastBreakdown = `Your answer "${p.currentAnswer}" didn't make the Top 5 board.`;

        const clean = normalize(p.currentAnswer);

        let match = clusters.find(c =>

          similarity(c.text, clean) > 0.8 ||

          (clean.length > 2 && c.text.includes(clean)) ||

          (c.text.length > 2 && clean.includes(c.text))

        );

        if (match) {

          match.count++;

          match.players.push(p);

        } else {

          clusters.push({ text: clean, display: p.currentAnswer, count: 1, players: [p] });

        }

      });

      clusters.sort((a, b) => b.count - a.count);

      const top5 = clusters.slice(0, 5);

      top5.forEach((c, rankIdx) => {

        const pts = c.count * 10;

        const others = c.count - 1;

        c.players.forEach(p => {

          p.score += pts;

          p.lastPoints = pts;

          p.lastBreakdown = others > 0

            ? `#${rankIdx + 1} on the board! Matched "${c.display}" with ${others} colleague${others === 1 ? '' : 's'}.`

            : `#${rankIdx + 1} on the board! ("${c.display}")`;

        });

      });

      gameState.clusters = top5;

      gameState.phase = 'STAGE_2_REVEAL';

    }

    else if (action === 'SET_STAGE_3_QUESTION') {

      gameState.stage3Index = payload.index;

      if (gameState.finalists.length === 0) {

        const sorted = Object.entries(gameState.players).sort((a, b) => b[1].score - a[1].score);

        gameState.finalists = sorted.slice(0, 5).map(([id, p]) => ({ id, name: p.name, score: p.score, votes: 0 }));

      }

      gameState.phase = 'STAGE_3';

      Object.values(gameState.players).forEach(p => { p.locked = false; });

    }

    else if (action === 'SHOW_PODIUM') {

      gameState.phase = 'PODIUM';

    }

    io.emit('state_sync', gameState);

  });

  socket.on('submit_answer', (answer) => {

    const pId = socket.playerId;

    if (pId && gameState.players[pId]) {

      gameState.players[pId].currentAnswer = answer;

      gameState.players[pId].locked = true;

      io.emit('state_sync', gameState);

    }

  });

  socket.on('vote_finalist', (finalistId) => {

    const pId = socket.playerId;

    if (!pId || !gameState.players[pId]) return;

    if (!gameState.players[pId].locked) {

      const f = gameState.finalists.find(x => x.id === finalistId);

      if (f) {

        f.votes = (f.votes || 0) + 1;

        if (gameState.players[finalistId]) {

          gameState.players[finalistId].score += 25;

        }

        gameState.players[pId].locked = true;

        io.emit('state_sync', gameState);

      }

    }

  });

  socket.on('disconnect', () => {});

});

app.get('/api/questions', (req, res) => {

  res.json(loadQuestions());

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
 
