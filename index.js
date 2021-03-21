const express = require('express');
const cors = require('cors');
const jwt = require('jwt');

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
const io = require('socket.io')(server);


const rooms = {};



app.post('/submit', cors(), (req, res) => {
    // TODO: verify jwt
    console.log(req.body.channel);
    console.log(req.body.userId);
    console.log(req.body.latLng);

    const { channel, userId, latLng } = req.body;

    const room = rooms[channel];
    if (!room) {
        return res.status(404).send({
            message: 'Streamer not active',
        });
    }

    if (!room.roundActive) {
        return res.status(400).send({
            message: 'Round not active',
        })
    }

    if (room.voters.has(userId)) {
        return res.status(400).send({
            message: 'Already voted this round',
        });
    }
    
    room.voters.add(userId);

    const cartesian = latLngToCartesian(latLng);
    room.averageCartesian = [
        room.averageCartesian[0] + cartesian[0],
        room.averageCartesian[1] + cartesian[1],
        room.averageCartesian[2] + cartesian[2],
    ];

    room.socket.emit('vote', {count: room.voters.size(), average: cartesianToLatLng(room.averageCartesian)});
});



io.on('connection', socket => {
  socket.on('live', (data) => {
    // TODO: verify jwt
    const channel = data.channel;
    socket.channelId = channel;
    rooms[channel] = {
        voters: new Set(),
        averageCartesian = [0, 0, 0],
        roundActive: false,
        socket,
    };
    // TODO: twitch pubsub activate extension
  });

  socket.on('start round', () => {
    const room = rooms[socket.channelId];
    room.roundActive = true;
    room.voters = new Set();
    room.averageCartesian = [0, 0, 0];
    // TODO: twitch pubsub start round
  });

  socket.on('stop round', () => {
    const room = rooms[socket.channelId];
    room.roundActive = false;
    //TODO: twitch pubsub stop round
  });

  socket.on('disconnect', () => {
    delete rooms[socket.channelId];
    // TODO: twitch pubsub stop extension
  });
});







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
    const sinLat = Math.sin(latRad);
    return [
        sinLat * Math.cos(lngRad),
        sinLat * Math.sin(lngRad),
        Math.cos(latRad),
    ];
}

function cartesianToLatLng([x, y, z]) {
    const lat = RAD2DEG * Math.atan2(z, Math.sqrt(x * x + y * y));
    const lng = RAD2DEG * Math.atan2(-y, x);
    return [lat, lng];
}
