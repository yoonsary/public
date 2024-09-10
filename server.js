const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let teams = Array(8).fill(null);
let occupiedUsers = new Set();

let currentHighestBid = 0;
let currentHighestBidder = null;
let auctionEndTime = null;
let auctionTimer = null;
let currentIndex = 0;
let names = [];
let nameGridState = Array(16).fill(null);  // nameGrid 슬롯 상태 저장 (16칸)
let failedNameGridState = Array(32).fill(null);  // failedNameGrid 슬롯 상태 저장 (16칸)
let failedParticipants = [];
let leaderPoints = [
  1500, // 팀 1 포인트
  1500, // 팀 2 포인트
  1500, // 팀 3 포인트
  1500, // 팀 4 포인트
  1500, // 팀 5 포인트
  1500, // 팀 6 포인트
  1500, // 팀 7 포인트
  1500  // 팀 8 포인트
];

app.use(express.static('public'));

app.get('/get-names', (req, res) => {
  res.json({ names });
});

app.get('/get-teams', (req, res) => {
  res.json({ teams });
});

app.post('/save-names', express.json(), (req, res) => {
  names = req.body.names;
  currentIndex = 0;
  io.emit('nameListUpdated', names);
  res.json({ message: '이름 목록이 저장되었습니다.' });
});

// 슬롯 상태를 반환하는 API
app.get('/get-grid-states', (req, res) => {
  res.json({
    nameGridState,
    failedNameGridState
  });
});

app.get('/get-failed-participants', (req, res) => {
  res.json({ failedParticipants });
});

app.post('/move-to-failed', express.json(), (req, res) => {
  const { failedName } = req.body;
  if (!failedParticipants.includes(failedName)) {
    failedParticipants.push(failedName);
    io.emit('updateFailedParticipants', failedParticipants);
  }
  res.json({ message: '참가자가 유찰자로 이동했습니다.' });
});

io.on('connection', (socket) => {
  console.log('사용자 연결됨');

  socket.on('selectSlot', ({ name, slot }) => {
    if (occupiedUsers.has(name)) {
      socket.emit('alreadyJoined');
    } else if (teams[slot] === null) {
      teams[slot] = name;
      occupiedUsers.add(name);
      io.emit('updateTeams', teams);
      socket.emit('nameLocked');
    } else {
      socket.emit('slotTaken');
    }
  });

  socket.on('nextName', () => {
    currentIndex = (currentIndex + 1) % names.length;
    const currentName = names[currentIndex];
    io.emit('updateName', { currentName, currentIndex });
  });

  socket.on('prevName', () => {
    currentIndex = (currentIndex - 1 + names.length) % names.length;
    const currentName = names[currentIndex];
    io.emit('updateName', { currentName, currentIndex });
  });

  socket.on('moveToFailed', ({ selectedName, failedSlot }) => {
    if (selectedName) {
      const nameIndex = names.indexOf(selectedName);
      if (nameIndex !== -1) {
        names[nameIndex] = '';
      }
      io.emit('updateFailedList', { selectedName, failedSlot });
      io.emit('removeFromParticipants', { selectedName });
    }
  });

  socket.on('bid', ({ name, bid, slotSelected }) => {
    if (!slotSelected) {
      socket.emit('slotNotSelected');
      return;
    }
  
    const slotIndex = teams.findIndex(team => team === name);
    const availablePoints = leaderPoints[slotIndex];
  
    // 입찰 금액이 현재 사용 가능한 포인트보다 많으면 입찰 금지
    if (bid > availablePoints) {
      socket.emit('bidTooHigh', { availablePoints });
      return;
    }
  
    // 새로운 최고 입찰인지 확인
    if (bid > currentHighestBid) {
      currentHighestBid = bid;
      currentHighestBidder = name;
  
      auctionEndTime = Date.now() + 15000; // 15초 경매 시간 설정
  
      if (auctionTimer) {
        clearTimeout(auctionTimer); // 이전 타이머 취소
      }
  
      auctionTimer = setTimeout(() => {
        // 시간이 만료되면 낙찰 처리
        if (currentHighestBidder === name) {
          const bidPoints = currentHighestBid; // 입찰 금액 저장
          leaderPoints[slotIndex] -= bidPoints; // 포인트 차감
          io.emit('auctionWon', { name: currentHighestBidder, bid: bidPoints });
          io.emit('updatePoints', { slotIndex, newPoints: leaderPoints[slotIndex] }); // 실시간으로 남은 포인트 업데이트
          resetAuction(); // 경매 초기화
        }
      }, 15000);
  
      io.emit('newBid', {
        name: currentHighestBidder,
        bid: currentHighestBid,
        timeLeft: 15
      });
    }
  });  
  
  socket.on('startAuction', () => {
    resetAuction();
    io.emit('auctionStarted');
  });

  function resetAuction() {
    currentHighestBid = 0;
    currentHighestBidder = null;
    auctionEndTime = null;
    auctionTimer = null;
  }
  
  // 이름 옮기기 이벤트 처리
  socket.on('moveName', ({ name, fromSlotId, toSlotId }) => {
    const fromSlotIndex = parseInt(fromSlotId.split('-').pop()) - 1;
    const toSlotIndex = parseInt(toSlotId.split('-').pop()) - 1;

    // 원래 있던 슬롯의 이름을 null로 초기화 (삭제)
    if (fromSlotId.startsWith('name-slot')) {
        nameGridState[fromSlotIndex] = null;
    } else if (fromSlotId.startsWith('failed-name-slot')) {
        failedNameGridState[fromSlotIndex] = null;
    }

    // 이동할 슬롯에 이름을 설정
    if (toSlotId.startsWith('name-slot')) {
        nameGridState[toSlotIndex] = name;
    } else if (toSlotId.startsWith('failed-name-slot')) {
        failedNameGridState[toSlotIndex] = name;
    }

    // 모든 클라이언트에게 업데이트된 상태 전송
    io.emit('nameMoved', { name, fromSlotId, toSlotId });
  
    // 서버 상태를 저장하여 새로고침 시에도 반영
    saveGridStates();
  });

  // 그리드 상태를 저장하는 함수
  function saveGridStates() {
    app.post('/save-grid-states', (req, res) => {
        nameGridState = req.body.nameGridState;
        failedNameGridState = req.body.failedNameGridState;
        res.json({ message: '슬롯 상태가 저장되었습니다.' });
    });
  }


  socket.on('disconnect', () => {
    console.log('사용자 연결 해제');
  });
});

server.listen(3000, () => {
  console.log('서버가 3000 포트에서 실행 중입니다.');
});