const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello from App Engine!');
});

app.options('*', cors());

// Listen to the App Engine-specified port, or 8000 otherwise
const PORT = process.env.PORT || 8000;
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}...`);
});
const io = require('socket.io')(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const TWITCH_SECRET = Buffer.from(process.env.twitch, 'base64');

const REQUEST_STATE = {
  SUCCESS: 'SUCCESS',
  FAILED_UNKNOWN: 'FAILED_UNKNOWN',
  FAILED_AUTH: 'FAILED_AUTH',
  FAILED_STREAMER_NOT_ACTIVE: 'FAILED_STREAMER_NOT_ACTIVE',
  FAILED_ROUND_NOT_ACTIVE: 'FAILED_ROUND_NOT_ACTIVE',
  FAILED_ALREADY_VOTED: 'FAILED_ALREADY_VOTED',
}

const PUBSUB_EVENTS = {
  ACTIVATE: 'ACTIVATE',
  DEACTIVATE: 'DEACTIVATE',
  START: 'START',
  STOP: 'STOP',
}

// Look, we both know that this should really be stored in redis or memcached
// or something and not just as an object in memory, but if I had the money to
// pay for those servers, I would also have the time to make this code not shit
const rooms = {};

function verifyJwt(req, res, next) {
  const token = req.header('Authorization')?.split(' ')[1] ?? '';
  token && jwt.verify(token, TWITCH_SECRET, (err, decoded) => {
    if (err) {
      console.error(err);
      return res.status(403).send({ message: REQUEST_STATE.FAILED_AUTH });
    }

    req.decodedJwt = decoded;
    next();
  });
}

app.get('/state', cors(), verifyJwt, (req, res) => {
  const channel = req.decodedJwt.channel_id;
  const room = rooms[channel];

  const state = {
    channelActive: false,
    roundActive: false,
  }

  if (room) {
    state.channelActive = true;
    if (room.roundActive) {
      state.roundActive = true;
    }
  }

  return res.send(state);
});

app.post('/submit', cors(), verifyJwt, (req, res) => {

  const userId = req.decodedJwt.opaque_user_id;
  const channel = req.decodedJwt.channel_id;
  const { latLng } = req.body;

  const room = rooms[channel];
  if (!room) {
    return res.status(404).send({
      message: REQUEST_STATE.FAILED_STREAMER_NOT_ACTIVE,
    });
  }

  if (!room.roundActive) {
    return res.status(400).send({
      message: REQUEST_STATE.FAILED_ROUND_NOT_ACTIVE,
    })
  }

  if (room.voters.has(userId)) {
    return res.status(400).send({
      message: REQUEST_STATE.FAILED_ALREADY_VOTED,
    });
  }

  room.voters.add(userId);

  const cartesian = latLngToCartesian([latLng.lat, latLng.lng]);
  room.averageCartesian = [
    room.averageCartesian[0] + cartesian[0],
    room.averageCartesian[1] + cartesian[1],
    room.averageCartesian[2] + cartesian[2],
  ];

  console.log(`vote ${latLng.lat} ${latLng.lng}, new avg cartesian: ${normalize(room.averageCartesian)}, in latLng: ${cartesianToLatLng(normalize(room.averageCartesian))}`);

  room.socket.emit('vote', { count: room.voters.size, average: cartesianToLatLng(normalize(room.averageCartesian)) });

  res.send({ message: REQUEST_STATE.SUCCESS });
});

io.on('connection', socket => {
  socket.on('live', (data) => {
    jwt.verify(data.token, TWITCH_SECRET, (err, decoded) => {
      if (!err) {
        const channel = decoded.channel_id;
        socket.channelId = channel;
        rooms[channel] = {
          voters: new Set(),
          averageCartesian: [0, 0, 0],
          roundActive: false,
          socket,
        };
        console.log(`creating new room ${channel}`);
        pubsubSend(socket.channelId, PUBSUB_EVENTS.ACTIVATE);
      }
    });
  });

  socket.on('start round', (data) => {
    jwt.verify(data.token, TWITCH_SECRET, (err, decoded) => {
      if (!err) {
        const room = rooms[socket.channelId];
        room.roundActive = true;
        room.voters = new Set();
        room.averageCartesian = [0, 0, 0];
        console.log(`starting round on ${socket.channelId}`);
        pubsubSend(socket.channelId, PUBSUB_EVENTS.START);
      }
    });
  });

  socket.on('stop round', (data) => {
    jwt.verify(data.token, TWITCH_SECRET, (err, decoded) => {
      if (!err) {
        const room = rooms[socket.channelId];
        room.roundActive = false;
        console.log(`stopping round on ${socket.channelId}`);
        pubsubSend(socket.channelId, PUBSUB_EVENTS.STOP);
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('destroying room');
    delete rooms[socket.channelId];
    pubsubSend(socket.channelId, PUBSUB_EVENTS.DEACTIVATE);
  });
});


function pubsubSend(channelId, message) {
  const endpoint = `https://api.twitch.tv/extensions/message/${channelId}`;
  const tokenPayload = {
    exp: Math.floor(new Date().getTime() / 1000) + 10, // set expiry to now + 10 seconds
    user_id: '484799325', // @dewdropawoo user_id
    role: 'external',
    channel_id: channelId,
    pubsub_perms: {
      send: [
        'broadcast',
      ]
    }
  };
  const pubsubPayload = JSON.stringify({
    message,
    targets: ['broadcast'],
    content_type: 'application/json',
  });

  jwt.sign(tokenPayload, TWITCH_SECRET, (err, token) => {
    // TODO: error handling
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Client-Id': '6thshg5adqdk7uwsr2nee2gqck250w',
      },
      body: pubsubPayload
    })
      .then(response => { })
      .catch(error => console.error(error));
    // TODO: handling of any sort
  });
}




const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// https://gis.stackexchange.com/a/7566
function calculateAverageLatLng(latLngs) {
  const sumCartesian = latLngs.reduce(([xAcc, yAcc, zAcc], latLng) => {
    const [x, y, z] = latLngToCartesian(latLng);
    return [xAcc + x, yAcc + y, zAcc + z];
  }, [0, 0, 0]);

  return cartesianToLatLng(sumCartesian);
}

function latLngToCartesian([lat, lng]) {
  const latRad = DEG2RAD * lat;
  const lngRad = DEG2RAD * lng;
  return [
    Math.cos(latRad) * Math.cos(lngRad),
    Math.cos(latRad) * Math.sin(lngRad),
    Math.sin(latRad),
  ];
}

function cartesianToLatLng([x, y, z]) {
  const lat = RAD2DEG * Math.asin(z);
  const lng = RAD2DEG * Math.atan2(y, x);
  return [lat, lng];
}

function normalize([x, y, z]) {
  const magnitude = Math.sqrt(x * x + y * y + z * z);
  return magnitude > 0 ? [x / magnitude, y / magnitude, z / magnitude] : [x, y, z];
}